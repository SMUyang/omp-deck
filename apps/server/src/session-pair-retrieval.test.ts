import { describe, expect, test } from "bun:test";
import type {
	SessionContextArtifact,
	SessionContextEdge,
	SessionContextGraphResponse,
	SessionContextNode,
} from "@omp-deck/protocol";

import { retrieveConversationPairs, type PairRetrievalInput } from "./session-pair-retrieval.ts";
import { retrieveTopology } from "./session-topology-retrieval.ts";

function mainNode(
	id: string,
	population: "user" | "assistant",
	pairId: string,
	overrides: Partial<SessionContextNode> = {},
): SessionContextNode {
	return {
		id,
		sessionId: "s1",
		kind: population === "user" ? "goal" : "resolution",
		title: id,
		body: id,
		compressedBody: id,
		importance: 0.5,
		createdAt: "2026-07-01T00:00:00.000Z",
		sourceMessageId: id,
		sourceTurnIndex: 1,
		population,
		nodeRole: "main",
		origin: population,
		pairId,
		operation: population === "user" ? "request" : "answer",
		purpose: id,
		purposeSource: "explicit_text",
		status: "completed",
		metadata: {},
		...overrides,
	};
}

function childNode(
	id: string,
	parentNodeId: string,
	pairId: string,
	childType: NonNullable<SessionContextNode["childType"]>,
	overrides: Partial<SessionContextNode> = {},
): SessionContextNode {
	return {
		id,
		sessionId: "s1",
		kind: childType === "error" ? "issue" : "evidence",
		title: id,
		body: id,
		compressedBody: id,
		importance: 0.7,
		createdAt: "2026-07-02T00:00:00.000Z",
		sourceMessageId: id,
		sourceTurnIndex: 2,
		population: "assistant",
		nodeRole: "child",
		origin: childType === "subagent_result" ? "subagent" : childType === "task_state" ? "task" : "tool",
		childType,
		pairId,
		parentNodeId,
		operation: childType === "test" ? "verify" : childType === "subagent_result" ? "delegate" : childType === "task_state" ? "track" : "observe",
		purpose: id,
		purposeSource: "structured_intent",
		status: childType === "error" ? "failed" : "completed",
		metadata: {},
		...overrides,
	};
}

function answers(pairId: string, userId: string, assistantId: string): SessionContextEdge {
	return {
		id: `${pairId}:answers`,
		sessionId: "s1",
		sourceNodeId: assistantId,
		targetNodeId: userId,
		relation: "answers",
		weight: 1,
		metadata: { pairId },
	};
}

function artifact(id: string, ref: string, nodeId?: string): SessionContextArtifact {
	return {
		id,
		sessionId: "s1",
		...(nodeId ? { nodeId } : {}),
		kind: "file",
		ref,
		label: ref,
		metadata: {},
	};
}

function graph(nodes: SessionContextNode[], edges: SessionContextEdge[] = [], artifacts: SessionContextArtifact[] = []): SessionContextGraphResponse {
	return { sessionId: "s1", nodes, edges, artifacts, totalNodes: nodes.length, truncated: false };
}

const INPUT: PairRetrievalInput = {
	sessionId: "s1",
	query: "needle",
	candidateMainLimit: 40,
	outputNodeLimit: 20,
	outputEdgeLimit: 20,
	outputArtifactLimit: 20,
};

function pair(index: number, term: string, overrides: { user?: Partial<SessionContextNode>; assistant?: Partial<SessionContextNode> } = {}) {
	const pairId = `s1:pair:${index}`;
	const user = mainNode(`u${index}`, "user", pairId, { purpose: term, title: `user ${index}`, body: `user ${index}`, compressedBody: `user ${index}`, ...overrides.user });
	const assistant = mainNode(`a${index}`, "assistant", pairId, { purpose: term, title: `assistant ${index}`, body: `assistant ${index}`, compressedBody: `assistant ${index}`, ...overrides.assistant });
	return { pairId, user, assistant, edge: answers(pairId, user.id, assistant.id) };
}

describe("retrieveConversationPairs complete graph retrieval", () => {
	test("RED: legacy bounded top-500 misses an early exact pair while complete pair retrieval selects both endpoints", () => {
		const early = pair(0, "earlyexact");
		const children = Array.from({ length: 600 }, (_, index) => childNode(
			`child-${index}`,
			early.assistant.id,
			early.pairId,
			"tool_evidence",
			{ importance: 1, createdAt: `2026-07-31T00:${String(index % 60).padStart(2, "0")}:00.000Z`, purpose: `newer evidence ${index}` },
		));
		const complete = graph([early.user, early.assistant, ...children], [early.edge]);
		const bounded = graph(children.slice(0, 500));
		const legacy = retrieveTopology({
			sessionId: "s1",
			query: "earlyexact",
			candidateNodeLimit: 100,
			expansionHops: 1,
			outputNodeLimit: 60,
			outputEdgeLimit: 18,
			outputArtifactLimit: 12,
		}, bounded);
		expect(legacy?.selectedNodeIds).not.toContain(early.user.id);

		const result = retrieveConversationPairs({ ...INPUT, query: "earlyexact" }, complete);
		expect(result?.eligibleCounts.userMain).toBe(1);
		expect(result?.selectedPairIds).toContain(early.pairId);
		expect(result?.selectedNodeIds).toEqual(expect.arrayContaining([early.user.id, early.assistant.id]));
	});

	test("recognizes production assistant-to-user answers edges for partner closure and relation ranking", () => {
		const matched = pair(1, "unrelated", { assistant: { purpose: "actualedge", pairId: undefined } });
		const unmatched = pair(2, "unrelated", { assistant: { purpose: "actualedge", pairId: undefined } });
		const result = retrieveConversationPairs(
			{ ...INPUT, query: "actualedge", outputNodeLimit: 2 },
			graph([matched.user, matched.assistant, unmatched.user, unmatched.assistant], [matched.edge]),
		);
		expect(matched.edge.sourceNodeId).toBe(matched.assistant.id);
		expect(matched.edge.targetNodeId).toBe(matched.user.id);
		expect(result?.selectedPairIds[0]).toBe(matched.pairId);
		expect(result?.selectedNodeIds).toEqual([matched.user.id, matched.assistant.id]);
	});

	test("maintains independent qualifying floors for both main populations", () => {
		const pairs = Array.from({ length: 12 }, (_, index) => pair(index, "topology"));
		const result = retrieveConversationPairs(
			{ ...INPUT, query: "topology", candidateMainLimit: 40, outputNodeLimit: 40 },
			graph(pairs.flatMap((item) => [item.user, item.assistant]), pairs.map((item) => item.edge)),
		);
		expect(result?.candidateCounts.userMain).toBeGreaterThanOrEqual(12);
		expect(result?.candidateCounts.assistantMain).toBeGreaterThanOrEqual(12);
	});

	test("spills an unused population reservation to the other population without forcing irrelevant nodes", () => {
		const users = Array.from({ length: 2 }, (_, index) => mainNode(`u${index}`, "user", `pu${index}`, { purpose: "spillterm" }));
		const assistants = Array.from({ length: 20 }, (_, index) => mainNode(`a${index}`, "assistant", `pa${index}`, { purpose: "spillterm" }));
		const irrelevant = Array.from({ length: 20 }, (_, index) => mainNode(`x${index}`, "user", `px${index}`, { purpose: "unrelated" }));
		const result = retrieveConversationPairs(
			{ ...INPUT, query: "spillterm", candidateMainLimit: 16, outputNodeLimit: 16 },
			graph([...users, ...assistants, ...irrelevant]),
		);
		expect(result?.candidateCounts).toEqual({ userMain: 2, assistantMain: 14, children: 0 });
	});

	test("children never consume main candidate floors", () => {
		const pairs = Array.from({ length: 12 }, (_, index) => pair(index, "floorterm"));
		const children = Array.from({ length: 600 }, (_, index) => childNode(`child-${index}`, pairs[0]!.assistant.id, pairs[0]!.pairId, "tool_evidence", { purpose: "floorterm" }));
		const result = retrieveConversationPairs(
			{ ...INPUT, query: "floorterm", candidateMainLimit: 40, outputNodeLimit: 40 },
			graph([...children, ...pairs.flatMap((item) => [item.user, item.assistant])], pairs.map((item) => item.edge)),
		);
		expect(result?.candidateCounts.userMain).toBeGreaterThanOrEqual(12);
		expect(result?.candidateCounts.assistantMain).toBeGreaterThanOrEqual(12);
		expect(result?.eligibleCounts.children).toBe(600);
	});

	test("closes a user-purpose hit to its assistant and an assistant-operation hit to its user", () => {
		const userHit = pair(1, "unrelated", { user: { purpose: "userneedle" }, assistant: { purpose: "answer only" } });
		const assistantHit = pair(2, "unrelated", { user: { purpose: "question only" }, assistant: { purpose: "operationneedle", operationDetail: "operationneedle" } });
		const userResult = retrieveConversationPairs({ ...INPUT, query: "userneedle" }, graph([userHit.user, userHit.assistant], [userHit.edge]));
		const assistantResult = retrieveConversationPairs({ ...INPUT, query: "operationneedle" }, graph([assistantHit.user, assistantHit.assistant], [assistantHit.edge]));
		expect(userResult?.selectedNodeIds).toEqual([userHit.user.id, userHit.assistant.id]);
		expect(assistantResult?.selectedNodeIds).toEqual([assistantHit.user.id, assistantHit.assistant.id]);
	});

	test("keeps an unanswered user as a singleton without fabricating an assistant", () => {
		const user = mainNode("unanswered", "user", "pair-unanswered", { purpose: "lonelyneedle", status: "unknown" });
		const result = retrieveConversationPairs({ ...INPUT, query: "lonelyneedle", outputNodeLimit: 1 }, graph([user]));
		expect(result?.selectedPairIds).toEqual(["pair-unanswered"]);
		expect(result?.selectedNodeIds).toEqual([user.id]);
	});

	test("uses field-aware scoring with refined purpose primary and deterministic purpose fallback", () => {
		const purposePair = pair(1, "other", { user: { purpose: "literalneedle", refinedPurpose: "refined intent" } });
		const bodyPair = pair(2, "other", { user: { body: "literalneedle", compressedBody: "literalneedle" } });
		const result = retrieveConversationPairs(
			{ ...INPUT, query: "literalneedle", outputNodeLimit: 2 },
			graph([purposePair.user, purposePair.assistant, bodyPair.user, bodyPair.assistant], [purposePair.edge, bodyPair.edge]),
		);
		expect(result?.selectedPairIds[0]).toBe(purposePair.pairId);
	});
});

describe("retrieveConversationPairs child closure and bounds", () => {
	test.each([
		["verify", "test"],
		["task", "task_state"],
		["agent", "subagent_result"],
		["failed", "error"],
	] as const)("explicit %s child query closes upward to the complete pair", (query, childType) => {
		const owner = pair(1, "unrelated");
		const child = childNode(`child-${query}`, owner.assistant.id, owner.pairId, childType, { purpose: query, title: query, body: query, compressedBody: query });
		const result = retrieveConversationPairs({ ...INPUT, query }, graph([owner.user, owner.assistant, child], [owner.edge]));
		expect(result?.selectedChildIds).toContain(child.id);
		expect(result?.selectedNodeIds).toEqual(expect.arrayContaining([owner.user.id, owner.assistant.id, child.id]));
	});

	test.each([
		["tests", "test"], ["verification", "test"], ["build", "test"], ["测试", "test"], ["验证", "test"], ["构建", "test"],
		["todo", "task_state"], ["任务", "task_state"], ["待办", "task_state"],
		["subagent", "subagent_result"], ["scout", "subagent_result"], ["reviewer", "subagent_result"], ["子代理", "subagent_result"], ["代理", "subagent_result"],
		["error", "error"], ["failure", "error"], ["blocked", "error"], ["abort", "error"], ["错误", "error"], ["失败", "error"], ["阻塞", "error"], ["中止", "error"],
	] as const)("recognizes fixed explicit child-intent token %s", (query, childType) => {
		const owner = pair(1, "unrelated");
		const child = childNode(`child-${query}`, owner.assistant.id, owner.pairId, childType, { purpose: query });
		const result = retrieveConversationPairs({ ...INPUT, query }, graph([owner.user, owner.assistant, child], [owner.edge]));
		expect(result?.selectedChildIds).toContain(child.id);
	});

	test("defaults to five children per assistant and two per type", () => {
		const owner = pair(1, "pairneedle");
		const children = [
			...Array.from({ length: 4 }, (_, index) => childNode(`test-${index}`, owner.assistant.id, owner.pairId, "test")),
			childNode("error", owner.assistant.id, owner.pairId, "error"),
			childNode("subagent", owner.assistant.id, owner.pairId, "subagent_result"),
			childNode("task", owner.assistant.id, owner.pairId, "task_state"),
			childNode("tool", owner.assistant.id, owner.pairId, "tool_evidence"),
		];
		const result = retrieveConversationPairs({ ...INPUT, query: "pairneedle", outputNodeLimit: 20 }, graph([owner.user, owner.assistant, ...children], [owner.edge]));
		expect(result?.selectedChildIds).toHaveLength(5);
		expect(result?.selectedChildIds.filter((id) => id.startsWith("test-"))).toHaveLength(2);
	});

	test("explicit child query raises the per-assistant limit to eight and lets direct matches exceed the type cap", () => {
		const owner = pair(1, "unrelated");
		const children = Array.from({ length: 10 }, (_, index) => childNode(`test-${index}`, owner.assistant.id, owner.pairId, "test", { purpose: `test direct ${index}` }));
		const result = retrieveConversationPairs({ ...INPUT, query: "test", outputNodeLimit: 20 }, graph([owner.user, owner.assistant, ...children], [owner.edge]));
		expect(result?.selectedChildIds).toHaveLength(8);
	});

	test("orders children by direct match, failure, test, subagent, task, then other tool", () => {
		const owner = pair(1, "priorityneedle");
		const children = [
			childNode("other", owner.assistant.id, owner.pairId, "tool_evidence"),
			childNode("task", owner.assistant.id, owner.pairId, "task_state"),
			childNode("subagent", owner.assistant.id, owner.pairId, "subagent_result"),
			childNode("test", owner.assistant.id, owner.pairId, "test"),
			childNode("failed", owner.assistant.id, owner.pairId, "tool_evidence", { status: "failed" }),
			childNode("direct", owner.assistant.id, owner.pairId, "tool_evidence", { purpose: "priorityneedle" }),
		];
		const result = retrieveConversationPairs({ ...INPUT, query: "priorityneedle", outputNodeLimit: 7 }, graph([owner.user, owner.assistant, ...children], [owner.edge]));
		expect(result?.selectedChildIds).toEqual(["direct", "failed", "test", "subagent", "task"]);
	});
});

describe("retrieveConversationPairs integrity and ownership", () => {
	test("drops a complete pair when its two-node cost cannot fit", () => {
		const owner = pair(1, "needle");
		const result = retrieveConversationPairs({ ...INPUT, outputNodeLimit: 1 }, graph([owner.user, owner.assistant], [owner.edge]));
		expect(result?.selectedNodeIds).toEqual([]);
		expect(result?.selectedPairIds).toEqual([]);
	});

	test("drops an explicit child closure when pair plus child cannot fit", () => {
		const owner = pair(1, "unrelated");
		const child = childNode("test-child", owner.assistant.id, owner.pairId, "test", { purpose: "test" });
		const result = retrieveConversationPairs({ ...INPUT, query: "test", outputNodeLimit: 2 }, graph([owner.user, owner.assistant, child], [owner.edge]));
		expect(result?.selectedNodeIds).toEqual([]);
	});

	test("never emits orphan children, half-pair edges, or artifacts owned by omitted nodes", () => {
		const kept = pair(1, "needle");
		const omitted = pair(2, "needle");
		const keptChild = childNode("kept-child", kept.assistant.id, kept.pairId, "test");
		const omittedChild = childNode("omitted-child", omitted.assistant.id, omitted.pairId, "test");
		const crossEdge: SessionContextEdge = { id: "cross", sessionId: "s1", sourceNodeId: keptChild.id, targetNodeId: omittedChild.id, relation: "depends_on", weight: 0.5, metadata: {} };
		const result = retrieveConversationPairs(
			{ ...INPUT, outputNodeLimit: 3 },
			graph(
				[kept.user, kept.assistant, keptChild, omitted.user, omitted.assistant, omittedChild],
				[kept.edge, omitted.edge, crossEdge],
				[artifact("kept-art", "kept.txt", keptChild.id), artifact("omitted-art", "omitted.txt", omittedChild.id), artifact("pair-art", "pair.txt")],
			),
		);
		expect(result?.selectedNodeIds).toEqual([kept.user.id, kept.assistant.id, keptChild.id]);
		expect(result?.selectedEdgeIds).toEqual([kept.edge.id]);
		expect(result?.artifacts.map((item) => item.ref)).toEqual(["kept.txt", "pair.txt"]);
	});

	test("query score dominates importance and recency without a pre-cut", () => {
		const exact = pair(1, "rareexact", { user: { importance: 0, createdAt: "2020-01-01T00:00:00.000Z" }, assistant: { importance: 0 } });
		const noisy = Array.from({ length: 1000 }, (_, index) => mainNode(`noise-${index}`, "assistant", `noise-pair-${index}`, { importance: 1, createdAt: "2026-08-01T00:00:00.000Z", purpose: "generic noise" }));
		const result = retrieveConversationPairs({ ...INPUT, query: "rareexact", candidateMainLimit: 8, outputNodeLimit: 2 }, graph([...noisy, exact.user, exact.assistant], [exact.edge]));
		expect(result?.selectedNodeIds).toEqual([exact.user.id, exact.assistant.id]);
		expect(result?.ranking[0]?.score).toBeFinite();
	});

	test("RED: exact lexical purpose survives adversarial semantic scores", () => {
		const exact = pair(1, "rareexact");
		const adversarial = pair(2, "unrelated");
		const semanticScores = new Map([[exact.user.id, 0], [exact.assistant.id, 0], [adversarial.user.id, 1], [adversarial.assistant.id, 1]]);
		const result = retrieveConversationPairs({ ...INPUT, query: "rareexact", candidateMainLimit: 2, outputNodeLimit: 2, semanticScores }, graph([exact.user, exact.assistant, adversarial.user, adversarial.assistant], [exact.edge, adversarial.edge]));
		expect(result?.selectedPairIds).toEqual([exact.pairId]);
	});

	test("RED: semantic-only paraphrase promotes the matching pair", () => {
		const matching = pair(1, "keep the daemon alive after the shell exits");
		const unrelated = pair(2, "change the chart colors");
		const semanticScores = new Map([[matching.user.id, 0.95], [matching.assistant.id, 0.9], [unrelated.user.id, 0.1], [unrelated.assistant.id, 0.1]]);
		const result = retrieveConversationPairs({ ...INPUT, query: "persist background service", candidateMainLimit: 2, outputNodeLimit: 2, semanticScores }, graph([matching.user, matching.assistant, unrelated.user, unrelated.assistant], [matching.edge, unrelated.edge]));
		expect(result?.selectedPairIds).toEqual([matching.pairId]);
	});
});
