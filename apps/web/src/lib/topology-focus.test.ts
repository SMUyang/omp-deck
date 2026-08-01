import { describe, expect, test } from "bun:test";

import {
	latestUserText,
	parseTopologyFocus,
	splitQueryMatch,
} from "./topology-focus";

describe("parseTopologyFocus", () => {
	test("returns null for empty / blank input", () => {
		expect(parseTopologyFocus("")).toBeNull();
		expect(parseTopologyFocus("   \n")).toBeNull();
	});

	test("returns null when tags are missing or inverted", () => {
		expect(parseTopologyFocus("no tags here")).toBeNull();
		expect(parseTopologyFocus("</session_topology_subgraph><session_topology_subgraph>{}")).toBeNull();
	});

	test("returns null for malformed JSON", () => {
		expect(parseTopologyFocus("<session_topology_subgraph>{not json}</session_topology_subgraph>")).toBeNull();
	});

	test("parses a well-formed focus payload", () => {
		const focus =
			"intro line\n" +
			"<session_topology_subgraph>" +
			JSON.stringify({
				type: "session_topology_subgraph",
				schemaVersion: 1,
				sessionId: "s1",
				query: "weather",
				nodes: [
					{ id: "n1", kind: "goal", title: "check weather", body: "ask user city", source: { turnIndex: 0 } },
					{ id: "n2", kind: "decision", title: "use API", body: "OWM", source: { turnIndex: 1 } },
				],
				edges: [{ sourceNodeId: "n1", relation: "verified_by", targetNodeId: "n2" }],
				artifacts: [{ id: "a1" }, { id: "a2" }],
				omitted: { nodeCount: 3, edgeCount: 1, reason: "budget" },
			}) +
			"</session_topology_subgraph>";

		const parsed = parseTopologyFocus(focus);
		expect(parsed).not.toBeNull();
		expect(parsed?.query).toBe("weather");
		expect(parsed?.nodes).toHaveLength(2);
		expect(parsed?.nodes[0]?.kind).toBe("goal");
		expect(parsed?.nodes[0]?.source.turnIndex).toBe(0);
		expect(parsed?.edges).toHaveLength(1);
		expect(parsed?.edges[0]?.relation).toBe("verified_by");
		expect(parsed?.artifactCount).toBe(2);
		expect(parsed?.omittedNodeCount).toBe(3);
	});

	test("drops nodes with invalid id/title, retains valid ones", () => {
		const focus = wrap({
			nodes: [
				{ id: "ok", kind: "goal", title: "good", body: "", source: {} },
				{ id: 42, kind: "goal", title: "bad id" },
				{ id: "noTitle" },
			],
		});
		expect(parseTopologyFocus(focus)?.nodes.map((n) => n.id)).toEqual(["ok"]);
	});

	test("coerces unknown kinds to evidence", () => {
		const focus = wrap({ nodes: [{ id: "n", kind: "unicorn", title: "t", body: "", source: {} }] });
		expect(parseTopologyFocus(focus)?.nodes[0]?.kind).toBe("evidence");
	});

	test("ignores edges with wrong field types", () => {
		const focus = wrap({
			nodes: [{ id: "a", kind: "decision", title: "A", body: "", source: {} }],
			edges: [
				{ sourceNodeId: "a", relation: "depends_on", targetNodeId: "b" },
				{ sourceNodeId: 1, relation: "depends_on", targetNodeId: "b" },
			],
		});
		expect(parseTopologyFocus(focus)?.edges).toHaveLength(1);
	});

	test("parses strict schema-v2 conversation pairs without carrying unknown fields", () => {
		const parsed = parseTopologyFocus(wrap({
			type: "session_topology_subgraph",
			schemaVersion: 2,
			sessionId: "s2",
			query: "launcher",
			pairs: [{
				pairId: "pair-1",
				user: { id: "u1", operation: "request", operationDetail: "start", purpose: "Start deck", purposeSource: "explicit_text", refinedPurpose: "Use production", body: "start mode", status: "completed", source: { messageId: "m1", turnIndex: 1 }, score: 99 },
				assistant: { id: "a1", operation: "answer", body: "production launcher", source: { messageId: "m2" } },
				children: [{ id: "c1", childType: "test", origin: "tool", body: "test passed", status: "completed", source: { turnIndex: 3 }, metadata: { rank: 1 } }],
				artifacts: [{ kind: "test", ref: "bun test", label: "focused", nodeId: "c1", score: 4 }],
			}],
			omitted: { pairCount: 1, childCount: 2, artifactCount: 3, reason: "budget", ranking: [] },
		}));

		expect(parsed).toEqual({
			schemaVersion: 2,
			sessionId: "s2",
			query: "launcher",
			pairs: [{
				pairId: "pair-1",
				user: { id: "u1", operation: "request", operationDetail: "start", purpose: "Start deck", purposeSource: "explicit_text", refinedPurpose: "Use production", body: "start mode", status: "completed", source: { messageId: "m1", turnIndex: 1 } },
				assistant: { id: "a1", operation: "answer", body: "production launcher", source: { messageId: "m2" } },
				children: [{ id: "c1", childType: "test", origin: "tool", body: "test passed", status: "completed", source: { turnIndex: 3 } }],
				artifacts: [{ kind: "test", ref: "bun test", label: "focused", nodeId: "c1" }],
			}],
			omitted: { pairCount: 1, childCount: 2, artifactCount: 3, reason: "budget" },
		});
	});

	test("rejects malformed and unknown schema-v2 payloads without throwing", () => {
		const goodUser = { id: "u1", body: "request" };
		const goodChild = { id: "c1", childType: "test", body: "passed" };
		const cases = [
			{ schemaVersion: 2, sessionId: "s", query: "q", pairs: [{ user: goodUser, children: [], artifacts: [] }], omitted: { pairCount: 0, childCount: 0, artifactCount: 0, reason: "none" } },
			{ schemaVersion: 2, sessionId: "s", query: "q", pairs: [{ pairId: "p", children: [], artifacts: [] }], omitted: { pairCount: 0, childCount: 0, artifactCount: 0, reason: "none" } },
			{ schemaVersion: 2, sessionId: "s", query: "q", pairs: [{ pairId: "p", user: { id: "u1" }, children: [], artifacts: [] }], omitted: { pairCount: 0, childCount: 0, artifactCount: 0, reason: "none" } },
			{ schemaVersion: 2, sessionId: "s", query: "q", pairs: [{ pairId: "p", user: goodUser, children: [{ childType: "test", body: "x" }], artifacts: [] }], omitted: { pairCount: 0, childCount: 0, artifactCount: 0, reason: "none" } },
			{ schemaVersion: 2, sessionId: "s", query: "q", pairs: [{ pairId: "p", user: goodUser, children: [{ id: "c", body: "x" }], artifacts: [] }], omitted: { pairCount: 0, childCount: 0, artifactCount: 0, reason: "none" } },
			{ schemaVersion: 2, sessionId: "s", query: "q", pairs: [{ pairId: "p", user: goodUser, children: [{ id: "c", childType: "test" }], artifacts: [] }], omitted: { pairCount: 0, childCount: 0, artifactCount: 0, reason: "none" } },
			{ schemaVersion: 2, sessionId: "s", query: "q", pairs: "bad", omitted: { pairCount: 0, childCount: 0, artifactCount: 0, reason: "none" } },
			{ schemaVersion: 2, sessionId: "s", query: "q", pairs: [{ pairId: "p", user: goodUser, children: [goodChild], artifacts: "bad" }], omitted: { pairCount: 0, childCount: 0, artifactCount: 0, reason: "none" } },
			{ schemaVersion: 3, sessionId: "s", query: "q", pairs: [] },
		];
		for (const payload of cases) expect(() => parseTopologyFocus(wrap(payload))).not.toThrow();
		for (const payload of cases) expect(parseTopologyFocus(wrap(payload))).toBeNull();
	});
});

describe("latestUserText", () => {
	test("returns last non-empty user message", () => {
		expect(
			latestUserText([
				{ role: "user", text: "first" },
				{ role: "assistant", text: "answer" },
				{ role: "user", text: "  second  " },
			]),
		).toBe("second");
	});

	test("skips empty / whitespace-only user messages", () => {
		expect(
			latestUserText([
				{ role: "user", text: "" },
				{ role: "user", text: "   " },
				{ role: "user", text: "actual" },
			]),
		).toBe("actual");
	});

	test("returns empty when no user message exists", () => {
		expect(latestUserText([{ role: "assistant", text: "x" }])).toBe("");
	});
});

describe("splitQueryMatch", () => {
	test("returns body verbatim when no [query match] marker", () => {
		expect(splitQueryMatch("plain body")).toEqual({ text: "plain body", matches: [] });
	});

	test("splits head and the matched evidence", () => {
		const r = splitQueryMatch("head text [query match] foo bar [query match] baz qux");
		expect(r.text).toBe("head text");
		expect(r.matches).toEqual(["foo bar", "baz qux"]);
	});
});

function wrap(payload: unknown): string {
	return `<session_topology_subgraph>${JSON.stringify(payload)}</session_topology_subgraph>`;
}
