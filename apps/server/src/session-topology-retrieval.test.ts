import { describe, expect, test } from "bun:test";

import { retrieveTopology, type RetrieveTopologyInput } from "./session-topology-retrieval.ts";
import type {
	SessionContextArtifact,
	SessionContextEdge,
	SessionContextGraphResponse,
	SessionContextNode,
} from "@omp-deck/protocol";

function node(id: string, kind: SessionContextNode["kind"], title: string, body: string, importance = 0.5): SessionContextNode {
	return {
		id,
		sessionId: "s1",
		kind,
		title,
		body,
		compressedBody: body,
		importance,
		createdAt: "2026-07-03T00:00:00.000Z",
		sourceMessageId: `m_${id}`,
		sourceTurnIndex: 1,
		metadata: {},
	};
}

function edge(id: string, source: string, target: string, relation: string = "depends_on"): SessionContextEdge {
	return {
		id,
		sessionId: "s1",
		sourceNodeId: source,
		targetNodeId: target,
		relation: relation as SessionContextEdge["relation"],
		weight: 0.5,
		metadata: {},
	};
}

function artifact(id: string, kind: string, ref: string, nodeId?: string, label: string = ""): SessionContextArtifact {
	return {
		id,
		sessionId: "s1",
		kind: kind as SessionContextArtifact["kind"],
		ref,
		label,
		metadata: {},
		...(nodeId ? { nodeId } : {}),
	};
}

function graph(partial: Partial<SessionContextGraphResponse> = {}): SessionContextGraphResponse {
	return {
		sessionId: "s1",
		nodes: [],
		edges: [],
		artifacts: [],
		totalNodes: 0,
		truncated: false,
		...partial,
	};
}

const DEFAULT_INPUT: RetrieveTopologyInput = {
	sessionId: "s1",
	query: "batch legend label",
	candidateNodeLimit: 50,
	expansionHops: 1,
	outputNodeLimit: 10,
	outputEdgeLimit: 18,
	outputArtifactLimit: 12,
};

describe("retrieveTopology", () => {
	test("returns undefined when graph has no nodes", () => {
		expect(retrieveTopology(DEFAULT_INPUT, graph())).toBeUndefined();
	});

	test("ranks query-relevant nodes first", () => {
		const goal = node("n_goal", "goal", "Redraw figure", "non-abbreviated legend labels", 0.4);
		const unrelated = node("n_unrelated", "issue", "Subscription error", "GLM-5V-Turbo not in plan", 0.9);
		const result = retrieveTopology(DEFAULT_INPUT, graph({ nodes: [goal, unrelated] }));
		expect(result?.selectedNodeIds[0]).toBe("n_goal");
	});

	test("expands 1-hop neighbors of top candidates", () => {
		const top = node("n_top", "issue", "batch_display_label missing", "legend labels abbreviated", 0.9);
		const neighbor = node("n_neighbor", "resolution", "batch_display_label implemented", "labels render as Batch 1", 0.5);
		const unrelated = node("n_outside", "issue", "Subscription error", "GLM-5V-Turbo not in plan", 0.9);
		const e1 = edge("e1", "n_top", "n_neighbor", "fixed_by");
		const result = retrieveTopology(DEFAULT_INPUT, graph({
			nodes: [top, neighbor, unrelated],
			edges: [e1],
		}));
		expect(result?.selectedNodeIds).toContain("n_top");
		expect(result?.selectedNodeIds).toContain("n_neighbor");
	});

	test("filters edges to selected nodes only", () => {
		const a = node("a", "goal", "A", "batch display", 0.9);
		const b = node("b", "resolution", "B", "fix", 0.8);
		const c = node("c", "issue", "C", "unrelated", 0.1);
		const result = retrieveTopology(
			{ ...DEFAULT_INPUT, outputNodeLimit: 2 },
			graph({
				nodes: [a, b, c],
				edges: [
					edge("e1", "a", "b", "depends_on"),
					edge("e2", "b", "c", "verified_by"),
				],
			}),
		);
		expect(result?.selectedEdgeIds).toContain("e1");
		expect(result?.selectedEdgeIds).not.toContain("e2");
	});

	test("filters artifacts to selected nodes", () => {
		const a = node("a", "resolution", "A", "fix", 0.9);
		const b = node("b", "issue", "B", "unrelated", 0.1);
		const result = retrieveTopology(
			{ ...DEFAULT_INPUT, outputNodeLimit: 1 },
			graph({
				nodes: [a, b],
				artifacts: [
					artifact("art1", "file", "scripts/foo.py", "a", "scripts/foo.py"),
					artifact("art2", "file", "scripts/other.py", "b", "scripts/other.py"),
					artifact("art3", "test", "tests/test_foo.py"),
				],
			}),
		);
		expect(result?.artifacts.map((art) => art.ref)).toEqual(["scripts/foo.py", "tests/test_foo.py"]);
	});

	test("respects outputNodeLimit, outputEdgeLimit, outputArtifactLimit", () => {
		const manyNodes = Array.from({ length: 20 }, (_, i) => node(`n${i}`, "issue", `Issue ${i}`, `body ${i}`, 0.5 - i * 0.01));
		const manyArtifacts = Array.from({ length: 30 }, (_, i) => artifact(`art${i}`, "file", `f${i}.py`));
		const result = retrieveTopology(
			{ ...DEFAULT_INPUT, query: "", outputNodeLimit: 5, outputEdgeLimit: 2, outputArtifactLimit: 3 },
			graph({ nodes: manyNodes, artifacts: manyArtifacts, totalNodes: 20 }),
		);
		expect(result?.selectedNodeIds.length).toBe(5);
		expect(result?.artifacts.length).toBeLessThanOrEqual(3);
		expect(result?.omitted.nodeCount).toBe(15);
	});

	test("selects nodes by query-relevance score, not graph/DB order", () => {
		const unrelatedFirst = node("n_unrelated", "issue", "Subscription error", "GLM-5V-Turbo not in plan", 0.1);
		const queryMatchSecond = node("n_match", "goal", "batch legend label", "render non-abbreviated legend labels", 0.9);
		const result = retrieveTopology(
			{ ...DEFAULT_INPUT, candidateNodeLimit: 2, outputNodeLimit: 2 },
			graph({ nodes: [unrelatedFirst, queryMatchSecond], totalNodes: 2 }),
		);

		// Score order: n_match has higher query relevance, should come first
		expect(result?.selectedNodeIds).toEqual(["n_match", "n_unrelated"]);
		expect(result?.rankedCandidateNodeIds[0]).toBe("n_match");
		expect(result?.ranking[0]).toEqual(expect.objectContaining({
			nodeId: "n_match",
			reasons: expect.objectContaining({ query: expect.any(Number), importance: expect.any(Number), kind: expect.any(Number) }),
		}));
		expect(result?.candidateNodeCount).toBe(2);
	});

	test("ranks expanded neighbors by query relevance, not DB importance order", () => {
		// seed node matches query → pulls in two neighbors via expansion
		// neighbor A is query-irrelevant but high importance (DB would rank it first)
		// neighbor B is query-relevant but lower importance
		// outputNodeLimit: 2 means only seed + one neighbor fit
		// Bug 1 fix: neighbor B should be selected over neighbor A
		const seed = node("seed", "goal", "batch legend label setup", "matching query", 0.9);
		const neighborIrrelevant = node("n_irrelevant", "resolution", "Database migration complete", "all tables created", 0.95);
		const neighborRelevant = node("n_relevant", "evidence", "batch label evidence", "legend labels match", 0.3);
		const result = retrieveTopology(
			{ ...DEFAULT_INPUT, candidateNodeLimit: 1, outputNodeLimit: 2, expansionHops: 1 },
			graph({
				nodes: [neighborIrrelevant, seed, neighborRelevant],
				edges: [
					edge("e1", "seed", "n_irrelevant", "depends_on"),
					edge("e2", "seed", "n_relevant", "verified_by"),
				],
			}),
		);
		expect(result?.selectedNodeIds).toEqual(["seed", "n_relevant"]);
	});

	test("returns candidate edge ids for trigger/internal metadata", () => {
		const a = node("a", "goal", "batch legend", "display labels", 0.9);
		const b = node("b", "resolution", "labels fixed", "non-abbreviated", 0.8);
		const outside = node("outside", "issue", "unrelated", "billing", 0.1);
		const result = retrieveTopology(
			{ ...DEFAULT_INPUT, candidateNodeLimit: 2, outputNodeLimit: 1, outputEdgeLimit: 1 },
			graph({
				nodes: [a, b, outside],
				edges: [edge("e_ab", "a", "b", "fixed_by"), edge("e_out", "b", "outside", "depends_on")],
			}),
		);

		expect(result?.candidateNodeIds).toEqual(expect.arrayContaining(["a", "b"]));
		expect(result?.candidateEdgeIds).toContain("e_ab");
		expect(result?.candidateEdgeIds).not.toContain("e_out");
	});
});
