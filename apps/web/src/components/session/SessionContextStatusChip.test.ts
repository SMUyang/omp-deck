import { describe, expect, test } from "bun:test";

import { buildSessionContextStatusLabel } from "./SessionContextStatusChip";

describe("buildSessionContextStatusLabel", () => {
	test("renders not built status", () => {
		expect(buildSessionContextStatusLabel({
			status: { sessionId: "s1", built: false, nodeCount: 0, edgeCount: 0 },
			t: (key) => key,
		})).toBe("sessionContext.sidebarStatus.label · sessionContext.sidebarStatus.notBuilt");
	});

	test("renders built counts", () => {
		expect(buildSessionContextStatusLabel({
			status: { sessionId: "s1", built: true, nodeCount: 12, edgeCount: 3 },
		t: (key, values) => (values ? `${key}:${values.nodes}/${values.edges}` : key),
		})).toBe("sessionContext.sidebarStatus.label · sessionContext.sidebarStatus.counts:12/3");
	});

	test("renders transient states", () => {
		expect(buildSessionContextStatusLabel({ state: "building", t: (key) => key })).toBe("sessionContext.sidebarStatus.label · sessionContext.sidebarStatus.building");
		expect(buildSessionContextStatusLabel({ state: "failed", t: (key) => key })).toBe("sessionContext.sidebarStatus.label · sessionContext.sidebarStatus.failed");
		expect(buildSessionContextStatusLabel({ state: "unavailable", t: (key) => key })).toBe("sessionContext.sidebarStatus.label · sessionContext.sidebarStatus.unavailable");
	});
});
