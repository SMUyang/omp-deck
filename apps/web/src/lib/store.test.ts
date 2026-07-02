import { describe, expect, test } from "bun:test";

import type { ListWorkspacesResponse, SessionSummary, SessionSnapshot } from "@omp-deck/protocol";
import { applySessionSummarySnapshot, selectedWorkspaceAfterDelete, workspaceStateFromResponse } from "./store";

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

const workspaceResponse: ListWorkspacesResponse = {
	defaultCwd: "/home/user",
	workspaces: [
		{ id: "w_1", cwd: "/repo", label: "repo", sessionCount: 0, source: "user" },
		{ id: "w_2", cwd: "/other", label: "other", sessionCount: 0, source: "user" },
	],
};

test("workspaceStateFromResponse mirrors workspaces and default cwd", () => {
	expect(workspaceStateFromResponse(workspaceResponse)).toEqual({
		workspaces: workspaceResponse.workspaces,
		defaultCwd: "/home/user",
	});
});

test("selectedWorkspaceAfterDelete clears removed selected cwd", () => {
	const afterDelete = workspaceResponse.workspaces.filter((w) => w.cwd !== "/repo");
	expect(selectedWorkspaceAfterDelete("/repo", afterDelete)).toBe("");
	expect(selectedWorkspaceAfterDelete("/other", afterDelete)).toBe("/other");
});
