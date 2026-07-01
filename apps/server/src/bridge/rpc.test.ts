import { describe, expect, test } from "bun:test";

import { deriveAutoSessionName, resumeCwdFromState, sessionSummaryFromJsonl } from "./rpc.ts";

const SESSION_FILE = "/Users/example/.omp/agent/sessions/-repo/session.jsonl";

describe("RPC session listing", () => {
	test("reads current title from the mutable title slot", () => {
		const summary = sessionSummaryFromJsonl({
			fullPath: SESSION_FILE,
			content: [
				JSON.stringify({
					type: "title",
					v: 1,
					title: "Current generated title",
					source: "auto",
					updatedAt: "2026-07-01T08:00:00.000Z",
					pad: " ",
				}),
				JSON.stringify({
					type: "session",
					version: 3,
					id: "s1",
					timestamp: "2026-07-01T07:00:00.000Z",
					cwd: "/repo",
					title: "Stale header title",
				}),
				JSON.stringify({ type: "message", message: { role: "user", content: "hello" } }),
			].join("\n"),
			modifiedAt: new Date("2026-07-01T08:01:00.000Z"),
		});

		expect(summary).toEqual({
			id: "s1",
			path: SESSION_FILE,
			cwd: "/repo",
			title: "Current generated title",
			createdAt: "2026-07-01T07:00:00.000Z",
			updatedAt: "2026-07-01T08:01:00.000Z",
			messageCount: 1,
		});
	});

	test("keeps sessions with title slots visible under cwd filtering", () => {
		const summary = sessionSummaryFromJsonl({
			fullPath: SESSION_FILE,
			content: [
				JSON.stringify({ type: "title", v: 1, title: "Visible", updatedAt: "2026-07-01T08:00:00.000Z", pad: " " }),
				JSON.stringify({ type: "session", id: "s2", timestamp: "2026-07-01T07:00:00.000Z", cwd: "/repo" }),
			].join("\n"),
			modifiedAt: new Date("2026-07-01T08:01:00.000Z"),
			cwdFilter: "/repo",
		});

		expect(summary?.id).toBe("s2");
	});

	test("uses the resumed session cwd from state instead of the jsonl path", () => {
		expect(resumeCwdFromState({ cwd: "/repo" }, "/fallback")).toBe("/repo");
	});
});

describe("RPC auto session naming", () => {
	test("derives a compact first prompt title when RPC mode has no SDK auto title", () => {
		expect(deriveAutoSessionName("Please fix the history sidebar after refresh and explain the cause.")).toBe(
			"Please fix the history sidebar after refresh and explain the cause.",
		);
	});

	test("skips low-signal first prompts so the next real prompt can name the session", () => {
		expect(deriveAutoSessionName("hi")).toBeUndefined();
	});
});
