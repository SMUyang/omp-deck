import { describe, expect, test } from "bun:test";
import type { SessionContextEdge, SessionContextNode } from "@omp-deck/protocol";

import {
	computeTopologyNodeLayout,
	topologyEdgeStyle,
	topologyNodeDetails,
} from "./TopologyGraph.layout";

const WIDTH = 800;
const HEIGHT = 520;

function node(
	id: string,
	overrides: Partial<SessionContextNode> = {},
): SessionContextNode {
	return {
		id,
		sessionId: "s",
		kind: "evidence",
		title: id,
		body: `${id} body`,
		compressedBody: `${id} compressed`,
		importance: 0.5,
		createdAt: "2026-08-01T00:00:00.000Z",
		metadata: {},
		...overrides,
	};
}

function edge(
	id: string,
	sourceNodeId: string,
	targetNodeId: string,
	relation: SessionContextEdge["relation"],
): SessionContextEdge {
	return {
		id,
		sessionId: "s",
		sourceNodeId,
		targetNodeId,
		relation,
		weight: 0.8,
		metadata: {},
	};
}

function v2Fixture() {
	const nodes = [
		node("user-main", {
			kind: "user_intent",
			population: "user",
			nodeRole: "main",
			origin: "user",
			pairId: "pair-1",
			sourceTurnIndex: 2,
		}),
		node("assistant-main", {
			kind: "resolution",
			population: "assistant",
			nodeRole: "main",
			origin: "assistant",
			pairId: "pair-1",
			sourceTurnIndex: 3,
		}),
		node("test-child", {
			population: "assistant",
			nodeRole: "child",
			origin: "tool",
			childType: "test",
			parentNodeId: "assistant-main",
			sourceTurnIndex: 4,
		}),
		node("task-child", {
			kind: "todo_state",
			population: "assistant",
			nodeRole: "child",
			origin: "task",
			childType: "task_state",
			parentNodeId: "assistant-main",
			sourceTurnIndex: 5,
		}),
	];
	return {
		nodes,
		edges: [edge("answers", "assistant-main", "user-main", "answers")],
	};
}

describe("computeTopologyNodeLayout", () => {
	test("places v2 user and assistant main nodes in distinct population lanes", () => {
		const fixture = v2Fixture();
		const layout = computeTopologyNodeLayout(fixture.nodes, fixture.edges, WIDTH, HEIGHT);
		const user = layout.positions.get("user-main")!;
		const assistant = layout.positions.get("assistant-main")!;

		expect(user.lane).toBe("user");
		expect(assistant.lane).toBe("assistant");
		expect(user.depth).toBe(0);
		expect(assistant.depth).toBe(0);
		expect(user.x).not.toBe(assistant.x);
	});

	test("nests assistant children below their parent deterministically without sibling overlap", () => {
		const fixture = v2Fixture();
		const first = computeTopologyNodeLayout(fixture.nodes, fixture.edges, WIDTH, HEIGHT);
		const second = computeTopologyNodeLayout([...fixture.nodes].reverse(), fixture.edges, WIDTH, HEIGHT);
		const parent = first.positions.get("assistant-main")!;
		const testChild = first.positions.get("test-child")!;
		const taskChild = first.positions.get("task-child")!;

		for (const child of [testChild, taskChild]) {
			expect(child.lane).toBe("assistant");
			expect(child.depth).toBe(1);
			expect(child.parentNodeId).toBe("assistant-main");
			expect(child.y).toBeGreaterThan(parent.y);
			expect(Math.abs(child.x - parent.x)).toBeLessThan(180);
		}
		expect(testChild).not.toEqual(taskChild);
		expect(second.positions.get("test-child")).toEqual(testChild);
		expect(second.positions.get("task-child")).toEqual(taskChild);
	});

	test("places an orphan child in the assistant secondary lane at depth one", () => {
		const orphan = node("orphan", {
			population: "assistant",
			nodeRole: "child",
			origin: "subagent",
			childType: "subagent_result",
			parentNodeId: "missing",
		});
		const layout = computeTopologyNodeLayout([orphan], [], WIDTH, HEIGHT);
		const position = layout.positions.get(orphan.id)!;

		expect(position.lane).toBe("assistant");
		expect(position.depth).toBe(1);
		expect(position.parentNodeId).toBeUndefined();
		expect(position.x).toBeGreaterThan(WIDTH / 2);
	});

	test("packs twelve or more children into stable bounded grid rows", () => {
		const parent = node("assistant-main", {
			population: "assistant",
			nodeRole: "main",
			origin: "assistant",
			sourceTurnIndex: 1,
		});
		const children = Array.from({ length: 14 }, (_, index) => node(`child-${String(index).padStart(2, "0")}`, {
			population: "assistant",
			nodeRole: "child",
			origin: "tool",
			childType: "tool_evidence",
			parentNodeId: parent.id,
			sourceTurnIndex: index + 2,
		}));
		const layout = computeTopologyNodeLayout([parent, ...children], [], WIDTH, HEIGHT);
		const positions = children.map((child) => layout.positions.get(child.id)!);
		const uniqueCoordinates = new Set(positions.map((position) => `${position.x}:${position.y}`));
		const rows = new Set(positions.map((position) => position.y));

		expect(uniqueCoordinates.size).toBe(children.length);
		expect(rows.size).toBeGreaterThan(1);
		for (const position of positions) {
			expect(position.x).toBeGreaterThanOrEqual(18);
			expect(position.x).toBeLessThanOrEqual(WIDTH - 18);
			expect(position.y).toBeGreaterThanOrEqual(18);
			expect(position.y).toBeLessThanOrEqual(HEIGHT - 18);
		}
		const rerun = computeTopologyNodeLayout([parent, ...children].reverse(), [], WIDTH, HEIGHT);
		for (const child of children) {
			expect(rerun.positions.get(child.id)).toEqual(layout.positions.get(child.id));
		}
	});

	test("keeps legacy nodes on deterministic kind-based lanes without v2 fields", () => {
		const legacyNodes = [
			node("goal", { kind: "goal", importance: 0.8 }),
			node("issue", { kind: "issue", importance: 0.2 }),
		];
		const layout = computeTopologyNodeLayout(legacyNodes, [], WIDTH, HEIGHT);

		expect(layout.positions.get("goal")?.lane).toBe("goal");
		expect(layout.positions.get("issue")?.lane).toBe("issue");
		expect(layout.positions.get("goal")?.depth).toBe(0);
		expect(layout.positions.get("issue")?.depth).toBe(0);
		expect(layout.positions.get("goal")?.x).not.toBe(layout.positions.get("issue")?.x);
	});

	test("sorts main nodes stably by source turn, creation time, then id", () => {
		const mains = [
			node("c", { population: "user", nodeRole: "main", sourceTurnIndex: 2, createdAt: "2026-08-01T00:00:02.000Z" }),
			node("b", { population: "user", nodeRole: "main", sourceTurnIndex: 1, createdAt: "2026-08-01T00:00:02.000Z" }),
			node("a", { population: "user", nodeRole: "main", sourceTurnIndex: 1, createdAt: "2026-08-01T00:00:02.000Z" }),
		];
		const layout = computeTopologyNodeLayout(mains, [], WIDTH, HEIGHT);

		expect(layout.positions.get("a")!.y).toBeLessThan(layout.positions.get("b")!.y);
		expect(layout.positions.get("b")!.y).toBeLessThan(layout.positions.get("c")!.y);
	});
});

describe("topologyEdgeStyle", () => {
	test("gives answers an explicit solid high-contrast style distinct from diagnostic relations", () => {
		const answers = topologyEdgeStyle("answers");
		const comparisons = ["verified_by", "depends_on", "supersedes"] as const;

		expect(answers.dash).toBe("0");
		expect(answers.color).toMatch(/accent|ink/);
		expect(answers.width).toBeGreaterThanOrEqual(1.5);
		for (const relation of comparisons) {
			expect(topologyEdgeStyle(relation)).not.toEqual(answers);
		}
	});
});

describe("topologyNodeDetails", () => {
	test("exposes v2 semantics and refinement provenance while omitting absent values", () => {
		const details = topologyNodeDetails(node("child", {
			population: "assistant",
			nodeRole: "child",
			origin: "tool",
			childType: "test",
			operation: "verify",
			operationDetail: "focused web tests",
			purpose: "Check hierarchy",
			refinedPurpose: "Verify hierarchy contracts",
			refinement: { model: "model-x", promptVersion: "topology-v2" },
			status: "completed",
			pairId: "pair-7",
			parentNodeId: "assistant-main",
			sourceTurnIndex: 8,
			importance: 0.74,
		}));
		const byKey = new Map(details.map((detail) => [detail.key, detail]));

		expect([...byKey.keys()]).toEqual([
			"population",
			"nodeRole",
			"origin",
			"childType",
			"operation",
			"operationDetail",
			"purpose",
			"refinedPurpose",
			"refinementProvenance",
			"refinementModel",
			"refinementPromptVersion",
			"status",
			"pairId",
			"parentNodeId",
			"sourceTurnIndex",
			"importance",
		]);
		expect(byKey.get("refinementModel")?.value).toBe("model-x");
		expect(byKey.get("refinementPromptVersion")?.value).toBe("topology-v2");
		expect(byKey.get("refinementProvenance")?.labelKey.toLowerCase()).toContain("provenance");
		expect(details.every((detail) => !detail.labelKey.toLowerCase().includes("confidence"))).toBe(true);
		expect(details.every((detail) => detail.value !== undefined)).toBe(true);
	});

	test("returns only legacy-safe diagnostic fields when v2 semantics are absent", () => {
		const details = topologyNodeDetails(node("legacy", { sourceTurnIndex: undefined }));
		expect(details.map((detail) => detail.key)).toEqual(["importance"]);
	});
});
