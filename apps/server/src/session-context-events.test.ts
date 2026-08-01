import { describe, expect, test } from "bun:test";

import {
	normalizeSessionEventTimestamp,
	normalizeSessionJsonl,
} from "./session-context-events.ts";

function jsonl(records: unknown[]): string {
	return records.map((record) => typeof record === "string" ? record : JSON.stringify(record)).join("\n");
}

const t0 = "2026-07-31T10:00:00.000Z";
const t1 = "2026-07-31T10:00:01.000Z";
const t2 = "2026-07-31T10:00:02.000Z";
const t3 = "2026-07-31T10:00:03.000Z";
const t4 = "2026-07-31T10:00:04.000Z";

function userEntry(id: string, parentId: string | null, text: string, timestamp = t1): Record<string, unknown> {
	return {
		type: "message",
		id,
		parentId,
		timestamp,
		message: {
			role: "user",
			content: [{ type: "text", text }],
			timestamp: Date.parse(timestamp),
		},
	};
}

function assistantEntry(id: string, parentId: string | null, text: string, timestamp = t2): Record<string, unknown> {
	return {
		type: "message",
		id,
		parentId,
		timestamp,
		message: {
			role: "assistant",
			content: [{ type: "text", text }],
			stopReason: "stop",
			timestamp: Date.parse(timestamp),
		},
	};
}

describe("normalizeSessionJsonl active branch", () => {
	test("selects the last valid ID entry as leaf and excludes an abandoned physical sibling branch", () => {
		const content = jsonl([
			userEntry("root", null, "root", t0),
			assistantEntry("abandoned-a", "root", "abandoned answer", t1),
			userEntry("abandoned-u", "abandoned-a", "abandoned follow-up", t2),
			assistantEntry("active-a", "root", "active answer", t3),
			userEntry("active-leaf", "active-a", "active follow-up", t4),
			{ type: "custom", parentId: "active-leaf", timestamp: "2026-07-31T10:00:05.000Z", customType: "trailing_without_id", data: { ignoredAsLeaf: true } },
		]);

		const result = normalizeSessionJsonl({ content });

		expect(result.activeEvents.map((event) => event.entryId)).toEqual(["root", "active-a", "active-leaf"]);
		expect(result.activeEvents.map((event) => event.text)).toEqual(["root", "active answer", "active follow-up"]);
		expect(result.diagnostics).toEqual([]);
	});

	test("stops at a missing parent and returns only the reachable root-to-leaf suffix", () => {
		const content = jsonl([
			userEntry("abandoned", null, "do not scan me", t0),
			userEntry("reachable", "missing-parent", "reachable", t1),
			assistantEntry("leaf", "reachable", "leaf", t2),
		]);

		const result = normalizeSessionJsonl({ content });

		expect(result.activeEvents.map((event) => event.entryId)).toEqual(["reachable", "leaf"]);
		expect(result.diagnostics).toContainEqual({ line: 2, code: "missing_parent" });
	});

	test("stops deterministically on a parent cycle", () => {
		const content = jsonl([
			userEntry("a", "b", "a", t0),
			assistantEntry("b", "a", "b", t1),
		]);

		const result = normalizeSessionJsonl({ content });

		expect(result.activeEvents.map((event) => event.entryId)).toEqual(["a", "b"]);
		expect(result.diagnostics).toContainEqual({ line: 2, code: "parent_cycle" });
	});

	test("reports a malformed line without changing explicit IDs of other events", () => {
		const content = [
			JSON.stringify(userEntry("u-stable", null, "hello", t0)),
			"{malformed",
			JSON.stringify(assistantEntry("a-stable", "u-stable", "world", t1)),
		].join("\n");

		const first = normalizeSessionJsonl({ content });
		const second = normalizeSessionJsonl({ content });

		expect(first.activeEvents.map((event) => event.entryId)).toEqual(["u-stable", "a-stable"]);
		expect(second.activeEvents.map((event) => event.entryId)).toEqual(["u-stable", "a-stable"]);
		expect(first.diagnostics).toContainEqual({ line: 2, code: "malformed_json" });
	});

	test("assigns a stable canonical-JSON fallback ID to an entry without an ID", () => {
		const root = {
			message: { timestamp: Date.parse(t0), content: [{ text: "fallback", type: "text" }], role: "user" },
			timestamp: t0,
			parentId: null,
			type: "message",
		};
		const fallbackId = "line-1-712bbc8b5b9e8226";
		const leaf = assistantEntry("leaf", fallbackId, "done", t1);
		const content = jsonl([root, leaf]);

		const first = normalizeSessionJsonl({ content });
		const second = normalizeSessionJsonl({ content });

		expect(first.activeEvents.map((event) => event.entryId)).toEqual([fallbackId, "leaf"]);
		expect(second.activeEvents.map((event) => event.entryId)).toEqual([fallbackId, "leaf"]);
	});
});

describe("normalizeSessionJsonl roles and message envelopes", () => {
	test("retains only a genuine user as role=user and synthetic=false", () => {
		const result = normalizeSessionJsonl({ content: jsonl([userEntry("u1", null, "human")]) });

		expect(result.activeEvents[0]).toMatchObject({ role: "user", synthetic: false, text: "human" });
	});

	test("maps synthetic and agent-attributed user messages to synthetic system events", () => {
		const synthetic = userEntry("synthetic", null, "continue");
		(synthetic.message as Record<string, unknown>).synthetic = true;
		const attributed = userEntry("agent-user", "synthetic", "machine continuation", t2);
		(attributed.message as Record<string, unknown>).attribution = "agent";

		const result = normalizeSessionJsonl({ content: jsonl([synthetic, attributed]) });

		expect(result.activeEvents.map((event) => ({ role: event.role, synthetic: event.synthetic }))).toEqual([
			{ role: "system", synthetic: true },
			{ role: "system", synthetic: true },
		]);
		expect(result.activeEvents.some((event) => event.role === "user")).toBe(false);
	});

	test("normalizes developer, system, advisor, custom, and control entries without genuine user roles", () => {
		const records = [
			{
				type: "message", id: "developer", parentId: null, timestamp: t0,
				message: { role: "developer", content: "developer instruction", timestamp: Date.parse(t0) },
			},
			{
				type: "message", id: "system", parentId: "developer", timestamp: t1,
				message: { role: "system", content: [{ type: "text", text: "system notice" }], timestamp: Date.parse(t1) },
			},
			{
				type: "message", id: "advisor", parentId: "system", timestamp: t2,
				message: { role: "advisor", content: [{ type: "text", text: "advice" }], timestamp: Date.parse(t2) },
			},
			{
				type: "custom_message", id: "custom-message", parentId: "advisor", timestamp: t3,
				customType: "topology_context", content: [{ type: "text", text: "custom context" }], display: false, attribution: "agent",
			},
			{
				type: "mode_change", id: "control", parentId: "custom-message", timestamp: t4, mode: "plan",
			},
		];

		const result = normalizeSessionJsonl({ content: jsonl(records) });

		expect(result.activeEvents.map((event) => event.role)).toEqual(["system", "system", "system", "system", "system"]);
		expect(result.activeEvents[3]).toMatchObject({ customType: "topology_context", text: "custom context" });
		expect(result.activeEvents.some((event) => event.role === "user")).toBe(false);
	});

	test("preserves assistant stop reason, text blocks, and every exact tool call while excluding thinking", () => {
		const record = {
			type: "message",
			id: "assistant-tools",
			parentId: null,
			timestamp: t0,
			message: {
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "private chain" },
					{ type: "text", text: "First" },
					{ type: "redactedThinking", data: "encrypted" },
					{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "a.ts" }, intent: "inspect source" },
					{ type: "text", text: "Second" },
					{ type: "toolCall", id: "call-2", name: "bash", arguments: { command: "bun test" } },
				],
				stopReason: "toolUse",
				timestamp: Date.parse(t0),
			},
		};

		const result = normalizeSessionJsonl({ content: jsonl([record]) });
		const event = result.activeEvents[0]!;

		expect(event.text).toBe("FirstSecond");
		expect(event.text).not.toContain("private chain");
		expect(event.text).not.toContain("encrypted");
		expect(event.stopReason).toBe("toolUse");
		expect(event.toolCalls).toEqual([
			{
				id: "call-1",
				name: "read",
				arguments: { path: "a.ts" },
				intent: "inspect source",
				sourceEntryId: "assistant-tools",
				sourceLine: 1,
				lifecycleMetadata: {},
			},
			{
				id: "call-2",
				name: "bash",
				arguments: { command: "bun test" },
				sourceEntryId: "assistant-tools",
				sourceLine: 1,
				lifecycleMetadata: {},
			},
		]);
	});
});

describe("normalizeSessionJsonl tool lifecycle", () => {
	test("enriches only an exact matching call with lifecycle start metadata", () => {
		const assistant = {
			type: "message", id: "a1", parentId: null, timestamp: t0,
			message: {
				role: "assistant",
				content: [
					{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "one" } },
					{ type: "toolCall", id: "call-2", name: "read", arguments: { path: "two" } },
				],
				stopReason: "toolUse", timestamp: Date.parse(t0),
			},
		};
		const start = {
			type: "custom", id: "start-2", parentId: "a1", timestamp: t1, customType: "tool_execution_start",
			data: { toolCallId: "call-2", toolName: "read", startedAt: t1, metadata: { spanId: "span-2", attempt: 1 } },
		};

		const result = normalizeSessionJsonl({ content: jsonl([assistant, start]) });
		const calls = result.activeEvents[0]!.toolCalls;

		expect(calls[0]).toMatchObject({ id: "call-1", lifecycleMetadata: {} });
		expect(calls[0]!.lifecycleStartedAt).toBeUndefined();
		expect(calls[1]).toMatchObject({ id: "call-2", lifecycleStartedAt: t1, lifecycleMetadata: { spanId: "span-2", attempt: 1 } });
		expect(result.activeEvents[1]).toMatchObject({ role: "system", customType: "tool_execution_start", metadata: { lifecycleMatched: true } });
	});

	test("does not use proximity or tool-name fallback for an orphan lifecycle start", () => {
		const assistant = {
			type: "message", id: "a1", parentId: null, timestamp: t0,
			message: {
				role: "assistant", content: [{ type: "toolCall", id: "real-id", name: "read", arguments: {} }],
				stopReason: "toolUse", timestamp: Date.parse(t0),
			},
		};
		const orphan = {
			type: "custom", id: "orphan", parentId: "a1", timestamp: t1, customType: "tool_execution_start",
			data: { toolCallId: "missing-id", toolName: "read", metadata: { sequence: 2 } },
		};

		const result = normalizeSessionJsonl({ content: jsonl([assistant, orphan]) });

		expect(result.activeEvents[0]!.toolCalls[0]!.lifecycleStartedAt).toBeUndefined();
		expect(result.activeEvents.flatMap((event) => event.toolCalls).map((call) => call.id)).toEqual(["real-id"]);
		expect(result.activeEvents[1]).toMatchObject({
			role: "system",
			customType: "tool_execution_start",
			metadata: { lifecycleMatched: false, orphanToolCallId: "missing-id" },
		});
		expect(result.diagnostics).toContainEqual({ line: 2, code: "orphan_tool_lifecycle" });
	});

	test("preserves exact tool result fields and enriches only the exact result ID with lifecycle end", () => {
		const resultMessage = {
			type: "message", id: "result-entry", parentId: null, timestamp: t0,
			message: {
				role: "toolResult",
				toolCallId: "call-2",
				toolName: "bash",
				content: [{ type: "text", text: "2 pass" }, { type: "text", text: "\n0 fail" }],
				details: { exitCode: 0, signal: null },
				isError: false,
				prunedAt: Date.parse(t2),
				timestamp: Date.parse(t0),
			},
		};
		const end = {
			type: "custom", id: "end-2", parentId: "result-entry", timestamp: t1, customType: "tool_execution_end",
			data: { toolCallId: "call-2", toolName: "bash", endedAt: t1, metadata: { durationMs: 900, transport: "local" } },
		};

		const result = normalizeSessionJsonl({ content: jsonl([resultMessage, end]) });
		const toolResult = result.activeEvents[0]!.toolResult;

		expect(toolResult).toEqual({
			toolCallId: "call-2",
			toolName: "bash",
			text: "2 pass\n0 fail",
			details: { exitCode: 0, signal: null },
			isError: false,
			prunedAt: t2,
			sourceEntryId: "result-entry",
			sourceLine: 1,
			lifecycleEndedAt: t1,
			metadata: { messageRole: "toolResult", lifecycle: { durationMs: 900, transport: "local" } },
		});
		expect(result.activeEvents[1]).toMatchObject({ metadata: { lifecycleMatched: true } });
	});

	test("normalizes legacy role=tool as a deterministic orphan result without proximity pairing", () => {
		const legacy = {
			type: "message", id: "legacy-tool", parentId: null, timestamp: t0,
			message: {
				role: "tool", toolCallId: "legacy-call", toolName: "grep",
				content: [{ type: "text", text: "match" }], details: { count: 1 }, isError: true,
				timestamp: Date.parse(t0),
			},
		};

		const first = normalizeSessionJsonl({ content: jsonl([legacy]) });
		const second = normalizeSessionJsonl({ content: jsonl([legacy]) });

		expect(first.activeEvents[0]).toMatchObject({
			role: "tool",
			toolResult: {
				toolCallId: "legacy-call", toolName: "grep", text: "match", details: { count: 1 }, isError: true,
				sourceEntryId: "legacy-tool", sourceLine: 1, metadata: { messageRole: "tool", legacyRole: true, orphan: true },
			},
		});
		expect(second.activeEvents[0]!.toolResult).toEqual(first.activeEvents[0]!.toolResult);
	});
});

describe("normalizeSessionEventTimestamp", () => {
	test("keeps valid record ISO as authority and records a differing valid SDK millisecond timestamp", () => {
		const sdkTimestamp = Date.parse(t2);
		const result = normalizeSessionEventTimestamp({ recordTimestamp: t1, sdkTimestamp });

		expect(result).toEqual({
			sourceTimestamp: t1,
			sdkTimestampMs: sdkTimestamp,
			metadata: { timestampMismatch: true, sdkTimestampIso: t2 },
			diagnosticCodes: [],
		});
	});

	test("falls back from malformed ISO to canonical SDK millisecond ISO", () => {
		const result = normalizeSessionEventTimestamp({ recordTimestamp: "not-iso", sdkTimestamp: Date.parse(t2) });

		expect(result).toEqual({
			sourceTimestamp: t2,
			sdkTimestampMs: Date.parse(t2),
			metadata: { recordTimestampInvalid: true },
			diagnosticCodes: ["invalid_record_timestamp"],
		});
	});

	test("rejects seconds-like numeric timestamps instead of guessing milliseconds", () => {
		const result = normalizeSessionEventTimestamp({ recordTimestamp: undefined, sdkTimestamp: 1_722_422_402 });

		expect(result.sourceTimestamp).toBeUndefined();
		expect(result.sdkTimestampMs).toBeUndefined();
		expect(result.metadata).toEqual({ sdkTimestampInvalid: true });
		expect(result.metadata).not.toHaveProperty("sdkTimestampIso");
		expect(result.diagnosticCodes).toEqual(["invalid_sdk_timestamp", "invalid_timestamp"]);
	});

	test("returns deterministic diagnostics when neither timestamp is valid", () => {
		const first = normalizeSessionEventTimestamp({ recordTimestamp: "bad", sdkTimestamp: Number.NaN });
		const second = normalizeSessionEventTimestamp({ recordTimestamp: "bad", sdkTimestamp: Number.NaN });

		expect(first).toEqual(second);
		expect(first.sourceTimestamp).toBeUndefined();
		expect(first.diagnosticCodes).toEqual(["invalid_record_timestamp", "invalid_sdk_timestamp", "invalid_timestamp"]);
	});

	test("normalization never invents a current timestamp", () => {
		const result = normalizeSessionJsonl({
			content: jsonl([{ type: "custom", id: "no-time", parentId: null, customType: "control", data: {} }]),
		});

		expect(result.activeEvents[0]!.sourceTimestamp).toBeUndefined();
		expect(result.activeEvents[0]!.sdkTimestampMs).toBeUndefined();
		expect(result.diagnostics).toContainEqual({ line: 1, code: "invalid_timestamp" });
	});
});
