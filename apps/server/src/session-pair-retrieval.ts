import type {
	SessionContextGraphResponse,
	SessionContextNode,
} from "@omp-deck/protocol";

import { tokenize } from "./session-topology-retrieval.ts";

export interface PairRetrievalInput {
	sessionId: string;
	query: string;
	candidateMainLimit: number;
	outputNodeLimit: number;
	outputEdgeLimit: number;
	outputArtifactLimit: number;
	maxChildrenPerAssistant?: number;
	maxChildrenPerType?: number;
}

export interface PairRetrievalResult {
	selectedPairIds: string[];
	selectedNodeIds: string[];
	selectedChildIds: string[];
	selectedEdgeIds: string[];
	artifacts: Array<{ kind: string; ref: string; nodeId?: string; label: string }>;
	eligibleCounts: { userMain: number; assistantMain: number; children: number };
	candidateCounts: { userMain: number; assistantMain: number; children: number };
	omitted: { pairs: number; children: number; reason: string };
	ranking: Array<{ unitId: string; score: number; nodeIds: string[] }>;
}

type MainPopulation = "user" | "assistant";
type ChildIntent = "test" | "task_state" | "subagent_result" | "error";
type SearchField = "purposePrimary" | "purposeFallback" | "operationDetail" | "operation" | "titleCompressed" | "body" | "childType";

interface SearchableNode {
	node: SessionContextNode;
	fieldTokens: Record<SearchField, Set<string>>;
	lexicalScore: number;
	score: number;
}

interface PairUnit {
	pairId: string;
	user?: SearchableNode;
	assistant?: SearchableNode;
	hasAnswersEdge: boolean;
	forcedChildren: SearchableNode[];
	score: number;
}

const MAIN_FIELD_WEIGHTS: Record<SearchField, number> = {
	purposePrimary: 0.35,
	purposeFallback: 0.32,
	operationDetail: 0.20,
	operation: 0.15,
	titleCompressed: 0.20,
	body: 0.10,
	childType: 0,
};

const CHILD_FIELD_WEIGHTS: Record<SearchField, number> = {
	purposePrimary: 0.30,
	purposeFallback: 0.27,
	operationDetail: 0.18,
	operation: 0.12,
	titleCompressed: 0.12,
	body: 0.08,
	childType: 0.20,
};

const CHILD_INTENT_TOKENS: Record<ChildIntent, ReadonlySet<string>> = {
	test: new Set(["test", "tests", "verify", "verification", "build", "测试", "验证", "构建"]),
	task_state: new Set(["task", "todo", "任务", "待办"]),
	subagent_result: new Set(["subagent", "agent", "scout", "reviewer", "子代理", "代理"]),
	error: new Set(["error", "failed", "failure", "blocked", "abort", "错误", "失败", "阻塞", "中止"]),
};

const CHILD_TYPE_TEXT: Record<NonNullable<SessionContextNode["childType"]>, string> = {
	test: [...CHILD_INTENT_TOKENS.test].join(" "),
	task_state: [...CHILD_INTENT_TOKENS.task_state].join(" "),
	subagent_result: [...CHILD_INTENT_TOKENS.subagent_result].join(" "),
	error: [...CHILD_INTENT_TOKENS.error].join(" "),
	tool_evidence: "tool evidence result output",
};

const KIND_PRIOR: Partial<Record<SessionContextNode["kind"], number>> = {
	resolution: 1,
	decision: 0.9,
	goal: 0.85,
	user_intent: 0.82,
	constraint: 0.8,
	evidence: 0.75,
	action: 0.7,
	issue: 0.65,
	todo_state: 0.6,
	artifact: 0.5,
	handoff_summary: 0.5,
};

function clamp01(value: number | null | undefined): number {
	if (value === null || value === undefined || !Number.isFinite(value)) return 0;
	return Math.min(1, Math.max(0, value));
}

function uniqueTokens(text: string | null | undefined): Set<string> {
	return new Set(tokenize(text ?? ""));
}

function searchableFields(node: SessionContextNode): Record<SearchField, Set<string>> {
	const hasRefinement = Boolean(node.refinedPurpose?.trim());
	return {
		purposePrimary: uniqueTokens(hasRefinement ? node.refinedPurpose : node.purpose),
		purposeFallback: uniqueTokens(hasRefinement ? node.purpose : undefined),
		operationDetail: uniqueTokens(node.operationDetail),
		operation: uniqueTokens(node.operation),
		titleCompressed: uniqueTokens(`${node.title} ${node.compressedBody}`),
		body: uniqueTokens(node.body),
		childType: uniqueTokens(node.childType ? CHILD_TYPE_TEXT[node.childType] : ""),
	};
}

function buildIdf(
	queryTokens: string[],
	documents: Array<{ fieldTokens: Record<SearchField, Set<string>> }>,
): Record<SearchField, Map<string, number>> {
	const fields = Object.keys(MAIN_FIELD_WEIGHTS) as SearchField[];
	const result = Object.fromEntries(fields.map((field) => [field, new Map<string, number>()])) as Record<SearchField, Map<string, number>>;
	for (const field of fields) {
		for (const token of queryTokens) {
			let frequency = 0;
			for (const document of documents) {
				if (document.fieldTokens[field].has(token)) frequency += 1;
			}
			result[field].set(token, Math.log((documents.length + 1) / (frequency + 1)) + 1);
		}
	}
	return result;
}

function fieldMatchScore(queryTokens: string[], tokens: Set<string>, idf: Map<string, number>): number {
	if (queryTokens.length === 0 || tokens.size === 0) return 0;
	let matched = 0;
	let total = 0;
	for (const token of queryTokens) {
		const weight = idf.get(token) ?? 1;
		total += weight;
		if (tokens.has(token)) matched += weight;
	}
	return total > 0 ? matched / total : 0;
}

function scoreDocuments(
	nodes: SessionContextNode[],
	queryTokens: string[],
	weights: Record<SearchField, number>,
): SearchableNode[] {
	const documents = nodes.map((node) => ({ node, fieldTokens: searchableFields(node) }));
	const idf = buildIdf(queryTokens, documents);
	return documents.map((document) => {
		let weighted = 0;
		let activeWeight = 0;
		for (const field of Object.keys(weights) as SearchField[]) {
			const fieldWeight = weights[field];
			if (fieldWeight <= 0) continue;
			activeWeight += fieldWeight;
			weighted += fieldWeight * fieldMatchScore(queryTokens, document.fieldTokens[field], idf[field]);
		}
		const lexicalScore = activeWeight > 0 ? clamp01(weighted / activeWeight) : 0;
		const score = clamp01(0.96 * lexicalScore + 0.03 * clamp01(document.node.importance) + 0.01 * clamp01(KIND_PRIOR[document.node.kind] ?? 0.5));
		return { ...document, lexicalScore, score };
	});
}

function stableNodeCompare(left: SearchableNode, right: SearchableNode): number {
	return right.score - left.score
		|| (left.node.sourceTurnIndex ?? Number.MAX_SAFE_INTEGER) - (right.node.sourceTurnIndex ?? Number.MAX_SAFE_INTEGER)
		|| left.node.id.localeCompare(right.node.id);
}

function explicitChildIntents(queryTokens: string[]): Set<ChildIntent> {
	const intents = new Set<ChildIntent>();
	for (const [intent, tokens] of Object.entries(CHILD_INTENT_TOKENS) as Array<[ChildIntent, ReadonlySet<string>]>) {
		if (queryTokens.some((token) => tokens.has(token))) intents.add(intent);
	}
	return intents;
}

function childMatchesIntent(child: SessionContextNode, intents: Set<ChildIntent>): boolean {
	if (intents.size === 0) return false;
	if (child.childType === "test") return intents.has("test");
	if (child.childType === "task_state") return intents.has("task_state");
	if (child.childType === "subagent_result") return intents.has("subagent_result");
	if (child.childType === "error" || child.status === "failed" || child.status === "blocked" || child.status === "aborted") return intents.has("error");
	return false;
}

function selectMainCandidates(
	rankedUser: SearchableNode[],
	rankedAssistant: SearchableNode[],
	limit: number,
): SearchableNode[] {
	const capacity = Math.max(0, Math.trunc(limit));
	if (capacity === 0) return [];
	const floor = Math.max(8, Math.ceil(capacity * 0.30));
	const selected: SearchableNode[] = [];
	const selectedIds = new Set<string>();
	const take = (items: SearchableNode[], count: number) => {
		for (const item of items) {
			if (selected.length >= capacity || count <= 0) break;
			if (selectedIds.has(item.node.id)) continue;
			selected.push(item);
			selectedIds.add(item.node.id);
			count -= 1;
		}
	};

	if (capacity < floor * 2 && rankedUser.length > 0 && rankedAssistant.length > 0) {
		const half = Math.floor(capacity / 2);
		take(rankedUser, half + capacity % 2);
		take(rankedAssistant, half);
	} else {
		take(rankedUser, Math.min(floor, rankedUser.length));
		take(rankedAssistant, Math.min(floor, rankedAssistant.length));
	}
	const remaining = [...rankedUser, ...rankedAssistant]
		.filter((item) => !selectedIds.has(item.node.id))
		.sort(stableNodeCompare);
	take(remaining, capacity - selected.length);
	return selected;
}

function pairScore(unit: PairUnit): number {
	const left = unit.user?.score ?? 0;
	const right = unit.assistant?.score ?? 0;
	const high = Math.max(left, right);
	const low = Math.min(left, right);
	return clamp01((high + 0.35 * low + (unit.hasAnswersEdge ? 0.01 : 0)) / 1.36);
}

function childPriority(item: SearchableNode): [number, number, number, number, number, number, number, number, string] {
	const node = item.node;
	const direct = item.lexicalScore > 0 ? 1 : 0;
	const failed = node.status === "failed" || node.status === "blocked" || node.status === "aborted" || node.childType === "error" ? 1 : 0;
	return [
		direct,
		failed,
		node.childType === "test" ? 1 : 0,
		node.childType === "subagent_result" ? 1 : 0,
		node.childType === "task_state" ? 1 : 0,
		node.childType === "tool_evidence" ? 1 : 0,
		item.score,
		-(node.sourceTurnIndex ?? Number.MAX_SAFE_INTEGER),
		node.id,
	];
}

function compareChildren(left: SearchableNode, right: SearchableNode): number {
	const a = childPriority(left);
	const b = childPriority(right);
	for (let index = 0; index < a.length - 1; index += 1) {
		const difference = (b[index] as number) - (a[index] as number);
		if (difference !== 0) return difference;
	}
	return (a[a.length - 1] as string).localeCompare(b[b.length - 1] as string);
}

function mainPopulation(node: SessionContextNode | undefined): MainPopulation | undefined {
	if (!node || node.nodeRole !== "main") return undefined;
	return node.population === "user" || node.population === "assistant" ? node.population : undefined;
}

export function retrieveConversationPairs(
	input: PairRetrievalInput,
	graph: SessionContextGraphResponse,
): PairRetrievalResult | undefined {
	const eligibleMainNodes = graph.nodes.filter((node) => mainPopulation(node));
	const childNodes = graph.nodes.filter((node) => node.nodeRole === "child" && Boolean(node.parentNodeId) && Boolean(node.pairId));
	if (eligibleMainNodes.length === 0 && childNodes.length === 0) return undefined;

	const queryTokens = [...new Set(tokenize(input.query))];
	const scoredMain = scoreDocuments(eligibleMainNodes, queryTokens, MAIN_FIELD_WEIGHTS);
	const scoredChildren = scoreDocuments(childNodes, queryTokens, CHILD_FIELD_WEIGHTS);
	const mainById = new Map(scoredMain.map((item) => [item.node.id, item]));
	const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
	const childrenByParent = new Map<string, SearchableNode[]>();
	for (const child of scoredChildren) {
		const parentId = child.node.parentNodeId;
		if (!parentId) continue;
		const existing = childrenByParent.get(parentId);
		if (existing) existing.push(child);
		else childrenByParent.set(parentId, [child]);
	}

	const partnerById = new Map<string, string>();
	const answerEdgePairIds = new Set<string>();
	for (const edge of graph.edges) {
		if (edge.relation !== "answers") continue;
		const source = nodeById.get(edge.sourceNodeId);
		const target = nodeById.get(edge.targetNodeId);
		if (mainPopulation(source) !== "user" || mainPopulation(target) !== "assistant") continue;
		partnerById.set(source!.id, target!.id);
		partnerById.set(target!.id, source!.id);
		const pairId = source!.pairId ?? target!.pairId;
		if (pairId) answerEdgePairIds.add(pairId);
	}

	const unitsByPairId = new Map<string, PairUnit>();
	for (const item of scoredMain) {
		const pairId = item.node.pairId;
		if (!pairId) continue;
		let unit = unitsByPairId.get(pairId);
		if (!unit) {
			unit = { pairId, hasAnswersEdge: answerEdgePairIds.has(pairId), forcedChildren: [], score: 0 };
			unitsByPairId.set(pairId, unit);
		}
		if (item.node.population === "user") unit.user = item;
		else if (item.node.population === "assistant") unit.assistant = item;
	}
	for (const unit of unitsByPairId.values()) unit.score = pairScore(unit);

	const qualifyingUser = scoredMain.filter((item) => item.node.population === "user" && item.lexicalScore > 0).sort(stableNodeCompare);
	const qualifyingAssistant = scoredMain.filter((item) => item.node.population === "assistant" && item.lexicalScore > 0).sort(stableNodeCompare);
	const mainCandidates = selectMainCandidates(qualifyingUser, qualifyingAssistant, input.candidateMainLimit);
	const candidateMainIds = new Set(mainCandidates.map((item) => item.node.id));
	for (const item of mainCandidates) {
		const unit = item.node.pairId ? unitsByPairId.get(item.node.pairId) : undefined;
		const partnerId = partnerById.get(item.node.id)
			?? (item.node.population === "user" ? unit?.assistant?.node.id : unit?.user?.node.id);
		if (partnerId) candidateMainIds.add(partnerId);
	}

	const intents = explicitChildIntents(queryTokens);
	const explicitQuery = intents.size > 0;
	const forcedChildren = explicitQuery
		? scoredChildren.filter((item) => item.lexicalScore > 0 && childMatchesIntent(item.node, intents)).sort(compareChildren)
		: [];
	for (const child of forcedChildren) {
		const pairId = child.node.pairId;
		const unit = pairId ? unitsByPairId.get(pairId) : undefined;
		if (!unit?.assistant || !unit.user || child.node.parentNodeId !== unit.assistant.node.id) continue;
		unit.forcedChildren.push(child);
		candidateMainIds.add(unit.user.node.id);
		candidateMainIds.add(unit.assistant.node.id);
		unit.score = Math.max(unit.score, child.score);
	}

	const candidateUnits = [...unitsByPairId.values()]
		.filter((unit) => Boolean(unit.user) && (candidateMainIds.has(unit.user!.node.id) || Boolean(unit.assistant && candidateMainIds.has(unit.assistant.node.id)) || unit.forcedChildren.length > 0))
		.sort((left, right) => right.score - left.score
			|| (left.user?.node.sourceTurnIndex ?? left.assistant?.node.sourceTurnIndex ?? Number.MAX_SAFE_INTEGER)
				- (right.user?.node.sourceTurnIndex ?? right.assistant?.node.sourceTurnIndex ?? Number.MAX_SAFE_INTEGER)
			|| left.pairId.localeCompare(right.pairId));

	const selectedUnits: PairUnit[] = [];
	const selectedMainIds: string[] = [];
	const selectedChildren: SearchableNode[] = [];
	const selectedChildIds = new Set<string>();
	let remainingNodes = Math.max(0, Math.trunc(input.outputNodeLimit));
	for (const unit of candidateUnits) {
		const mainCost = unit.assistant ? 2 : 1;
		const requiredChild = unit.forcedChildren[0];
		const unitCost = mainCost + (requiredChild ? 1 : 0);
		if (unitCost > remainingNodes) continue;
		selectedUnits.push(unit);
		selectedMainIds.push(unit.user!.node.id);
		if (unit.assistant) selectedMainIds.push(unit.assistant.node.id);
		remainingNodes -= mainCost;
		if (requiredChild) {
			selectedChildren.push(requiredChild);
			selectedChildIds.add(requiredChild.node.id);
			remainingNodes -= 1;
		}
	}

	const defaultPerAssistant = Math.max(0, Math.trunc(input.maxChildrenPerAssistant ?? 5));
	const perAssistantLimit = explicitQuery ? Math.max(defaultPerAssistant, 8) : defaultPerAssistant;
	const perTypeLimit = Math.max(0, Math.trunc(input.maxChildrenPerType ?? 2));
	for (const unit of selectedUnits) {
		const assistant = unit.assistant?.node;
		if (!assistant || remainingNodes <= 0 || perAssistantLimit <= 0) continue;
		const owned = [...(childrenByParent.get(assistant.id) ?? [])].sort(compareChildren);
		const selectedForAssistant = selectedChildren.filter((item) => item.node.parentNodeId === assistant.id);
		const typeCounts = new Map<string, number>();
		for (const child of selectedForAssistant) typeCounts.set(child.node.childType ?? "", (typeCounts.get(child.node.childType ?? "") ?? 0) + 1);
		for (const child of owned) {
			if (remainingNodes <= 0 || selectedForAssistant.length >= perAssistantLimit) break;
			if (selectedChildIds.has(child.node.id)) continue;
			const type = child.node.childType ?? "";
			const directExplicitMatch = explicitQuery && child.lexicalScore > 0 && childMatchesIntent(child.node, intents);
			if (!directExplicitMatch && (typeCounts.get(type) ?? 0) >= perTypeLimit) continue;
			selectedChildren.push(child);
			selectedForAssistant.push(child);
			selectedChildIds.add(child.node.id);
			typeCounts.set(type, (typeCounts.get(type) ?? 0) + 1);
			remainingNodes -= 1;
		}
	}

	const selectedNodeIds = [...selectedMainIds, ...selectedChildren.map((item) => item.node.id)];
	const selectedSet = new Set(selectedNodeIds);
	const selectedEdges = graph.edges
		.filter((edge) => selectedSet.has(edge.sourceNodeId) && selectedSet.has(edge.targetNodeId))
		.sort((left, right) => Number(right.relation === "answers") - Number(left.relation === "answers"))
		.slice(0, Math.max(0, Math.trunc(input.outputEdgeLimit)));
	const selectedMainSet = new Set(selectedMainIds);
	const artifacts = graph.artifacts
		.filter((item) => item.nodeId ? selectedSet.has(item.nodeId) : selectedMainSet.size > 0)
		.slice(0, Math.max(0, Math.trunc(input.outputArtifactLimit)))
		.map((item) => ({ kind: item.kind, ref: item.ref, ...(item.nodeId ? { nodeId: item.nodeId } : {}), label: item.label }));
	const eligibleCounts = {
		userMain: scoredMain.filter((item) => item.node.population === "user").length,
		assistantMain: scoredMain.filter((item) => item.node.population === "assistant").length,
		children: scoredChildren.length,
	};
	const candidateCounts = {
		userMain: [...candidateMainIds].filter((id) => mainById.get(id)?.node.population === "user").length,
		assistantMain: [...candidateMainIds].filter((id) => mainById.get(id)?.node.population === "assistant").length,
		children: explicitQuery ? forcedChildren.length : selectedUnits.reduce((count, unit) => count + (unit.assistant ? (childrenByParent.get(unit.assistant.node.id)?.length ?? 0) : 0), 0),
	};
	const selectedPairIds = selectedUnits.map((unit) => unit.pairId);
	const totalPairUnits = [...unitsByPairId.values()].filter((unit) => Boolean(unit.user)).length;
	const omitted = {
		pairs: Math.max(0, totalPairUnits - selectedPairIds.length),
		children: Math.max(0, scoredChildren.length - selectedChildren.length),
		reason: selectedNodeIds.length < eligibleMainNodes.length + childNodes.length ? "budget" : "none",
	};

	return {
		selectedPairIds,
		selectedNodeIds,
		selectedChildIds: selectedChildren.map((item) => item.node.id),
		selectedEdgeIds: selectedEdges.map((edge) => edge.id),
		artifacts,
		eligibleCounts,
		candidateCounts,
		omitted,
		ranking: candidateUnits.map((unit) => ({
			unitId: unit.pairId,
			score: unit.score,
			nodeIds: [unit.user?.node.id, unit.assistant?.node.id].filter((id): id is string => Boolean(id)),
		})),
	};
}
