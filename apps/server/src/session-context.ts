import type {
	SessionContextArtifact,
	SessionContextEdge,
	SessionContextGraphResponse,
	SessionContextNode,
	SessionContextPackResponse,
	SessionContextRawRef,
	SessionContextRebuildResponse,
	SessionTopologyFocusPayloadV2,
	SessionTopologyFocusSource,
	SessionTopologyFocusV2Child,
	SessionTopologyFocusV2Node,
	SessionTopologyFocusV2Pair,
} from "@omp-deck/protocol";

import {
	getCompleteSessionContextGraph,
	getSessionContextGraph,
	getSessionContextStatus,
	replaceSessionContext,
	upsertSessionContextCheckpoint,
} from "./db/session-context.ts";
import { redactSensitiveText } from "./redaction.ts";
import { normalizeSessionJsonl } from "./session-context-events.ts";
import { buildConversationTopology } from "./session-context-pairs.ts";

import { getTopologyRerankConfig } from "./config-topology-rerank.ts";
import { retrieveTopology, tokenize, type RetrievedTopology, type RetrieveTopologyInput } from "./session-topology-retrieval.ts";
import { retrieveConversationPairs, type PairRetrievalResult } from "./session-pair-retrieval.ts";
import {
	applyPairRerankPatch,
	applyRerankPatch,
	buildTopologyPairRerankRequest,
	buildTopologyRerankRequest,
	parsePairRerankPatch,
	rerankTopologyWithExternalApi,
	shouldExternalRerank,
	validatePairRerankPatch,
	validateRerankPatch,
	type RerankPatch,
	type TopologyRerankModelClient,
} from "./topology-reranker.ts";
import { rerankTopologyWithHttp } from "./topology-rerank-http-client.ts";
import { rerankTopologyPairsWithSiliconflow, rerankTopologyWithSiliconflow } from "./topology-rerank-siliconflow-adapter.ts";
import { readManagedEnvFile } from "./env-store.ts";
import { embedTexts, cosineSimilarity, type EmbeddingConfig } from "./topology-siliconflow-embedding.ts";
import { getNodeEmbeddings, saveNodeEmbeddings } from "./db/session-context.ts";
import { refineNodesWithLLM, type TopologyExtractorModelClient } from "./topology-extractor.ts";

export const TOPOLOGY_EMBEDDING_RECIPE_VERSION = "conversation-v2";

function embeddingField(value: string | null | undefined): string | undefined {
	const normalized = value?.replace(/\s+/g, " ").trim();
	return normalized ? [...normalized].slice(0, 512).join("") : undefined;
}

export function buildTopologyEmbeddingDocument(node: SessionContextNode): string {
	const refinedPurpose = embeddingField(node.refinedPurpose);
	const deterministicPurpose = embeddingField(node.purpose);
	const fields: Array<[string, string | undefined]> = [
		["population", embeddingField(node.population)],
		["role", embeddingField(node.nodeRole)],
		["childType", embeddingField(node.childType)],
		["pair", node.nodeRole === "child" ? embeddingField(node.pairId) : undefined],
		["operation", embeddingField(node.operation)],
		["detail", embeddingField(node.operationDetail)],
		["purpose", refinedPurpose ?? deterministicPurpose],
		["purposeFallback", refinedPurpose ? deterministicPurpose : undefined],
		["title", embeddingField(node.title)],
		["body", embeddingField(node.compressedBody || node.body)],
	];
	return fields.filter((field): field is [string, string] => Boolean(field[1])).map(([label, value]) => `${label}=${value}`).join("; ");
}
export interface ExtractInput {
	sessionId: string;
	content: string;
}

export interface ExtractedSessionContext {
	nodes: SessionContextNode[];
	edges: SessionContextEdge[];
	artifacts: SessionContextArtifact[];
}

export interface RenderPackInput extends ExtractedSessionContext {
	sessionId: string;
	query: string;
	budget: number;
}

const FILE_RE = /(?:^|\s)([\w./~@-]+\.(?:ts|tsx|js|jsx|json|md|sql|yaml|yml|sh|ps1))(?:\b|$)/g;
const COMMIT_RE = /\b[0-9a-f]{7,40}\b/g;
const TEST_COMMAND_RE = /\b(?:bun|npm|pnpm|yarn)\s+(?:test|run)[^\n]*/g;

function parseJsonLine(line: string): Record<string, unknown> | undefined {
	try {
		const parsed = JSON.parse(line) as unknown;
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined;
	} catch {
		return undefined;
	}
}

function textFromContent(value: unknown): string {
	if (typeof value === "string") return value;
	if (Array.isArray(value)) {
		return value
			.map((item) => {
				if (typeof item === "string") return item;
				if (!item || typeof item !== "object") return "";
				const obj = item as Record<string, unknown>;
				return typeof obj.text === "string" ? obj.text : "";
			})
			.filter(Boolean)
			.join("\n");
	}
	return "";
}

function messageParts(
	record: Record<string, unknown>,
	lineNumber: number,
): { id: string; role: string; text: string; timestamp: string } | undefined {
	if (record.type !== "message") return undefined;
	const message = record.message;
	if (!message || typeof message !== "object") return undefined;
	const msg = message as Record<string, unknown>;
	const role = typeof msg.role === "string" ? msg.role : "unknown";
	const text = textFromContent(msg.content);
	if (!text.trim()) return undefined;
	const idValue = record.id;
	const id = typeof idValue === "string" && idValue.trim() ? idValue : `line-${lineNumber}`;
	const timestampValue = record.timestamp;
	const timestamp = typeof timestampValue === "string" ? timestampValue : new Date(0).toISOString();
	return { id, role, text, timestamp };
}

function compressText(text: string): string {
	return text
		.replace(/\s+/g, " ")
		.replace(/\b(?:I think|I should|Maybe|Now|Next)\b[:,]?\s*/gi, "")
		.trim()
		.slice(0, 300);
}

function makeNode(input: {
	sessionId: string;
	kind: SessionContextNode["kind"];
	messageId: string;
	turnIndex: number;
	title: string;
	body: string;
	importance: number;
	createdAt: string;
	metadata?: Record<string, unknown>;
}): SessionContextNode {
	return {
		id: `${input.sessionId}:${input.kind}:${input.turnIndex}:${input.messageId}`,
		sessionId: input.sessionId,
		kind: input.kind,
		title: redactSensitiveText(input.title).slice(0, 80),
		body: redactSensitiveText(input.body),
		compressedBody: compressText(redactSensitiveText(input.body)),
		importance: input.importance,
		createdAt: input.createdAt,
		sourceMessageId: input.messageId,
		sourceTurnIndex: input.turnIndex,
		metadata: input.metadata ?? {},
	};
}

function classifyUserText(text: string): SessionContextNode["kind"] {
	if (/希望|不是|而是|纠正|改成|不要|必须|must|should|instead/i.test(text)) return "user_intent";
	return "goal";
}

/** OMP internal markers and known low-value toolResult patterns to skip. */
const TOOL_NOISE_RE = /^\s*(?:\[Superseded by a newer read of this file\]|Skipped due to queued user message|\(no output\)|Background job \w+|## (?:Completed|Still Running)|Spawned agent|Remaining items \(|Wall time: \d|Rewind requested|Checkpoint (?:started|created)|applying migration \d|kill -9 |lsof -ti|\[INFO\] |\[WARN\] |\[ERROR\] |totalReplacements)/i;

/**
 * Secondary content-based noise check for patterns that can't be expressed
 * as a simple prefix regex. Catches git output, process management, and
 * status snapshots that carry no semantic value for topology.
 */
function isToolNoiseContent(text: string): boolean {
	const t = text.trim();
	if (t.length === 0) return true;
	// Git push/diff/status output
	if (/^(?:To |To\t).*github\.com/m.test(t)) return true;
	if (/^\s*[MAD]\s+\S/m.test(t) && t.split("\n").length < 10) return true;
	if (/^\S+\s*\|\s*\d+\s+[+-]+/m.test(t)) return true;
	// Standalone "Wall time" with nothing else useful
	if (/^Wall time: \d/m.test(t) && t.length < 50) return true;
	// Job/poll/status blocks with just counters and no semantic content
	if (/^(?:## |Label: |Delivered|Cancelled)/m.test(t) && t.length < 300) return true;
	return false;
}
function isToolRole(role: string): boolean {
	return role === "tool" || role === "toolResult";
}

function classifyNonUserText(role: string, text: string): SessionContextNode["kind"] | undefined {
	if (isToolRole(role)) {
		if (TOOL_NOISE_RE.test(text)) return undefined;
		if (isToolNoiseContent(text)) return undefined;
		// Only apply keyword-based issue detection to short outputs (test
		// summaries, exit codes, error lines). Long outputs (file contents,
		// fetched webpages) almost always contain "error"/"fail" somewhere
		// in the body — that's not a real issue signal.
		if (text.trim().length < 500) {
			const stripped = text.replace(/\b0\s+(?:fails?|failures?|errors?)\b/gi, "");
			const hasFailure =
				/\bfail(?:ures?|ed)?\b/i.test(stripped) ||
				/\berrors?\b/i.test(stripped) ||
				/\bexit\s*[12]\b/i.test(stripped) ||
				/Path not found:|No such file|ENOENT/i.test(stripped);
			if (hasFailure) return "issue";
			if (/\b(?:pass|HTTP|status:)\b/i.test(text)) return "evidence";
		}
		// Substantial tool output (> 20 chars) becomes evidence so file
		// reads, grep hits, write confirmations, and command outputs are
		// preserved as topology nodes instead of being silently dropped.
		if (text.trim().length > 20) return "evidence";
		return undefined;
	}
	// Assistant messages: capture decisions and code-bearing resolutions.
	if (/\b(?:decision|recommend|architecture|选择|推荐|决定)\b/i.test(text)) return "decision";
	if (/```[\s\S]*?```/m.test(text)) return "resolution";
	return undefined;
}

function artifactMatches(sessionId: string, nodeId: string, text: string): SessionContextArtifact[] {
	const artifacts: SessionContextArtifact[] = [];
	for (const match of text.matchAll(FILE_RE)) {
		const ref = match[1];
		if (!ref) continue;
		const safeRef = redactSensitiveText(ref); artifacts.push({ id: `${nodeId}:file:${artifacts.length}`, sessionId, nodeId, kind: "file", ref: safeRef, label: safeRef, metadata: {} });
	}
	for (const match of text.matchAll(COMMIT_RE)) {
		const ref = match[0];
		const safeRef = redactSensitiveText(ref); artifacts.push({ id: `${nodeId}:commit:${artifacts.length}`, sessionId, nodeId, kind: "commit", ref: safeRef, label: safeRef.slice(0, 12), metadata: {} });
	}
	for (const match of text.matchAll(TEST_COMMAND_RE)) {
		const ref = match[0];
		const safeRef = redactSensitiveText(ref); artifacts.push({ id: `${nodeId}:test:${artifacts.length}`, sessionId, nodeId, kind: "test", ref: safeRef, label: safeRef, metadata: {} });
	}
	return artifacts;
}

function deriveEvidenceTitle(text: string): string {
	const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
	// Test-result summaries: prefer the line with pass/fail/expect counts.
	for (const line of lines) {
		const lower = line.toLowerCase();
		if ((lower.includes("pass") || lower.includes("fail") || lower.includes("expect")) && /\d/.test(line)) {
			return line.slice(0, 120);
		}
	}
	// Generic summary line: first non-empty line, capped.
	return (lines[0] ?? "").slice(0, 120);
}

export function extractSessionContextFromJsonl(input: ExtractInput): ExtractedSessionContext {
	const nodes: SessionContextNode[] = [];
	const edges: SessionContextEdge[] = [];
	const artifacts: SessionContextArtifact[] = [];
	let lastGoal: SessionContextNode | undefined;
	let lastIssue: SessionContextNode | undefined;
	let turnIndex = 0;

	const lines = input.content.split(/\r?\n/);
	for (let lineNumber = 0; lineNumber < lines.length; lineNumber++) {
		const line = (lines[lineNumber] ?? "").trim();
		if (!line) continue;
		const record = parseJsonLine(line);
		if (!record) continue;
		const message = messageParts(record, lineNumber);
		if (!message) continue;
		turnIndex += 1;

		const kind = message.role === "user" ? classifyUserText(message.text) : classifyNonUserText(message.role, message.text);
		if (!kind) continue;
		const node = makeNode({
			sessionId: input.sessionId,
			kind,
			messageId: message.id,
			turnIndex,
			title: kind === "evidence" ? deriveEvidenceTitle(message.text) : (message.text.split(/\r?\n/)[0] ?? kind),
			body: message.text,
			importance: kind === "user_intent" ? 1 : kind === "evidence" ? 0.85 : 0.7,
			createdAt: message.timestamp,
			metadata: { role: message.role },
		});
		nodes.push(node);
		artifacts.push(...artifactMatches(input.sessionId, node.id, message.text));

		const previousGoal = lastGoal;
		if (kind === "goal") {
			if (previousGoal) {
				edges.push({
					id: `${node.id}:continues:${previousGoal.id}`,
					sessionId: input.sessionId,
					sourceNodeId: node.id,
					targetNodeId: previousGoal.id,
					relation: "continues",
					weight: 0.65,
					evidenceMessageId: message.id,
					metadata: {},
				});
			}
			lastGoal = node;
		}
		if (kind === "issue") lastIssue = node;
		if (kind === "decision" && previousGoal) {
			edges.push({
				id: `${node.id}:depends_on:${previousGoal.id}`,
				sessionId: input.sessionId,
				sourceNodeId: node.id,
				targetNodeId: previousGoal.id,
				relation: "depends_on",
				weight: 0.7,
				evidenceMessageId: message.id,
				metadata: {},
			});
		}
		if (kind === "user_intent" && lastGoal) {
			edges.push({
				id: `${node.id}:supersedes:${lastGoal.id}`,
				sessionId: input.sessionId,
				sourceNodeId: node.id,
				targetNodeId: lastGoal.id,
				relation: "supersedes",
				weight: 1,
				evidenceMessageId: message.id,
				metadata: {},
			});
		}
		if (kind === "evidence" && lastIssue) {
			edges.push({
				id: `${lastIssue.id}:verified_by:${node.id}`,
				sessionId: input.sessionId,
				sourceNodeId: lastIssue.id,
				targetNodeId: node.id,
				relation: "verified_by",
				weight: 0.9,
				evidenceMessageId: message.id,
				metadata: {},
			});
		}
	}

	return { nodes, edges, artifacts };
}

function scoreNode(node: SessionContextNode, query: string): number {
	const q = query.trim().toLowerCase();
	let score = node.importance;
	if (q && `${node.title}\n${node.body}`.toLowerCase().includes(q)) score += 2;
	if (node.kind === "user_intent" || node.kind === "constraint") score += 1.5;
	if (node.kind === "issue" || node.kind === "evidence") score += 1;
	return score;
}

function byKinds(nodes: SessionContextNode[], kinds: SessionContextNode["kind"][]): SessionContextNode[] {
	const wanted = new Set(kinds);
	return nodes.filter((node) => wanted.has(node.kind));
}

function rawRefsFor(nodes: SessionContextNode[], artifacts: SessionContextArtifact[]): SessionContextRawRef[] {
	const refs: SessionContextRawRef[] = [];
	for (const node of nodes) {
		refs.push({ messageId: node.sourceMessageId, turnIndex: node.sourceTurnIndex, label: `${node.kind}: ${node.title}` });
	}
	for (const artifact of artifacts.slice(0, 20)) {
		refs.push({ artifactId: artifact.id, label: `${artifact.kind}: ${artifact.label}` });
	}
	return refs;
}

export function renderSessionContextPack(input: RenderPackInput): SessionContextPackResponse {
	const ranked = [...input.nodes].sort((a, b) => scoreNode(b, input.query) - scoreNode(a, input.query));
	let remaining = Math.max(500, input.budget);
	const selected: SessionContextNode[] = [];
	for (const node of ranked) {
		const cost = node.compressedBody.length + node.title.length + 64;
		if (selected.length > 0 && cost > remaining) continue;
		selected.push(node);
		remaining -= cost;
		if (remaining < 0) {
			// The mandatory anchor (first selected node) exceeded the budget: keep it and
			// stop so `remaining` never goes negative, which would otherwise suppress every
			// later node. Clamping to 0 keeps omitted counts coherent.
			remaining = 0;
			break;
		}
	}
	const selectedIds = new Set(selected.map((node) => node.id));
	const artifacts = input.artifacts.filter((artifact) => !artifact.nodeId || selectedIds.has(artifact.nodeId));
	const summary = selected.slice(0, 8).map((node) => `${node.kind}: ${node.compressedBody}`).join("\n");
	return {
		sessionId: input.sessionId,
		query: input.query,
		budget: input.budget,
		summary,
		goals: byKinds(selected, ["goal", "user_intent"]),
		constraints: byKinds(selected, ["constraint"]),
		decisions: byKinds(selected, ["decision"]),
		issues: byKinds(selected, ["issue"]),
		resolutions: byKinds(selected, ["resolution"]),
		artifacts,
		evidence: byKinds(selected, ["evidence"]),
		openTodos: byKinds(selected, ["todo_state"]),
		rawRefs: rawRefsFor(selected, artifacts),
		omitted: {
			nodeCount: input.nodes.length - selected.length,
			edgeCount: input.edges.filter((edge) => !selectedIds.has(edge.sourceNodeId) || !selectedIds.has(edge.targetNodeId)).length,
			reason: selected.length < input.nodes.length ? "budget" : "none",
		},
	};
}

export async function rebuildSessionContextFromFile(input: {
	sessionId: string;
	sessionFile: string;
	extractorClient?: TopologyExtractorModelClient;
	extractorModelRole?: string;
}): Promise<SessionContextRebuildResponse> {
	const file = Bun.file(input.sessionFile);
	if (!(await file.exists())) throw new Error("session file not found");
	const [content, stat] = await Promise.all([file.text(), file.stat()]);

	// Chunked async extraction: yield to the event loop between heavy
	// synchronous operations so WebSocket heartbeats and other I/O are
	// not starved on large sessions (1000+ messages).
	const normalized = normalizeSessionJsonl({ content });
	await Bun.sleep(0);

	const extracted = buildConversationTopology({ sessionId: input.sessionId, events: normalized.activeEvents });
	await Bun.sleep(0);

	let nodes = extracted.nodes;
	if (input.extractorClient && input.extractorModelRole && nodes.length > 0) {
		nodes = await refineNodesWithLLM({ nodes, client: input.extractorClient, modelRole: input.extractorModelRole });
	}
	await Bun.sleep(0);

	const nodeIds = new Set(nodes.map((node) => node.id));
	const edges = extracted.edges.filter((edge) => nodeIds.has(edge.sourceNodeId) && nodeIds.has(edge.targetNodeId));
	const artifacts = extracted.artifacts.filter((artifact) => !artifact.nodeId || nodeIds.has(artifact.nodeId));

	replaceSessionContext({ sessionId: input.sessionId, nodes, edges, artifacts });
	const rebuiltAt = new Date().toISOString();
	upsertSessionContextCheckpoint({
		sessionId: input.sessionId,
		sourcePath: input.sessionFile,
		sourceMtimeMs: Math.trunc(stat.mtimeMs),
		sourceSizeBytes: stat.size,
		nodeCount: nodes.length,
		edgeCount: edges.length,
		rebuiltAt,
		extractionSchemaVersion: 2,
	});
	return {
		sessionId: input.sessionId,
		nodeCount: nodes.length,
		edgeCount: edges.length,
		sourcePath: input.sessionFile,
		rebuiltAt,
	};
}

export function getStoredSessionContextPack(input: {
	sessionId: string;
	query: string;
	budget: number;
}): SessionContextPackResponse {
	const graph = getSessionContextGraph(input.sessionId, 500);
	return renderSessionContextPack({
		sessionId: input.sessionId,
		query: input.query,
		budget: input.budget,
		nodes: graph.nodes,
		edges: graph.edges,
		artifacts: graph.artifacts,
	});
}

export interface SessionTopologyFocusInput {
	sessionId: string;
	query: string;
	nodeLimit?: number;
	edgeLimit?: number;
	artifactLimit?: number;
}

function topologyNodeBody(node: SessionContextNode): string {
	return node.compressedBody || node.body;
}

export function renderTopologyGraphAsCompactFocus(
	graph: SessionContextGraphResponse,
	query = "",
	limits: { nodeLimit?: number; edgeLimit?: number; artifactLimit?: number } = {},
): string {
	if (graph.nodes.length === 0) return "";
	const nodeLimit = limits.nodeLimit ?? 10;
	const edgeLimit = limits.edgeLimit ?? 18;
	const artifactLimit = limits.artifactLimit ?? 12;
	const nodes = graph.nodes.slice(0, nodeLimit);
	const nodeIds = new Set(nodes.map((node) => node.id));
	const edges = graph.edges
		.filter((edge) => nodeIds.has(edge.sourceNodeId) && nodeIds.has(edge.targetNodeId))
		.slice(0, edgeLimit)
		.map((edge) => ({
			sourceNodeId: edge.sourceNodeId,
			relation: edge.relation,
			targetNodeId: edge.targetNodeId,
		}));
	const artifacts = graph.artifacts
		.filter((artifact) => !artifact.nodeId || nodeIds.has(artifact.nodeId))
		.slice(0, artifactLimit)
		.map((artifact) => ({
			kind: artifact.kind,
			ref: artifact.ref,
			...(artifact.nodeId ? { nodeId: artifact.nodeId } : {}),
			...(artifact.label ? { label: artifact.label } : {}),
		}));
	const payload = {
		type: "session_topology_subgraph",
		schemaVersion: 1,
		sessionId: graph.sessionId,
		query,
		nodes: nodes.map((node) => ({
			id: node.id,
			kind: node.kind,
			title: node.title,
			body: topologyNodeBody(node),
			source: {
				messageId: node.sourceMessageId,
				turnIndex: node.sourceTurnIndex,
			},
		})),
		edges,
		artifacts,
		omitted: {
			nodeCount: Math.max(0, graph.totalNodes - nodes.length),
			edgeCount: Math.max(0, graph.edges.length - edges.length),
			reason: graph.truncated || graph.totalNodes > nodes.length ? "budget" : "none",
		},
	};
	return [
		"Use the following session topology subgraph as source-grounded memory.",
		"Interpretation rules:",
		"1. Each node is a fact extracted from prior conversation turns.",
		"2. Each edge states a relationship between facts.",
		"3. Prefer connected facts over isolated facts, and prefer resolution/evidence paths over old issue-only nodes.",
		"4. Do not invent facts outside this subgraph. If detail is missing, say what is missing.",
		"<session_topology_subgraph>",
		JSON.stringify(payload),
		"</session_topology_subgraph>",
	].join("\n");
}

export function getStoredSessionTopologyFocus(input: SessionTopologyFocusInput): string {
	const graph = getSessionContextGraph(input.sessionId, input.nodeLimit ?? 200);
	return renderTopologyGraphAsCompactFocus(graph, input.query, input);
}
const DISABLED_RERANK_CLIENT: TopologyRerankModelClient = {
	async rerankTopology() {
		return undefined;
	},
};

export interface GetStoredQueryTopologyFocusInput {
	sessionId: string;
	query: string;
	contextPercent?: number | null;
	rerankClient?: TopologyRerankModelClient;
	fullGraph?: boolean;
}

const FULL_GRAPH_LIMITS = {
	candidateNodeLimit: 500,
	outputNodeLimit: 100,
	outputEdgeLimit: 150,
	outputArtifactLimit: 80,
	expansionHops: 2 as 1 | 2,
} as const;

const DEFAULT_CANDIDATE_NODE_LIMIT = 100;
const DEFAULT_NODE_OUTPUT_RATIO = 3 / 5; // tuned via offline sweep on one session; revisit on sessions with diverse node kinds
const DEFAULT_LIMITS = {
	candidateNodeLimit: DEFAULT_CANDIDATE_NODE_LIMIT,
	outputNodeLimit: Math.ceil(DEFAULT_CANDIDATE_NODE_LIMIT * DEFAULT_NODE_OUTPUT_RATIO), // 60
	outputEdgeLimit: 18,
	outputArtifactLimit: 12,
	expansionHops: 1 as 1 | 2,
} as const;

/**
 * Read the masked HTTP rerank API key from the settings/env store.
 * Returns empty string when the key is not set; the client then omits
 * the auth header.
 */
function getHttpRerankApiKey(): string {
	const file = readManagedEnvFile();
	const value = file.values.get("OMP_DECK_TOPOLOGY_RERANK_HTTP_API_KEY");
	return value ?? process.env.OMP_DECK_TOPOLOGY_RERANK_HTTP_API_KEY ?? "";
}

async function applyHttpRerankIfEnabled(input: {
	query: string;
	graph: SessionContextGraphResponse;
	local: RetrievedTopology;
	outputNodeLimit: number;
	outputEdgeLimit: number;
	minContextPercent: number;
	minCandidateNodes: number;
	localConfidenceBelow: number;
	contextPercent: number | null | undefined;
	httpConfig: ReturnType<typeof getTopologyRerankConfig>["http"] & { enabled: boolean };
}): Promise<RetrievedTopology | undefined> {
	if (!input.httpConfig) return undefined;
	if (!input.httpConfig.enabled) return undefined;
	if (!shouldExternalRerank({
		enabled: true,
		contextPercent: input.contextPercent,
		candidateNodeCount: input.local.candidateNodeCount,
		localTopScore: input.local.ranking[0]?.score ?? 0,
		minContextPercent: input.httpConfig.minContextPercent,
		minCandidateNodes: input.httpConfig.minCandidateNodes,
		localConfidenceBelow: input.httpConfig.confidenceThreshold,
	})) return undefined;
	const request = buildTopologyRerankRequest({
		query: input.query,
		graph: input.graph,
		local: input.local,
		nodeLimit: input.outputNodeLimit,
		edgeLimit: input.outputEdgeLimit,
	});
	
	let patch: RerankPatch | undefined;
	if (input.httpConfig.protocol === "siliconflow-rerank") {
		patch = await rerankTopologyWithSiliconflow({
			baseUrl: input.httpConfig.baseUrl,
			endpointPath: input.httpConfig.endpointPath,
			apiKey: getHttpRerankApiKey(),
			authHeaderName: input.httpConfig.authHeaderName,
			timeoutMs: input.httpConfig.timeoutMs,
			model: input.httpConfig.model,
			relevanceThreshold: input.httpConfig.confidenceThreshold,
			request,
		});
	} else {
		patch = await rerankTopologyWithHttp({
			baseUrl: input.httpConfig.baseUrl,
			endpointPath: input.httpConfig.endpointPath,
			apiKey: getHttpRerankApiKey(),
			authHeaderName: input.httpConfig.authHeaderName,
			timeoutMs: input.httpConfig.timeoutMs,
			request,
		});
	}
	console.log(`[topology-rerank] dispatching protocol=${input.httpConfig.protocol} baseUrl=${input.httpConfig.baseUrl}${input.httpConfig.endpointPath}`);
	console.log(`[topology-rerank] patch=${patch ? "OK" : "undefined"} after ${input.httpConfig.protocol}`);
	if (!patch) { console.log(`[topology-rerank] no patch → fallback to local baseline (protocol=${input.httpConfig.protocol})`); return undefined; }
	const valid = validateRerankPatch({
		patch,
		graph: input.graph,
		local: input.local,
		outputNodeLimit: input.outputNodeLimit,
		outputEdgeLimit: input.outputEdgeLimit,
	});
	if (!valid) { console.log(`[topology-rerank] apply=rejected after validateRerankPatch`); return undefined; }

	console.log(`[topology-rerank] apply=ok after validateRerankPatch`);
	return applyRerankPatch({

		local: input.local,
		graph: input.graph,
		patch: valid,
		outputNodeLimit: input.outputNodeLimit,
		outputEdgeLimit: input.outputEdgeLimit,
	});
}

const DEFAULT_EMBEDDING_MODEL = "BAAI/bge-large-zh-v1.5";
const DEFAULT_EMBEDDING_ENDPOINT = "/embeddings";
const DEFAULT_EMBEDDING_TIMEOUT_MS = 30_000;

function getEmbeddingConfig(): EmbeddingConfig | undefined {
	const file = readManagedEnvFile();
	const enabled = file.values.get("OMP_DECK_TOPOLOGY_EMBEDDING_ENABLED") ?? process.env.OMP_DECK_TOPOLOGY_EMBEDDING_ENABLED;
	if (!enabled || !["1", "true", "yes"].includes(enabled.trim().toLowerCase())) return undefined;
	const baseUrl = file.values.get("OMP_DECK_TOPOLOGY_EMBEDDING_BASE_URL") ?? process.env.OMP_DECK_TOPOLOGY_EMBEDDING_BASE_URL ?? "";
	if (!baseUrl) return undefined;
	const apiKey = file.values.get("OMP_DECK_TOPOLOGY_EMBEDDING_API_KEY") ?? process.env.OMP_DECK_TOPOLOGY_EMBEDDING_API_KEY ?? getHttpRerankApiKey();
	const model = file.values.get("OMP_DECK_TOPOLOGY_EMBEDDING_MODEL") ?? process.env.OMP_DECK_TOPOLOGY_EMBEDDING_MODEL ?? DEFAULT_EMBEDDING_MODEL;
	const endpointPath = file.values.get("OMP_DECK_TOPOLOGY_EMBEDDING_ENDPOINT_PATH") ?? process.env.OMP_DECK_TOPOLOGY_EMBEDDING_ENDPOINT_PATH ?? DEFAULT_EMBEDDING_ENDPOINT;
	const timeoutMsText = file.values.get("OMP_DECK_TOPOLOGY_EMBEDDING_TIMEOUT_MS") ?? process.env.OMP_DECK_TOPOLOGY_EMBEDDING_TIMEOUT_MS;
	const timeoutMs = timeoutMsText ? Math.max(1, Number(timeoutMsText) || DEFAULT_EMBEDDING_TIMEOUT_MS) : DEFAULT_EMBEDDING_TIMEOUT_MS;
	return { baseUrl, endpointPath, apiKey, model, timeoutMs };
}

function expandNeighborsLocal(seeds: Set<string>, graph: SessionContextGraphResponse, hops: 1 | 2): Set<string> {
	const result = new Set(seeds);
	let frontier = new Set(seeds);
	for (let hop = 0; hop < hops; hop += 1) {
		const next = new Set<string>();
		for (const nodeId of frontier) {
			for (const edge of graph.edges) {
				if (edge.sourceNodeId === nodeId && !result.has(edge.targetNodeId)) next.add(edge.targetNodeId);
				if (edge.targetNodeId === nodeId && !result.has(edge.sourceNodeId)) next.add(edge.sourceNodeId);
			}
		}
		for (const id of next) result.add(id);
		frontier = next;
	}
	return result;
}

async function getOrEmbedNodeEmbeddings(
	sessionId: string,
	nodes: SessionContextNode[],
	config: EmbeddingConfig,
	modelIdentity = config.model,
	documentBuilder: (node: SessionContextNode) => string = (node) => `${node.kind}: ${node.title} — ${node.compressedBody || node.body}`.slice(0, 512),
): Promise<Map<string, Float32Array> | undefined> {
	const stored = getNodeEmbeddings(sessionId, modelIdentity);
	const missing = nodes.filter((node) => !stored.has(node.id));
	for (let start = 0; start < missing.length; start += 128) {
		const batch = missing.slice(start, start + 128);
		const embeddings = await embedTexts(config, batch.map(documentBuilder));
		if (!embeddings || embeddings.length !== batch.length) return undefined;
		const entries: Array<{ nodeId: string; embedding: number[] }> = [];
		for (let index = 0; index < batch.length; index += 1) {
			const node = batch[index];
			const vector = embeddings[index];
			if (!node || !vector) return undefined;
			entries.push({ nodeId: node.id, embedding: vector });
			stored.set(node.id, Float32Array.from(vector));
		}
		saveNodeEmbeddings({ sessionId, model: modelIdentity, entries });
	}
	return stored;
}

export async function retrieveTopologyWithEmbeddings(input: RetrieveTopologyInput, graph: SessionContextGraphResponse, embeddingConfig: EmbeddingConfig): Promise<RetrievedTopology | undefined> {
	if (graph.nodes.length === 0) return undefined;
	const nodeEmbeddings = await getOrEmbedNodeEmbeddings(graph.sessionId, graph.nodes, embeddingConfig);
	if (!nodeEmbeddings) return retrieveTopology(input, graph);
	const queryVector = (await embedTexts(embeddingConfig, [input.query]))?.[0];
	if (!queryVector) return retrieveTopology(input, graph);
	const ranked = graph.nodes.map((node) => ({ node, score: cosineSimilarity(queryVector, nodeEmbeddings.get(node.id) ?? []) })).sort((left, right) => right.score - left.score);
	const candidates = ranked.slice(0, input.candidateNodeLimit);
	const rankedCandidateNodeIds = candidates.map((item) => item.node.id);
	const candidateIds = new Set(rankedCandidateNodeIds);
	const expanded = expandNeighborsLocal(candidateIds, graph, input.expansionHops);
	const scoreById = new Map(ranked.map((item) => [item.node.id, item.score]));
	const selectedNodes = graph.nodes.filter((node) => expanded.has(node.id)).sort((left, right) => (scoreById.get(right.id) ?? 0) - (scoreById.get(left.id) ?? 0)).slice(0, input.outputNodeLimit);
	const selectedNodeIds = selectedNodes.map((node) => node.id);
	const selectedSet = new Set(selectedNodeIds);
	const selectedEdgeIds = graph.edges.filter((edge) => selectedSet.has(edge.sourceNodeId) && selectedSet.has(edge.targetNodeId)).slice(0, input.outputEdgeLimit).map((edge) => edge.id);
	const artifacts = graph.artifacts.filter((artifact) => !artifact.nodeId || selectedSet.has(artifact.nodeId)).slice(0, input.outputArtifactLimit).map((artifact) => ({ kind: artifact.kind, ref: artifact.ref, nodeId: artifact.nodeId, label: artifact.label }));
	return { selectedNodeIds, selectedEdgeIds, candidateNodeIds: rankedCandidateNodeIds, candidateEdgeIds: graph.edges.filter((edge) => candidateIds.has(edge.sourceNodeId) && candidateIds.has(edge.targetNodeId)).map((edge) => edge.id), rankedCandidateNodeIds, candidateNodeCount: candidates.length, ranking: candidates.map((item) => ({ nodeId: item.node.id, score: item.score, reasons: { query: item.score, importance: 0, kind: 0 } })), artifacts, omitted: { nodeCount: Math.max(0, (graph.totalNodes || graph.nodes.length) - selectedNodeIds.length), edgeCount: Math.max(0, graph.edges.length - selectedEdgeIds.length), reason: graph.truncated || graph.nodes.length > input.outputNodeLimit ? "budget" : "none" } };
}

async function retrieveConversationPairsWithEmbeddings(input: Parameters<typeof retrieveConversationPairs>[0], graph: SessionContextGraphResponse, config: EmbeddingConfig): Promise<PairRetrievalResult | undefined> {
	const eligibleNodes = graph.nodes.filter((node) => node.nodeRole === "main" || node.nodeRole === "child");
	const modelIdentity = `${config.model}::${TOPOLOGY_EMBEDDING_RECIPE_VERSION}`;
	const vectors = await getOrEmbedNodeEmbeddings(graph.sessionId, eligibleNodes, config, modelIdentity, buildTopologyEmbeddingDocument);
	if (!vectors) return retrieveConversationPairs(input, graph);
	const queryVector = (await embedTexts(config, [input.query]))?.[0];
	if (!queryVector) return retrieveConversationPairs(input, graph);
	const semanticScores = new Map<string, number>();
	for (const node of eligibleNodes) {
		const vector = vectors.get(node.id);
		if (vector) semanticScores.set(node.id, cosineSimilarity(queryVector, vector));
	}
	return retrieveConversationPairs({ ...input, semanticScores }, graph);
}


export interface StoredQueryTopologyFocusResult {
	focus: string;
	selectedNodeCount?: number;
	selectedEdgeCount?: number;
}

export async function getStoredQueryTopologyFocusResult(input: GetStoredQueryTopologyFocusInput): Promise<StoredQueryTopologyFocusResult> {
	const status = getSessionContextStatus(input.sessionId);
	const limits = input.fullGraph ? FULL_GRAPH_LIMITS : DEFAULT_LIMITS;
	if ((status.extractionSchemaVersion ?? 1) >= 2) {
		const graph = getCompleteSessionContextGraph(input.sessionId);
		if (graph.nodes.length === 0) return { focus: "" };
		const hasV2MainNodes = graph.nodes.some((node) => node.nodeRole === "main" && (node.population === "user" || node.population === "assistant"));
		if (hasV2MainNodes) {
			const pairInput = { sessionId: input.sessionId, query: input.query, candidateMainLimit: limits.candidateNodeLimit, outputNodeLimit: limits.outputNodeLimit, outputEdgeLimit: limits.outputEdgeLimit, outputArtifactLimit: limits.outputArtifactLimit };
			const embeddingConfig = getEmbeddingConfig();
			const retrieved = embeddingConfig ? await retrieveConversationPairsWithEmbeddings(pairInput, graph, embeddingConfig) : retrieveConversationPairs(pairInput, graph);
			if (!retrieved) return { focus: "" };
			let selected = retrieved;
			const config = getTopologyRerankConfig();
			const localTopScore = retrieved.ranking[0]?.score ?? 0;
			if (config.enabled && shouldExternalRerank({ enabled: true, contextPercent: input.contextPercent, candidateNodeCount: retrieved.ranking.length, localTopScore, minContextPercent: config.minContextPercent, minCandidateNodes: config.minCandidateNodes, localConfidenceBelow: config.localConfidenceBelow })) {
				const pairLimit = Math.max(1, Math.floor(limits.outputNodeLimit / 2));
				const childLimit = Math.max(0, limits.outputNodeLimit - pairLimit * 2);
				const request = buildTopologyPairRerankRequest({ query: input.query, graph, local: retrieved, pairLimit, nodeLimit: limits.outputNodeLimit, childLimit });
				let raw: unknown;
				if (config.provider === "http" && config.http.protocol === "siliconflow-rerank") raw = await rerankTopologyPairsWithSiliconflow({ ...config.http, relevanceThreshold: config.http.confidenceThreshold, apiKey: getHttpRerankApiKey(), request });
				else if (config.provider === "model_role") {
					try { raw = await (input.rerankClient ?? DISABLED_RERANK_CLIENT).rerankTopology({ modelRole: config.rerankModelRole, request, timeoutMs: config.timeoutMs }); } catch { raw = undefined; }
				}
				const parsed = parsePairRerankPatch(raw);
				const valid = parsed ? validatePairRerankPatch({ patch: parsed, graph, local: retrieved, pairLimit, nodeLimit: limits.outputNodeLimit, childLimit }) : undefined;
				if (valid) selected = applyPairRerankPatch({ local: retrieved, graph, patch: valid, pairLimit, nodeLimit: limits.outputNodeLimit, childLimit, edgeLimit: limits.outputEdgeLimit, artifactLimit: limits.outputArtifactLimit });
			}
			return {
				focus: renderRetrievedConversationPairsAsFocus(graph, input.sessionId, input.query, selected),
				selectedNodeCount: selected.selectedNodeIds.length,
				selectedEdgeCount: selected.selectedEdgeIds.length,
			};
		}
	}

	const graph = getSessionContextGraph(input.sessionId, input.fullGraph ? 1000 : 500);
	if (graph.nodes.length === 0) return { focus: "" };
	const embeddingConfig = getEmbeddingConfig();
	const input_ = {
		sessionId: input.sessionId,
		query: input.query,
		candidateNodeLimit: limits.candidateNodeLimit,
		expansionHops: limits.expansionHops,
		outputNodeLimit: limits.outputNodeLimit,
		outputEdgeLimit: limits.outputEdgeLimit,
		outputArtifactLimit: limits.outputArtifactLimit,
	};
	const retrieved = embeddingConfig
		? await retrieveTopologyWithEmbeddings(input_, graph, embeddingConfig)
		: retrieveTopology(input_, graph);
	await Bun.sleep(0);
	if (!retrieved) return { focus: "" };

	let selected = retrieved;
	const config = getTopologyRerankConfig();
	const localTopScore = retrieved.ranking[0]?.score ?? 0;
	if (config.enabled && shouldExternalRerank({
		enabled: true,
		contextPercent: input.contextPercent,
		candidateNodeCount: retrieved.candidateNodeCount,
		localTopScore,
		minContextPercent: config.minContextPercent,
		minCandidateNodes: config.minCandidateNodes,
		localConfidenceBelow: config.localConfidenceBelow,
	})) {
		if (config.provider === "http") {
			const httpReranked = await applyHttpRerankIfEnabled({
				query: input.query,
				graph,
				local: retrieved,
				outputNodeLimit: limits.outputNodeLimit,
				outputEdgeLimit: limits.outputEdgeLimit,
				minContextPercent: config.minContextPercent,
				minCandidateNodes: config.minCandidateNodes,
				localConfidenceBelow: config.localConfidenceBelow,
				contextPercent: input.contextPercent,
				httpConfig: { ...config.http, enabled: true },
			});
			if (httpReranked) selected = httpReranked;
		} else {
			const reranked = await rerankTopologyWithExternalApi({
				client: input.rerankClient ?? DISABLED_RERANK_CLIENT,
				modelRole: config.rerankModelRole,
				timeoutMs: config.timeoutMs,
				query: input.query,
				graph,
				local: retrieved,
				outputNodeLimit: limits.outputNodeLimit,
				outputEdgeLimit: limits.outputEdgeLimit,
			});
			if (reranked) selected = reranked;
		}
	}

	return { focus: renderRetrievedTopologyAsFocus(graph, input.sessionId, input.query, selected) };
}

export async function getStoredQueryTopologyFocus(input: GetStoredQueryTopologyFocusInput): Promise<string> {
	return (await getStoredQueryTopologyFocusResult(input)).focus;
}

const SNIPPET_WINDOW = 120;
const SNIPPET_MAX_APPEND = 400;

/**
 * Builds a query-aware body for rendered focus nodes.
 * Keeps compressedBody as the base, then appends a snippet from `body`
 * for query tokens that matched in `body` but are absent from `compressedBody`.
 * Avoids duplicating content already visible in compressedBody.
 */
function buildQueryAwareBody(node: SessionContextNode, queryTokens: string[]): string {
	const base = node.compressedBody.trim();
	let rendered = base;
	if (queryTokens.length > 0 && node.body) {
		const compressedLower = base.toLowerCase();
		const bodyLower = node.body.toLowerCase();
		const missingTokens = queryTokens.filter(
			(token) => !compressedLower.includes(token) && bodyLower.includes(token),
		);
		const snippets: string[] = [];
		let appendedLen = 0;
		for (const token of missingTokens) {
			if (appendedLen >= SNIPPET_MAX_APPEND) break;
			const idx = bodyLower.indexOf(token);
			if (idx < 0) continue;
			const windowBudget = SNIPPET_MAX_APPEND - appendedLen;
			const half = Math.min(SNIPPET_WINDOW, Math.floor((windowBudget - token.length) / 2));
			if (half <= 0) break;
			const start = Math.max(0, idx - half);
			const end = Math.min(node.body.length, idx + token.length + half);
			const snippet = node.body.slice(start, end).trim();
			const prefix = start > 0 ? "…" : "";
			const suffix = end < node.body.length ? "…" : "";
			const piece = `${prefix}${snippet}${suffix}`;
			snippets.push(piece);
			appendedLen += piece.length + 1;
		}
		if (snippets.length > 0) rendered = `${base}${base ? " " : ""}[query match] ${snippets.join(" ")}`;
	}
	return rendered.trim() || node.body.trim() || node.refinedPurpose?.trim() || node.purpose?.trim() || node.title.trim() || node.id;
}

function renderFocusSource(node: SessionContextNode): SessionTopologyFocusSource | undefined {
	if (!node.sourceMessageId && node.sourceTurnIndex === undefined) return undefined;
	return {
		...(node.sourceMessageId ? { messageId: node.sourceMessageId } : {}),
		...(node.sourceTurnIndex !== undefined ? { turnIndex: node.sourceTurnIndex } : {}),
	};
}

function renderV2Node(node: SessionContextNode, queryTokens: string[]): SessionTopologyFocusV2Node {
	const source = renderFocusSource(node);
	return {
		id: node.id,
		...(node.operation ? { operation: node.operation } : {}),
		...(node.operationDetail ? { operationDetail: node.operationDetail } : {}),
		...(node.purpose !== undefined ? { purpose: node.purpose } : {}),
		...(node.purposeSource ? { purposeSource: node.purposeSource } : {}),
		...(node.refinedPurpose ? { refinedPurpose: node.refinedPurpose } : {}),
		body: buildQueryAwareBody(node, queryTokens),
		...(node.status ? { status: node.status } : {}),
		...(source ? { source } : {}),
	};
}

export function renderRetrievedConversationPairsAsFocus(graph: SessionContextGraphResponse, sessionId: string, query: string, retrieved: PairRetrievalResult): string {
	const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
	const pairNodes = new Map<string, SessionContextNode[]>();
	for (const node of graph.nodes) {
		if (!node.pairId) continue;
		const existing = pairNodes.get(node.pairId);
		if (existing) existing.push(node);
		else pairNodes.set(node.pairId, [node]);
	}
	const selectedChildIds = new Set(retrieved.selectedChildIds);
	const selectedNodeIds = new Set(retrieved.selectedNodeIds);
	const queryTokens = [...new Set(tokenize(query))];
	const pairByNodeId = new Map<string, string>();
	const pairs: SessionTopologyFocusV2Pair[] = [];

	for (const pairId of retrieved.selectedPairIds) {
		const nodes = pairNodes.get(pairId) ?? [];
		const user = nodes.find((node) => node.nodeRole === "main" && node.population === "user" && selectedNodeIds.has(node.id));
		if (!user) continue;
		const assistant = nodes.find((node) => node.nodeRole === "main" && node.population === "assistant" && selectedNodeIds.has(node.id));
		const children: SessionTopologyFocusV2Child[] = assistant
			? retrieved.selectedChildIds
				.map((id) => nodeById.get(id))
				.filter((node): node is SessionContextNode => Boolean(node && selectedChildIds.has(node.id) && node.nodeRole === "child" && node.pairId === pairId && node.parentNodeId === assistant.id && node.childType))
				.map((node) => ({ ...renderV2Node(node, queryTokens), childType: node.childType!, ...(node.origin ? { origin: node.origin } : {}) }))
			: [];
		pairByNodeId.set(user.id, pairId);
		if (assistant) pairByNodeId.set(assistant.id, pairId);
		for (const child of children) pairByNodeId.set(child.id, pairId);
		pairs.push({ pairId, user: renderV2Node(user, queryTokens), ...(assistant ? { assistant: renderV2Node(assistant, queryTokens) } : {}), children, artifacts: [] });
	}

	const pairById = new Map(pairs.map((pair) => [pair.pairId, pair]));
	for (const artifact of retrieved.artifacts) {
		const ownerPairId = artifact.nodeId ? pairByNodeId.get(artifact.nodeId) : pairs[0]?.pairId;
		if (!ownerPairId) continue;
		const owner = pairById.get(ownerPairId);
		if (!owner) continue;
		owner.artifacts.push({ kind: artifact.kind as SessionContextArtifact["kind"], ref: artifact.ref, ...(artifact.label ? { label: artifact.label } : {}), ...(artifact.nodeId ? { nodeId: artifact.nodeId } : {}) });
	}

	const eligiblePairCount = new Set(graph.nodes.filter((node) => node.nodeRole === "main" && node.population === "user" && node.pairId).map((node) => node.pairId!)).size;
	const renderedChildCount = pairs.reduce((count, pair) => count + pair.children.length, 0);
	const renderedArtifactCount = pairs.reduce((count, pair) => count + pair.artifacts.length, 0);
	const payload: SessionTopologyFocusPayloadV2 = {
		type: "session_topology_subgraph",
		schemaVersion: 2,
		sessionId,
		query,
		pairs,
		omitted: {
			pairCount: Math.max(retrieved.omitted.pairs, eligiblePairCount - pairs.length),
			childCount: Math.max(retrieved.omitted.children, retrieved.eligibleCounts.children - renderedChildCount),
			artifactCount: Math.max(0, graph.artifacts.length - renderedArtifactCount),
			reason: retrieved.omitted.reason,
		},
	};
	return [
		"Use the following session topology subgraph as source-grounded memory.",
		"Interpretation rules:",
		"1. Each pair preserves a prior user intent and the assistant answer or action that responded to it.",
		"2. Children are observations owned by that pair's assistant response; tests and errors report observed status, not proof of correctness.",
		"3. Artifacts are evidence references owned by the selected node named by nodeId; an unowned legacy artifact appears only on the first pair.",
		"4. Keep pair relationships intact and do not infer claims beyond the bodies, source pointers, child observations, and artifacts shown.",
		"5. If required evidence or detail is absent, say what is missing.",
		"<session_topology_subgraph>",
		JSON.stringify(payload),
		"</session_topology_subgraph>",
	].join("\n");
}

export function renderRetrievedTopologyAsFocus(graph: SessionContextGraphResponse, sessionId: string, query: string, retrieved: RetrievedTopology): string {
	const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
	const edgeById = new Map(graph.edges.map((edge) => [edge.id, edge]));
	const queryTokens = [...new Set(tokenize(query))];
	const nodes = retrieved.selectedNodeIds
		.map((id) => nodeById.get(id))
		.filter((n): n is NonNullable<typeof n> => Boolean(n))
		.map((node) => ({
			id: node.id,
			kind: node.kind,
			title: node.title,
			body: buildQueryAwareBody(node, queryTokens),
			source: {
				messageId: node.sourceMessageId,
				turnIndex: node.sourceTurnIndex,
			},
		}));
	const edges = retrieved.selectedEdgeIds
		.map((id) => edgeById.get(id))
		.filter((e): e is NonNullable<typeof e> => Boolean(e))
		.map((edge) => ({
			sourceNodeId: edge.sourceNodeId,
			relation: edge.relation,
			targetNodeId: edge.targetNodeId,
		}));
	const payload = {
		type: "session_topology_subgraph",
		schemaVersion: 1,
		sessionId,
		query,
		nodes,
		edges,
		artifacts: retrieved.artifacts,
		omitted: retrieved.omitted,
	};
	return [
		"Use the following session topology subgraph as source-grounded memory.",
		"Interpretation rules:",
		"1. Each node is a fact extracted from prior conversation turns.",
		"2. Each edge states a relationship between facts.",
		"3. Prefer connected facts over isolated facts, and prefer resolution/evidence paths over old issue-only nodes.",
		"4. Do not invent facts outside this subgraph. If detail is missing, say what is missing.",
		"<session_topology_subgraph>",
		JSON.stringify(payload),
		"</session_topology_subgraph>",
	].join("\n");
}

/** Default threshold: trigger context replacement when usage exceeds 8% of context window (env-overridable). */
export const CONTEXT_REPLACEMENT_THRESHOLD_PERCENT = Number(process.env.OMP_DECK_TOPOLOGY_COMPACT_THRESHOLD_PERCENT) || 8;

/**
 * Render a context pack as compact focus text for OMP compaction.
 * This text guides the LLM summarizer to preserve key structured information
 * while compacting verbose old transcript away.
 */
export function renderPackAsCompactFocus(pack: SessionContextPackResponse): string {
	const sections: string[] = [];
	if (pack.goals.length > 0) {
		sections.push("Goals: " + pack.goals.map((n) => n.compressedBody).join("; "));
	}
	if (pack.constraints.length > 0) {
		sections.push("Constraints: " + pack.constraints.map((n) => n.compressedBody).join("; "));
	}
	if (pack.decisions.length > 0) {
		sections.push("Decisions: " + pack.decisions.map((n) => n.compressedBody).join("; "));
	}
	if (pack.issues.length > 0) {
		sections.push("Issues: " + pack.issues.map((n) => n.compressedBody).join("; "));
	}
	if (pack.resolutions.length > 0) {
		sections.push("Resolutions: " + pack.resolutions.map((n) => n.compressedBody).join("; "));
	}
	if (pack.evidence.length > 0) {
		sections.push("Evidence: " + pack.evidence.map((n) => n.compressedBody).join("; "));
	}
	const files = pack.artifacts.filter((a) => a.kind === "file").map((a) => a.ref);
	if (files.length > 0) {
		sections.push("Files: " + [...new Set(files)].join(", "));
	}
	if (sections.length === 0) return "";
	return `Preserve these key session facts when summarizing:\n${sections.join("\n")}`;
}

/**
 * Check whether a session should trigger context replacement.
 * Returns true when context usage exceeds the threshold percentage.
 */
export function shouldReplaceContext(
	percent: number | null | undefined,
	thresholdPercent = CONTEXT_REPLACEMENT_THRESHOLD_PERCENT,
): boolean {
	if (percent === null || percent === undefined) return false;
	return percent >= thresholdPercent;
}

/**
 * Check if a session has a built context pack available for replacement.
 */
export function hasSessionContextPack(sessionId: string): boolean {
	const status = getSessionContextStatus(sessionId);
	return status.nodeCount > 0;
}
