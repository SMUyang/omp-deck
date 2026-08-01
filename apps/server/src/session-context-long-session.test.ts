import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type {
	SessionContextEdge,
	SessionContextGraphResponse,
	SessionContextNode,
	SessionTopologyFocusPayloadV2,
} from "@omp-deck/protocol";

import { ContextEvidenceTracker } from "./context-evidence-tracker.ts";
import { closeDb, openDb } from "./db/index.ts";
import {
	getCompleteSessionContextGraph,
	getNodeEmbeddings,
	getSessionContextGraph,
	replaceSessionContext,
	upsertSessionContextCheckpoint,
} from "./db/session-context.ts";
import { buildConversationTopology } from "./session-context-pairs.ts";
import { normalizeSessionJsonl } from "./session-context-events.ts";
import {
	TOPOLOGY_EMBEDDING_RECIPE_VERSION,
	getStoredQueryTopologyFocus,
	renderRetrievedConversationPairsAsFocus,
} from "./session-context.ts";
import { retrieveConversationPairs, type PairRetrievalResult } from "./session-pair-retrieval.ts";

const SESSION_ID = "frozen-long-session-v2";
const NODE_COUNT = 689;
const EDGE_COUNT = 645;
const NEWER_CHILD_COUNT = 641;
const LEGACY_OUTPUT_NODE_LIMIT = 60;
const SOURCE_HISTORY_ESTIMATE_METHOD = "chars_div_4" as const;
const SOURCE_HISTORY_FILLER_CHUNK = `${"frozen privacy safe benchmark filler ".repeat(1_024)}\n`;
const FORBIDDEN_FOCUS_KEYS = new Set([
	"importance", "weight", "score", "scores", "rank", "confidence", "relevance", "cosine", "bm25",
	"reranker", "rerankReason", "localReason", "candidateDiagnostics", "threshold", "thresholds", "metadata", "refinement",
]);

interface FactSpec {
	id: "F2" | "F3" | "F4" | "F5";
	marker: string;
	request: string;
	answer: string;
	query: string;
	semanticQuery: string;
}

const FACTS: readonly FactSpec[] = [
	{ id: "F2", marker: "F2_OBSOLETE_SCRIPTS_LOCK", request: "Please remove obsolete scripts while keeping supported launch paths.", answer: "Removed obsolete scripts and retained the supported launch paths. F2_OBSOLETE_SCRIPTS_LOCK", query: "remove obsolete scripts F2_OBSOLETE_SCRIPTS_LOCK", semanticQuery: "retire stale launcher files" },
	{ id: "F3", marker: "F3_MODEL_SYNC_LOCK", request: "Please synchronize active models, custom providers, and model roles.", answer: "Synchronized active models, custom providers, and model roles. F3_MODEL_SYNC_LOCK", query: "synchronize active models custom providers model roles F3_MODEL_SYNC_LOCK", semanticQuery: "align provider catalog with assigned model duties" },
	{ id: "F4", marker: "F4_START_MODE_LOCK", request: "Please keep start mode alive after terminal exit.", answer: "Start mode now remains alive after terminal exit. F4_START_MODE_LOCK", query: "keep start mode alive terminal exit F4_START_MODE_LOCK", semanticQuery: "persist background service after shell closes" },
	{ id: "F5", marker: "F5_SETTINGS_SURFACE_LOCK", request: "Please expose thinking level, workspace folder, and all OMP settings.", answer: "Exposed thinking level, workspace folder, and all OMP settings. F5_SETTINGS_SURFACE_LOCK", query: "expose thinking level workspace folder OMP settings F5_SETTINGS_SURFACE_LOCK", semanticQuery: "show reasoning control project directory and complete configuration" },
] as const;

interface FrozenFixture {
	nodes: SessionContextNode[];
	edges: SessionContextEdge[];
	pairIds: string[];
	userIds: string[];
	assistantIds: string[];
	matchingChildIds: string[];
	newerCutoff: string;
}

const tempDirs: string[] = [];
const originalFetch = globalThis.fetch;
const savedEnv = new Map<string, string | undefined>();
const MANAGED_ENV_KEYS = [
	"OMP_DECK_DATA_DIR",
	"OMP_DECK_TOPOLOGY_RERANK_ENABLED",
	"OMP_DECK_TOPOLOGY_EMBEDDING_ENABLED",
	"OMP_DECK_TOPOLOGY_EMBEDDING_BASE_URL",
	"OMP_DECK_TOPOLOGY_EMBEDDING_API_KEY",
	"OMP_DECK_TOPOLOGY_EMBEDDING_MODEL",
	"OMP_DECK_TOPOLOGY_EMBEDDING_ENDPOINT_PATH",
	"OMP_DECK_TOPOLOGY_EMBEDDING_TIMEOUT_MS",
] as const;

function tempDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "session-context-long-session-"));
	tempDirs.push(dir);
	return dir;
}

function timestamp(second: number): string {
	return new Date(Date.UTC(2026, 0, 1, 0, 0, second)).toISOString();
}

function mainNode(fact: FactSpec, population: "user" | "assistant", turnIndex: number): SessionContextNode {
	const pairId = `${SESSION_ID}:pair:${fact.id}`;
	const user = population === "user";
	const body = user ? `${fact.request} ${fact.marker}` : fact.answer;
	return {
		id: `${SESSION_ID}:entry:${fact.id}-${user ? "user" : "assistant"}:message`,
		sessionId: SESSION_ID,
		kind: user ? "goal" : "resolution",
		title: user ? `${fact.id} request` : `${fact.id} answer`,
		body,
		compressedBody: body,
		importance: 0.5,
		createdAt: timestamp(turnIndex),
		sourceMessageId: `${fact.id}-${user ? "user" : "assistant"}`,
		sourceTurnIndex: turnIndex,
		population,
		nodeRole: "main",
		origin: population,
		pairId,
		operation: user ? "request" : "answer",
		operationDetail: user ? `request_${fact.id.toLowerCase()}` : `complete_${fact.id.toLowerCase()}`,
		purpose: body,
		purposeSource: "explicit_text",
		status: "completed",
		metadata: { benchmarkFact: fact.id },
	};
}

function childNode(input: {
	id: string;
	pairId: string;
	assistantId: string;
	childType: NonNullable<SessionContextNode["childType"]>;
	origin: NonNullable<SessionContextNode["origin"]>;
	purpose: string;
	turnIndex: number;
	importance: number;
	createdAt?: string;
	status?: NonNullable<SessionContextNode["status"]>;
}): SessionContextNode {
	return {
		id: input.id,
		sessionId: SESSION_ID,
		kind: input.childType === "error" ? "issue" : input.childType === "task_state" ? "todo_state" : "evidence",
		title: `${input.childType} observation`,
		body: input.purpose,
		compressedBody: input.purpose,
		importance: input.importance,
		createdAt: input.createdAt ?? timestamp(input.turnIndex),
		sourceMessageId: `source-${input.id}`,
		sourceTurnIndex: input.turnIndex,
		population: "assistant",
		nodeRole: "child",
		origin: input.origin,
		childType: input.childType,
		pairId: input.pairId,
		parentNodeId: input.assistantId,
		operation: input.childType === "test" ? "verify" : input.childType === "subagent_result" ? "delegate" : input.childType === "task_state" ? "track" : "observe",
		operationDetail: `${input.childType}_benchmark_observation`,
		purpose: input.purpose,
		purposeSource: "structured_intent",
		status: input.status ?? "completed",
		metadata: { privacySafeFixture: true },
	};
}

function edge(id: string, sourceNodeId: string, targetNodeId: string, relation: SessionContextEdge["relation"], pairId: string): SessionContextEdge {
	return { id, sessionId: SESSION_ID, sourceNodeId, targetNodeId, relation, weight: 1, metadata: { pairId } };
}

function buildFrozenLongSessionFixture(): FrozenFixture {
	const nodes: SessionContextNode[] = [];
	const edges: SessionContextEdge[] = [];
	const pairIds: string[] = [];
	const userIds: string[] = [];
	const assistantIds: string[] = [];
	const matchingChildIds: string[] = [];
	let turnIndex = 1;

	for (const fact of FACTS) {
		const user = mainNode(fact, "user", turnIndex++);
		const assistant = mainNode(fact, "assistant", turnIndex++);
		pairIds.push(user.pairId!);
		userIds.push(user.id);
		assistantIds.push(assistant.id);
		nodes.push(user, assistant);
		edges.push(edge(`${user.pairId}:answers`, assistant.id, user.id, "answers", user.pairId!));
		const typedChildren = [
			["test", "tool", `Targeted test completed for ${fact.marker}`],
			["subagent_result", "subagent", `Reviewer confirmed ${fact.marker}`],
			["task_state", "task", `Task state completed for ${fact.marker}`],
			["tool_evidence", "tool", `Tool evidence recorded for ${fact.marker}`],
		] as const;
		for (const [childType, origin, purpose] of typedChildren) {
			const child = childNode({ id: `${SESSION_ID}:child:${fact.id}:${childType}`, pairId: user.pairId!, assistantId: assistant.id, childType, origin, purpose, turnIndex: turnIndex++, importance: 0.5 });
			nodes.push(child);
			matchingChildIds.push(child.id);
		}
	}

	const firstNewerChildIndex = nodes.length;
	const firstNewerCreatedAt = timestamp(turnIndex);
	for (let index = 0; index < NEWER_CHILD_COUNT; index += 1) {
		const ownerIndex = index % FACTS.length;
		const ownerFact = FACTS[ownerIndex]!;
		const ownerPairId = pairIds[ownerIndex]!;
		const ownerAssistantId = assistantIds[ownerIndex]!;
		const child = childNode({
			id: `${SESSION_ID}:newer-child:${String(index).padStart(3, "0")}`,
			pairId: ownerPairId,
			assistantId: ownerAssistantId,
			childType: index % 17 === 0 ? "error" : "tool_evidence",
			origin: "tool",
			purpose: `Newer deterministic evidence item ${index} for ${ownerFact.id}`,
			turnIndex: turnIndex++,
			importance: 0.85,
			status: index % 17 === 0 ? "failed" : "completed",
		});
		nodes.push(child);
		if (index < NEWER_CHILD_COUNT) edges.push(edge(`${child.id}:depends`, child.id, ownerAssistantId, "depends_on", ownerPairId));
	}

	for (let index = 0; nodes.length < NODE_COUNT; index += 1) {
		const ownerIndex = index % FACTS.length;
		nodes.push(childNode({
			id: `${SESSION_ID}:older-child:${index}`,
			pairId: pairIds[ownerIndex]!,
			assistantId: assistantIds[ownerIndex]!,
			childType: "tool_evidence",
			origin: "tool",
			purpose: `Older deterministic evidence ${index}`,
			turnIndex: turnIndex++,
			createdAt: timestamp(0),
			importance: 0.5,
		}));
	}
	const firstNewerChild = nodes[firstNewerChildIndex];
	if (!firstNewerChild || firstNewerChild.createdAt !== firstNewerCreatedAt) throw new Error("newer child boundary drifted");
	return { nodes, edges, pairIds, userIds, assistantIds, matchingChildIds, newerCutoff: timestamp(firstNewerChild.sourceTurnIndex! - 1) };
}

function buildExtractionJsonl(): string {
	const records: string[] = [];
	let parentId: string | null = null;
	let sequence = 0;
	const append = (record: Record<string, unknown>, id: string): void => {
		records.push(JSON.stringify({ ...record, id, parentId }));
		parentId = id;
	};
	for (const fact of FACTS) {
		const userId = `${fact.id}-jsonl-user`;
		append({ type: "message", timestamp: timestamp(sequence), message: { role: "user", content: [{ type: "text", text: `${fact.request} ${fact.marker}` }], timestamp: Date.parse(timestamp(sequence++)) } }, userId);
		const toolAssistantId = `${fact.id}-jsonl-tools`;
		const calls = [
			{ id: `${fact.id}-test`, name: "bash", arguments: { command: `bun test ${fact.id.toLowerCase()}.test.ts`, purpose: `verify ${fact.marker}` } },
			{ id: `${fact.id}-agent`, name: "agent_team", arguments: { action: "result", id: `${fact.id}-reviewer`, task: `review ${fact.marker}` } },
			{ id: `${fact.id}-task`, name: "task_state", arguments: { id: `${fact.id}-task-id`, text: `track ${fact.marker}`, status: "completed" } },
			{ id: `${fact.id}-tool`, name: "read", arguments: { path: `${fact.id.toLowerCase()}.txt`, purpose: `observe ${fact.marker}` } },
		];
		append({ type: "message", timestamp: timestamp(sequence), message: { role: "assistant", content: calls.map((call) => ({ type: "toolCall", ...call })), stopReason: "toolUse", timestamp: Date.parse(timestamp(sequence++)) } }, toolAssistantId);
		let resultParent = toolAssistantId;
		for (const call of calls) {
			parentId = resultParent;
			const resultId = `${call.id}-result`;
			const isAgent = call.name === "agent_team";
			append({ type: "message", timestamp: timestamp(sequence), message: { role: "toolResult", toolCallId: call.id, toolName: call.name, content: [{ type: "text", text: isAgent ? `Reviewer completed ${fact.marker}` : call.name === "bash" ? `1 pass\n0 fail\n${fact.marker}` : `Recorded deterministic ${call.name} evidence for ${fact.marker}` }], details: isAgent ? { agentId: `${fact.id}-reviewer`, status: "completed", conclusion: `Reviewed ${fact.marker}` } : { exitCode: 0 }, isError: false, timestamp: Date.parse(timestamp(sequence++)) } }, resultId);
			resultParent = resultId;
		}
		append({ type: "message", timestamp: timestamp(sequence), message: { role: "assistant", content: [{ type: "text", text: fact.answer }], stopReason: "stop", timestamp: Date.parse(timestamp(sequence++)) } }, `${fact.id}-jsonl-answer`);
	}
	return records.join("\n");
}

function parseFocus(focus: string): SessionTopologyFocusPayloadV2 {
	const json = focus.match(/<session_topology_subgraph>\n(.+)\n<\/session_topology_subgraph>/)?.[1];
	expect(json).toBeDefined();
	return JSON.parse(json!) as SessionTopologyFocusPayloadV2;
}

function assertNoForbiddenFocusKeys(value: unknown, pathParts: string[] = []): void {
	if (Array.isArray(value)) {
		value.forEach((item, index) => assertNoForbiddenFocusKeys(item, [...pathParts, String(index)]));
		return;
	}
	if (!value || typeof value !== "object") return;
	for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
		expect(FORBIDDEN_FOCUS_KEYS.has(key), `forbidden focus key at ${[...pathParts, key].join(".")}`).toBe(false);
		assertNoForbiddenFocusKeys(child, [...pathParts, key]);
	}
}

function recallAt10(result: PairRetrievalResult | undefined, expectedPairId: string, profile: string, query: string): number {
	expect(result, `${profile}: no retrieval result for ${query}`).toBeDefined();
	return result!.ranking.slice(0, 10).some((item) => item.unitId === expectedPairId) ? 1 : 0;
}

function assertPairAndChildClosure(result: PairRetrievalResult, fixture: FrozenFixture, factIndex: number, profile: string): void {
	const pairId = fixture.pairIds[factIndex]!;
	const userId = fixture.userIds[factIndex]!;
	const assistantId = fixture.assistantIds[factIndex]!;
	expect(result.selectedPairIds, `${profile}: missing pair ${pairId}`).toContain(pairId);
	expect(result.selectedNodeIds, `${profile}: missing user ${userId}`).toContain(userId);
	expect(result.selectedNodeIds, `${profile}: missing assistant ${assistantId}`).toContain(assistantId);
	const ownedChild = result.selectedChildIds.find((id) => id.startsWith(`${SESSION_ID}:child:${FACTS[factIndex]!.id}:`));
	expect(ownedChild, `${profile}: no upward-closed child for ${pairId}`).toBeDefined();
	expect(result.selectedNodeIds).toContain(ownedChild!);
}

async function writeCalibratedSourceHistory(filePath: string, sourcePositions: Map<string, number>): Promise<void> {
	const handle = await fs.promises.open(filePath, "w");
	try {
		for (const fact of FACTS) {
			sourcePositions.set(fact.id, (await handle.stat()).size);
			await handle.write(`${JSON.stringify({ fact: fact.id, marker: fact.marker })}\n`);
		}
		for (let index = 0; index < 124; index += 1) await handle.write(SOURCE_HISTORY_FILLER_CHUNK);
	} finally {
		await handle.close();
	}
}

function estimateSourceHistoryDistanceWithProductionAuthority(text: string, tracker: ContextEvidenceTracker, factId: string): number {
	const expected = Math.ceil(text.length / 4);
	tracker.recordReplacement({ sessionId: `${SESSION_ID}-${factId}`, status: "compact_requested", mechanism: "auto_compact", focusHash: createHash("sha256").update(text).digest("hex"), focusPreview: "privacy-safe source-history distance sample", focusEstimatedTokens: expected });
	const event = tracker.getSessionEvidence(`${SESSION_ID}-${factId}`, 1)[0];
	expect(event?.focusEstimateMethod).toBe(SOURCE_HISTORY_ESTIMATE_METHOD);
	return event!.focusEstimatedTokens;
}

function deterministicVector(text: string): number[] {
	const lower = text.toLowerCase();
	const vector = [0, 0, 0, 0, 0.01];
	for (let index = 0; index < FACTS.length; index += 1) {
		const fact = FACTS[index]!;
		const semanticTerms = fact.semanticQuery.toLowerCase().split(" ");
		if (lower.includes(fact.marker.toLowerCase()) || semanticTerms.filter((term) => lower.includes(term)).length >= 2) vector[index] = 1;
	}
	return vector;
}

beforeAll(() => {
	for (const key of MANAGED_ENV_KEYS) savedEnv.set(key, process.env[key]);
	const dir = tempDir();
	process.env.OMP_DECK_DATA_DIR = dir;
	process.env.OMP_DECK_TOPOLOGY_RERANK_ENABLED = "0";
	for (const key of MANAGED_ENV_KEYS.slice(2)) delete process.env[key];
	openDb({ path: path.join(dir, "deck.db") });
	const fixture = buildFrozenLongSessionFixture();
	replaceSessionContext({ sessionId: SESSION_ID, nodes: fixture.nodes, edges: fixture.edges, artifacts: [] });
	upsertSessionContextCheckpoint({ sessionId: SESSION_ID, sourcePath: path.join(dir, "frozen-session.jsonl"), sourceMtimeMs: 1, sourceSizeBytes: 1, nodeCount: fixture.nodes.length, edgeCount: fixture.edges.length, extractionSchemaVersion: 2, rebuiltAt: "2026-08-01T00:00:00.000Z" });
});

afterEach(() => {
	globalThis.fetch = originalFetch;
	for (const key of MANAGED_ENV_KEYS.slice(2)) delete process.env[key];
});

afterAll(() => {
	closeDb();
	globalThis.fetch = originalFetch;
	for (const key of MANAGED_ENV_KEYS) {
		const value = savedEnv.get(key);
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("frozen privacy-safe long-session regression", () => {
	test("normalizer and conversation extractor preserve F2-F5 pairs and structured child ownership", () => {
		const normalized = normalizeSessionJsonl({ content: buildExtractionJsonl() });
		expect(normalized.diagnostics).toEqual([]);
		const extracted = buildConversationTopology({ sessionId: `${SESSION_ID}-extraction`, events: normalized.activeEvents });
		for (const fact of FACTS) {
			const pairId = `${SESSION_ID}-extraction:pair:${fact.id}-jsonl-user`;
			const user = extracted.nodes.find((node) => node.pairId === pairId && node.population === "user");
			const assistant = extracted.nodes.find((node) => node.pairId === pairId && node.population === "assistant" && node.nodeRole === "main");
			expect(user?.body, `extractor user ${fact.id}`).toContain(fact.marker);
			expect(assistant?.body, `extractor assistant ${fact.id}`).toContain(fact.marker);
			const childTypes = new Set(extracted.nodes.filter((node) => node.pairId === pairId && node.parentNodeId === assistant?.id).map((node) => node.childType));
			expect(childTypes, `extractor children ${fact.id}`).toEqual(new Set(["test", "subagent_result", "task_state", "tool_evidence"]));
		}
	});

	test("persists exactly 689 nodes, 645 edges, and more than 500 strictly newer children", () => {
		const fixture = buildFrozenLongSessionFixture();
		const graph = getCompleteSessionContextGraph(SESSION_ID);
		expect(fixture.nodes).toHaveLength(NODE_COUNT);
		expect(fixture.edges).toHaveLength(EDGE_COUNT);
		expect(graph.nodes).toHaveLength(NODE_COUNT);
		expect(graph.edges).toHaveLength(EDGE_COUNT);
		const newerChildren = graph.nodes.filter((node) => node.nodeRole === "child" && node.createdAt > fixture.newerCutoff);
		expect(newerChildren).toHaveLength(NEWER_CHILD_COUNT);
		expect(newerChildren.length).toBeGreaterThan(500);
		expect(graph.edges.filter((item) => item.relation === "answers")).toHaveLength(FACTS.length);
		expect(graph.edges.filter((item) => item.relation === "depends_on")).toHaveLength(NEWER_CHILD_COUNT);
		for (const child of graph.nodes.filter((node) => node.nodeRole === "child")) {
			const owner = graph.nodes.find((node) => node.id === child.parentNodeId);
			expect(owner?.nodeRole, `owner for ${child.id}`).toBe("main");
			expect(owner?.population, `owner population for ${child.id}`).toBe("assistant");
			expect(owner?.pairId, `owner pair for ${child.id}`).toBe(child.pairId);
		}
	});

	test("proves source-history token distance beyond one million using the production chars_div_4 authority", async () => {
		const sourceFile = path.join(process.env.OMP_DECK_DATA_DIR!, "calibrated-source-history.jsonl");
		const positions = new Map<string, number>();
		await writeCalibratedSourceHistory(sourceFile, positions);
		const size = (await fs.promises.stat(sourceFile)).size;
		const handle = await fs.promises.open(sourceFile, "r");
		const tracker = new ContextEvidenceTracker();
		try {
			for (const fact of FACTS) {
				const start = positions.get(fact.id)!;
				const bytes = Buffer.alloc(size - start);
				await handle.read(bytes, 0, bytes.length, start);
				const sourceHistoryTokenDistance = estimateSourceHistoryDistanceWithProductionAuthority(bytes.toString("utf8"), tracker, fact.id);
				expect(sourceHistoryTokenDistance, `${fact.id} source-history token distance (${SOURCE_HISTORY_ESTIMATE_METHOD})`).toBeGreaterThan(1_000_000);
			}
		} finally {
			await handle.close();
		}
	});

	test("locks the bounded diagnostic failure and complete graph recovery", () => {
		const fixture = buildFrozenLongSessionFixture();
		const bounded = getSessionContextGraph(SESSION_ID, 500);
		const complete = getCompleteSessionContextGraph(SESSION_ID);
		expect(bounded.truncated).toBe(true);
		expect(fixture.userIds.some((id) => !bounded.nodes.some((node) => node.id === id))).toBe(true);
		for (const id of fixture.userIds) expect(complete.nodes.some((node) => node.id === id), `complete graph ${id}`).toBe(true);
	});

	test("local production pair retrieval reaches 4/4 at Recall@10 and renders clean atomic focus v2", async () => {
		const fixture = buildFrozenLongSessionFixture();
		const graph = getCompleteSessionContextGraph(SESSION_ID);
		let recall = 0;
		const eligibilityProbe = retrieveConversationPairs({ sessionId: SESSION_ID, query: FACTS[0]!.query, candidateMainLimit: 100, outputNodeLimit: LEGACY_OUTPUT_NODE_LIMIT, outputEdgeLimit: 18, outputArtifactLimit: 12 }, graph);
		expect(eligibilityProbe?.eligibleCounts.userMain, "local F2-F5 user eligibility").toBe(FACTS.length);
		for (let index = 0; index < FACTS.length; index += 1) {
			const fact = FACTS[index]!;
			const result = retrieveConversationPairs({ sessionId: SESSION_ID, query: fact.query, candidateMainLimit: 100, outputNodeLimit: LEGACY_OUTPUT_NODE_LIMIT, outputEdgeLimit: 18, outputArtifactLimit: 12 }, graph);
			recall += recallAt10(result, fixture.pairIds[index]!, "local", fact.query);
			assertPairAndChildClosure(result!, fixture, index, "local");
			const payload = parseFocus(renderRetrievedConversationPairsAsFocus(graph, SESSION_ID, fact.query, result!));
			expect(payload.schemaVersion).toBe(2);
			const renderedPair = payload.pairs.find((pair) => pair.pairId === fixture.pairIds[index]);
			expect(renderedPair?.user.body).toBeTruthy();
			expect(renderedPair?.assistant?.body).toContain(fact.marker);
			for (const node of [renderedPair?.user, renderedPair?.assistant, ...(renderedPair?.children ?? [])]) {
				expect(node?.source?.messageId, `source message ${fact.id}`).toBeTruthy();
				expect(node?.source?.turnIndex, `source turn ${fact.id}`).toBeNumber();
				expect(node?.status, `status ${fact.id}`).toBeTruthy();
				expect(node?.operation, `operation ${fact.id}`).toBeTruthy();
				expect(node?.purpose, `purpose ${fact.id}`).toBeTruthy();
			}
			for (const marker of [fact.marker]) expect(JSON.stringify(payload), `registered marker ${marker}`).toContain(marker);
			assertNoForbiddenFocusKeys(payload);
		}
		expect(recall, "local aggregate user/complete-pair Recall@10").toBe(4);

		const storedPayload = parseFocus(await getStoredQueryTopologyFocus({ sessionId: SESSION_ID, query: FACTS.map((fact) => fact.query).join(" ") }));
		for (const fact of FACTS) expect(JSON.stringify(storedPayload)).toContain(fact.marker);
		assertNoForbiddenFocusKeys(storedPayload);
	});

	test("deterministic Stella-like embedding profile exercises production semantic scoring and cache identity without HTTP", async () => {
		const fixture = buildFrozenLongSessionFixture();
		process.env.OMP_DECK_TOPOLOGY_EMBEDDING_ENABLED = "1";
		process.env.OMP_DECK_TOPOLOGY_EMBEDDING_BASE_URL = "http://deterministic-embedding.invalid";
		process.env.OMP_DECK_TOPOLOGY_EMBEDDING_API_KEY = "privacy-safe-test-key";
		process.env.OMP_DECK_TOPOLOGY_EMBEDDING_MODEL = "deterministic-stella-like";
		process.env.OMP_DECK_TOPOLOGY_EMBEDDING_ENDPOINT_PATH = "/embeddings";
		process.env.OMP_DECK_TOPOLOGY_EMBEDDING_TIMEOUT_MS = "1000";
		let fetchCalls = 0;
		(globalThis as { fetch: typeof fetch }).fetch = (async (_input: Request | string, init?: RequestInit) => {
			fetchCalls += 1;
			const request = JSON.parse(String(init?.body ?? "{}")) as { input?: string[] };
			const data = (request.input ?? []).map((text, index) => ({ object: "embedding", embedding: deterministicVector(text), index }));
			return new Response(JSON.stringify({ id: "deterministic", object: "list", data, usage: { prompt_tokens: data.length, total_tokens: data.length } }), { headers: { "content-type": "application/json" } });
		}) as typeof fetch;

		let recall = 0;
		for (let index = 0; index < FACTS.length; index += 1) {
			const fact = FACTS[index]!;
			const focus = await getStoredQueryTopologyFocus({ sessionId: SESSION_ID, query: fact.semanticQuery });
			const payload = parseFocus(focus);
			expect(payload.pairs.some((pair) => pair.pairId === fixture.pairIds[index]), `semantic selected ${fact.id}; expected ${fixture.pairIds[index]}`).toBe(true);
			const selected = payload.pairs.slice(0, 10).some((pair) => pair.pairId === fixture.pairIds[index]);
			recall += selected ? 1 : 0;
			const pair = payload.pairs.find((item) => item.pairId === fixture.pairIds[index]);
			expect(pair?.user.id).toBe(fixture.userIds[index]);
			expect(pair?.assistant?.id).toBe(fixture.assistantIds[index]);
			assertNoForbiddenFocusKeys(payload);
		}
		expect(recall, "deterministic Stella-like complete-pair Recall@10").toBe(4);
		expect(fetchCalls).toBeGreaterThan(0);
		const cacheIdentity = `deterministic-stella-like::${TOPOLOGY_EMBEDDING_RECIPE_VERSION}`;
		expect(getNodeEmbeddings(SESSION_ID, cacheIdentity).size).toBe(NODE_COUNT);
		expect(getNodeEmbeddings(SESSION_ID, "deterministic-stella-like").size).toBe(0);
	});
});
