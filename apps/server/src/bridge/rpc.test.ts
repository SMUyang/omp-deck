import { describe, expect, test } from "bun:test";

import { buildCreateTransportOptions, buildResumeTransportOptions, buildRpcAutoCompactSendOptions, buildRpcCompactCommand, deriveAutoSessionName, deriveAutoSessionNameFromMessages, resumeCwdFromState, rpcAutoCompactCooldownUntil, runRpcAutoCompactWithLifecycle, shouldSkipRpcAutoCompact, sessionSummaryFromJsonl } from "./rpc.ts";

const SESSION_FILE = "/Users/example/.omp/agent/sessions/-repo/session.jsonl";

describe("RPC compact command", () => {
	test("uses customInstructions for compact focus payloads", () => {
		expect(buildRpcCompactCommand("topology focus")).toEqual({ type: "compact", customInstructions: "topology focus" });
	});
});

describe("RPC auto compact guard", () => {
	test("auto-compact timeout is 90s (LLM-backed, not a local op)", () => {
		expect(buildRpcAutoCompactSendOptions()).toEqual({ timeoutMs: 90_000 });
		expect(buildRpcCompactCommand("topology focus")).toEqual({ type: "compact", customInstructions: "topology focus" });
	});

	test("skips duplicate auto compacts while the remote compact cooldown is active", () => {
		const now = 1_000;
		const until = rpcAutoCompactCooldownUntil(now);
		expect(shouldSkipRpcAutoCompact(until, now + 1)).toBe(true);
		expect(shouldSkipRpcAutoCompact(until, until)).toBe(false);
	});
});

describe("RPC direct auto-compact lifecycle", () => {
	test("emits a canonical start before send and an allowlisted end after success", async () => {
		let resolveSend!: (value: unknown) => void;
		const sendResult = new Promise<unknown>((resolve) => { resolveSend = resolve; });
		const events: Array<Record<string, unknown>> = [];
		let refreshCount = 0;

		const pending = runRpcAutoCompactWithLifecycle({
			send: () => sendResult,
			emit: (event) => events.push(event),
			refresh: async () => { refreshCount += 1; },
		});
		expect(events).toEqual([{ type: "auto_compaction_start", reason: "threshold", action: "context-full" }]);
		resolveSend({
			summary: "full summary",
			shortSummary: "short summary",
			firstKeptEntryId: "entry-1",
			details: { private: "drop" },
			preserveData: { private: "drop" },
		});
		await pending;

		expect(events).toEqual([
			{ type: "auto_compaction_start", reason: "threshold", action: "context-full" },
			{
				type: "auto_compaction_end",
				action: "context-full",
				result: { summary: "full summary", shortSummary: "short summary" },
				aborted: false,
				willRetry: false,
			},
		]);
		expect(refreshCount).toBe(1);
	});

	test("does not release the compact guard until the post-compact refresh completes", async () => {
		let resolveRefresh!: () => void;
		const refreshResult = new Promise<void>((resolve) => { resolveRefresh = resolve; });
		let guardHeld = true;

		const pending = runRpcAutoCompactWithLifecycle({
			send: async () => ({ shortSummary: "done" }),
			emit: () => {},
			refresh: () => refreshResult,
			releaseGuard: () => { guardHeld = false; },
		});
		await Promise.resolve();
		resolveRefresh();
		await pending;
		expect(guardHeld).toBe(false);
	});

	test("retains the compact guard when the post-compact refresh fails", async () => {
		let guardHeld = true;

		await expect(runRpcAutoCompactWithLifecycle({
			send: async () => ({ shortSummary: "done" }),
			emit: () => {},
			refresh: async () => false,
			releaseGuard: () => { guardHeld = false; },
		})).rejects.toThrow("post-compact state refresh failed");
		expect(guardHeld).toBe(true);
	});

	test("emits a balanced bounded error end and rethrows a failed compact", async () => {
		const events: Array<Record<string, unknown>> = [];
		const error = new Error(`compact failed ${"x".repeat(400)}`);

		await expect(runRpcAutoCompactWithLifecycle({
			send: async () => { throw error; },
			emit: (event) => events.push(event),
			refresh: async () => {},
		})).rejects.toBe(error);

		expect(events[0]).toEqual({ type: "auto_compaction_start", reason: "threshold", action: "context-full" });
		expect(events[1]).toMatchObject({
			type: "auto_compaction_end",
			action: "context-full",
			result: undefined,
			aborted: false,
			willRetry: false,
		});
		expect(String(events[1]?.errorMessage).length).toBeLessThanOrEqual(240);
	});
});

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

	test("builds resume transport options with a startup timeout long enough for historical sessions", () => {
		const opts = buildResumeTransportOptions("/usr/local/bin/omp", "/home/user/repo", "/tmp/persisted-s1.jsonl");
		expect(opts.bin).toBe("/usr/local/bin/omp");
		expect(opts.cwd).toBe("/home/user/repo");
		expect(opts.extraArgs?.[0]).toBe("--resume");
		expect(opts.extraArgs?.[1]).toBe("/tmp/persisted-s1.jsonl");
		expect(opts.extraArgs?.[2]).toBe("-e");
		expect(typeof opts.extraArgs?.[3]).toBe("string");
		expect(opts.readyTimeoutMs).toBe(15 * 60 * 1000);
	});

	test("builds create transport options with a 60s startup timeout for slow Windows skill discovery", () => {
		const opts = buildCreateTransportOptions("/usr/local/bin/omp", "/home/user/repo", ["--model", "zai/glm-5.2"]);
		expect(opts.bin).toBe("/usr/local/bin/omp");
		expect(opts.cwd).toBe("/home/user/repo");
		expect(opts.extraArgs?.[0]).toBe("--model");
		expect(opts.extraArgs?.[1]).toBe("zai/glm-5.2");
		expect(opts.extraArgs?.[2]).toBe("-e");
		expect(typeof opts.extraArgs?.[3]).toBe("string");
		expect(opts.readyTimeoutMs).toBe(60_000);
	});

	test("builds resume transport options with a long startup timeout for historical sessions", () => {
		const opts = buildResumeTransportOptions("/usr/local/bin/omp", "/home/user/repo", "/path/to/session.jsonl");
		expect(opts.readyTimeoutMs).toBe(15 * 60 * 1000);
	});
});

describe("RPC auto session naming", () => {
	test("derives a compact first prompt title when RPC mode has no SDK auto title", () => {
		expect(deriveAutoSessionName("Please fix the history sidebar after refresh and explain the cause.")).toBe(
			"Please fix the history sidebar after refresh and explain the cause.",
		);
	});

	test("keeps short non-filler Chinese prompts titleable", () => {
		expect(deriveAutoSessionName("修标题")).toBe("修标题");
	});

	test("skips low-signal first prompts so the next real prompt can name the session", () => {
		expect(deriveAutoSessionName("hi")).toBeUndefined();
	});

	test("derives a title from the first existing user message for resumed unnamed sessions", () => {
		expect(
			deriveAutoSessionNameFromMessages([
				{ role: "assistant", content: "ready" },
				{ role: "user", content: [{ type: "text", text: "修复自动标题" }] },
			] as never),
		).toBe("修复自动标题");
	});
});
