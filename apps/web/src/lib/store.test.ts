import { describe, expect, test } from "bun:test";

import type { SessionSummary, SessionSnapshot } from "@omp-deck/protocol";
import { applySessionSummarySnapshot } from "./store";

const baseSummary: SessionSummary = {
	id: "s1",
	path: "/tmp/s1.jsonl",
	cwd: "/repo",
	createdAt: "2026-07-01T00:00:00.000Z",
	updatedAt: "2026-07-01T00:00:00.000Z",
	messageCount: 1,
};

const baseSnapshot: SessionSnapshot = {
	sessionId: "s1",
	cwd: "/repo",
	title: undefined,
	isStreaming: false,
	messages: [],
	todoPhases: [],
} as SessionSnapshot & { title?: undefined };

describe("applySessionSummarySnapshot", () => {
	test("updates persisted session title from session_updated snapshots", () => {
		const next = applySessionSummarySnapshot([baseSummary], {
			...baseSnapshot,
			sessionName: "修标题",
		});

		expect(next).toEqual([{ ...baseSummary, title: "修标题" }]);
	});

	test("leaves summaries unchanged when snapshot has no session name", () => {
		const summaries = [baseSummary];
		expect(applySessionSummarySnapshot(summaries, baseSnapshot)).toBe(summaries);
	});
});
