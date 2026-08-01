import { describe, expect, test } from "bun:test";

import type { ExtractedSessionContext } from "./session-context.ts";
import type { NormalizedSessionEvent, NormalizedToolCall, NormalizedToolResult } from "./session-context-events.ts";
import { buildConversationTopology } from "./session-context-pairs.ts";

const baseTime = Date.parse("2026-07-31T10:00:00.000Z");

function event(
	entryId: string,
	role: NormalizedSessionEvent["role"],
	text: string,
	overrides: Partial<NormalizedSessionEvent> = {},
): NormalizedSessionEvent {
	const sourceLine = overrides.sourceLine ?? (Number(entryId.replace(/\D/g, "")) || 1);
	return {
		entryId,
		sourceLine,
		sourceTimestamp: new Date(baseTime + sourceLine * 1_000).toISOString(),
		sdkTimestampMs: baseTime + sourceLine * 1_000,
		role,
		synthetic: false,
		text,
		toolCalls: [],
		metadata: { messageRole: role, fixture: entryId },
		...overrides,
	};
}

function call(id: string, name: string, arguments_: Record<string, unknown>, overrides: Partial<NormalizedToolCall> = {}): NormalizedToolCall {
	return { id, name, arguments: arguments_, sourceEntryId: "a-tools", lifecycleMetadata: {}, ...overrides };
}

function result(toolCallId: string, text: string, overrides: Partial<NormalizedToolResult> = {}): NormalizedSessionEvent {
	const toolResult: NormalizedToolResult = {
		toolCallId,
		text,
		isError: false,
		sourceEntryId: `result-${toolCallId}`,
		metadata: { messageRole: "toolResult" },
		...overrides,
	};
	return event(toolResult.sourceEntryId, "tool", text, { toolResult });
}

function mains(topology: ExtractedSessionContext) {
	return topology.nodes.filter((node) => node.nodeRole === "main");
}

function children(topology: ExtractedSessionContext) {
	return topology.nodes.filter((node) => node.nodeRole === "child");
}

describe("buildConversationTopology conversation pairs", () => {
	test("simple genuine user and assistant final create exactly two paired main nodes and one exact answers edge", () => {
		const topology = buildConversationTopology({
			sessionId: "s1",
			events: [
				event("u1", "user", "What does the topology store?", { sourceLine: 4 }),
				event("a1", "assistant", "It stores conversation nodes and exact provenance.", { sourceLine: 7, stopReason: "stop" }),
			],
		});

		expect(mains(topology)).toHaveLength(2);
		const user = mains(topology).find((node) => node.population === "user")!;
		const answer = mains(topology).find((node) => node.population === "assistant")!;
		expect(user.id).toBe("s1:entry:u1:message");
		expect(answer.id).toBe("s1:entry:a1:message");
		expect(user.pairId).toBe("s1:pair:u1");
		expect(answer.pairId).toBe("s1:pair:u1");
		expect(topology.edges).toEqual([expect.objectContaining({
			sourceNodeId: answer.id,
			targetNodeId: user.id,
			relation: "answers",
		})]);
	});

	test("toolUse with two calls and out-of-order exact-ID results keeps the intermediate assistant out of main nodes", () => {
		const topology = buildConversationTopology({
			sessionId: "s1",
			events: [
				event("u1", "user", "Inspect both files."),
				event("a-tools", "assistant", "I will inspect them.", {
					stopReason: "toolUse",
					toolCalls: [call("read-1", "read", { path: "one.ts" }), call("read-2", "read", { path: "two.ts" })],
				}),
				result("read-2", "export const two = 2;", { toolName: "read" }),
				result("read-1", "export const one = 1;", { toolName: "read" }),
				event("a1", "assistant", "Both files export one constant.", { stopReason: "stop" }),
			],
		});

		expect(mains(topology)).toHaveLength(2);
		expect(mains(topology).some((node) => node.sourceMessageId === "a-tools")).toBe(false);
		expect(children(topology).map((node) => node.metadata.toolCallId).sort()).toEqual(["read-1", "read-2"]);
		expect(topology.edges).toHaveLength(1);
	});

	test("adjacent genuine user prompts close the first as an unanswered singleton and open the second pair", () => {
		const topology = buildConversationTopology({
			sessionId: "s1",
			events: [
				event("u1", "user", "First request."),
				event("u2", "user", "Second request."),
				event("a2", "assistant", "Second answer.", { stopReason: "stop" }),
			],
		});

		const first = topology.nodes.find((node) => node.sourceMessageId === "u1")!;
		const second = topology.nodes.find((node) => node.sourceMessageId === "u2")!;
		expect(first.status).toBe("unknown");
		expect(second.status).toBe("completed");
		expect(topology.edges).toHaveLength(1);
		expect(topology.edges[0]?.targetNodeId).toBe(second.id);
	});

	test("system developer custom and synthetic events never open a pair", () => {
		const topology = buildConversationTopology({
			sessionId: "s1",
			events: [
				event("sys", "system", "system"),
				event("dev", "developer", "developer"),
				event("custom", "system", "custom", { synthetic: true, customType: "notice" }),
				event("synthetic", "system", "continue", { synthetic: true, metadata: { syntheticUser: true } }),
				event("orphan-answer", "assistant", "No genuine prompt.", { stopReason: "stop" }),
			],
		});

		expect(topology).toEqual({ nodes: [], edges: [], artifacts: [] });
	});

	test("aborted error and tool-only spans fabricate neither assistant final nor answers edge", () => {
		for (const stopReason of ["aborted", "error"] as const) {
			const topology = buildConversationTopology({
				sessionId: `s-${stopReason}`,
				events: [
					event("u1", "user", "Run it."),
					event("a-tools", "assistant", "", { stopReason: "toolUse", toolCalls: [call("run-1", "bash", { command: "bun test" })] }),
					result("run-1", "cancelled before execution", { toolName: "bash", isError: stopReason === "error" }),
					event("a-end", "assistant", "", { stopReason }),
				],
			});
			expect(mains(topology)).toHaveLength(1);
			expect(mains(topology)[0]?.population).toBe("user");
			expect(topology.edges).toHaveLength(0);
			expect(mains(topology)[0]?.status).toBe(stopReason === "error" ? "failed" : "aborted");
			expect(mains(topology)[0]?.metadata.pairCloseReason).toBe(stopReason);
		}
	});

	test("missing stopReason uses the last nonempty assistant before the next user as unknown candidate final", () => {
		const topology = buildConversationTopology({
			sessionId: "s1",
			events: [
				event("u1", "user", "Question one?"),
				event("a-old", "assistant", "Historical answer without stop reason."),
				event("u2", "user", "Question two?"),
			],
		});
		const answer = topology.nodes.find((node) => node.sourceMessageId === "a-old")!;
		expect(answer.status).toBe("unknown");
		expect(answer.metadata.answerBoundarySource).toBe("missing_stop_reason_fallback");
		expect(topology.edges).toContainEqual(expect.objectContaining({ relation: "answers", sourceNodeId: answer.id }));
	});

	test("stable source-derived IDs do not depend on operation detail or optional refinement fields", () => {
		const events = [event("u1", "user", "Please modify the parser."), event("a1", "assistant", "Modified it.", { stopReason: "stop" })];
		const first = buildConversationTopology({ sessionId: "s1", events });
		const changedText = [event("u1", "user", "Please modify only the parser."), event("a1", "assistant", "Modified and summarized it.", { stopReason: "stop" })];
		const second = buildConversationTopology({ sessionId: "s1", events: changedText });
		expect(first.nodes.map((node) => node.id)).toEqual(second.nodes.map((node) => node.id));
	});

	test("main nodes preserve source IDs turn indexes timestamps and normalized provenance metadata", () => {
		const userEvent = event("u1", "user", "Please add the field.", { sourceLine: 12, metadata: { messageRole: "user", trace: "source" } });
		const assistantEvent = event("a1", "assistant", "Added the field.", { sourceLine: 18, stopReason: "length", metadata: { messageRole: "assistant", trace: "answer" } });
		const topology = buildConversationTopology({ sessionId: "s1", events: [userEvent, assistantEvent] });
		const user = topology.nodes.find((node) => node.sourceMessageId === "u1")!;
		const assistant = topology.nodes.find((node) => node.sourceMessageId === "a1")!;
		expect(user).toMatchObject({ sourceMessageId: "u1", sourceTurnIndex: 12, createdAt: userEvent.sourceTimestamp, metadata: { trace: "source", sourceEntryId: "u1", sourceLine: 12 } });
		expect(assistant).toMatchObject({ sourceMessageId: "a1", sourceTurnIndex: 18, createdAt: assistantEvent.sourceTimestamp, metadata: { trace: "answer", sourceEntryId: "a1", sourceLine: 18 } });
	});

	test("v2 emits no proximity continues depends_on or verified_by edges", () => {
		const topology = buildConversationTopology({
			sessionId: "s1",
			events: [
				event("u1", "user", "Design it."),
				event("a1", "assistant", "I recommend a plan.", { stopReason: "stop" }),
				event("u2", "user", "Verify it."),
				event("a-tools", "assistant", "", { stopReason: "toolUse", toolCalls: [call("test-1", "bash", { command: "bun test x.test.ts" })] }),
				result("test-1", "1 pass\n0 fail", { toolName: "bash", details: { exitCode: 0 } }),
				event("a2", "assistant", "The test passes.", { stopReason: "stop" }),
			],
		});
		expect(topology.edges.map((edge) => edge.relation)).toEqual(["answers", "answers"]);
	});
});

describe("buildConversationTopology deterministic semantics", () => {
	test("user operations use only explicit patterns and purpose is bounded redacted explicit text", () => {
		const cases = [
			["What is this?", "ask"],
			["Please create the parser.", "request"],
			["Actually, use SQLite instead.", "correct"],
			["Do not add proximity edges.", "constrain"],
			["I approve this plan.", "approve"],
			["I reject this proposal.", "reject"],
			["I found that the test fails.", "report"],
			["Here is the log output.", "provide"],
			["Topology context", "unknown"],
		] as const;
		for (const [text, operation] of cases) {
			const topology = buildConversationTopology({ sessionId: "s1", events: [event("u1", "user", text)] });
			expect(topology.nodes[0]).toMatchObject({ operation, purpose: text, purposeSource: "explicit_text" });
		}
		const redacted = buildConversationTopology({ sessionId: "s1", events: [event("u1", "user", `Use sk-proj-${"A".repeat(30)} safely.`)] });
		expect(redacted.nodes[0]?.purpose).toContain("[REDACTED]");
		expect((redacted.nodes[0]?.purpose ?? "").length).toBeLessThanOrEqual(240);
	});

	test("empty or control-only text has null unclassified purpose", () => {
		const topology = buildConversationTopology({ sessionId: "s1", events: [event("u1", "user", "   ")] });
		expect(topology.nodes[0]).toMatchObject({ purpose: null, purposeSource: "unclassified", operation: "unknown" });
	});

	test("assistant operation and legacy kind use structured work without issue adjacency guessing", () => {
		const topology = buildConversationTopology({
			sessionId: "s1",
			events: [
				event("u1", "user", "Modify the file."),
				event("a-tools", "assistant", "", { stopReason: "toolUse", toolCalls: [call("edit-1", "edit", { path: "a.ts", patch: "bounded" })] }),
				result("edit-1", "Updated a.ts", { toolName: "edit" }),
				event("a1", "assistant", "Modified the parser.", { stopReason: "stop" }),
			],
		});
		const assistant = mains(topology).find((node) => node.population === "assistant")!;
		expect(assistant).toMatchObject({ operation: "modify", kind: "resolution", status: "completed" });
		expect(assistant.refinedPurpose).toBeUndefined();
		expect(assistant.refinement).toBeUndefined();
	});
});

describe("buildConversationTopology assistant children", () => {
	test("structured test call and result creates one bounded test child with counts exit code and duration", () => {
		const topology = buildConversationTopology({
			sessionId: "s1",
			events: [
				event("u1", "user", "Run the tests."),
				event("a-tools", "assistant", "", { stopReason: "toolUse", toolCalls: [call("test-1", "bash", { command: "bun test apps/server/src/a.test.ts" })] }),
				result("test-1", "12 pass\n2 fail\n15 expect() calls", { toolName: "bash", details: { exitCode: 1 }, metadata: { messageRole: "toolResult", lifecycle: { durationMs: 3210 } } }),
				event("a1", "assistant", "The test run failed.", { stopReason: "stop" }),
			],
		});
		const child = children(topology)[0]!;
		expect(children(topology)).toHaveLength(1);
		expect(child).toMatchObject({ childType: "test", operation: "verify", status: "failed", metadata: { command: "bun test apps/server/src/a.test.ts", passCount: 12, failCount: 2, exitCode: 1, durationMs: 3210 } });
		expect(child.body).toContain("12 pass");
		expect(child.body.length).toBeLessThanOrEqual(600);
	});

	test("successful read text containing error remains tool evidence rather than error", () => {
		const topology = buildConversationTopology({
			sessionId: "s1",
			events: [event("u1", "user", "Read it."), event("a-tools", "assistant", "", { stopReason: "toolUse", toolCalls: [call("read-1", "read", { path: "errors.ts" })] }), result("read-1", "export class ErrorBoundary {}", { toolName: "read" }), event("a1", "assistant", "Read it.", { stopReason: "stop" })],
		});
		expect(children(topology)[0]).toMatchObject({ childType: "tool_evidence", operation: "observe", status: "completed" });
	});

	test("structured isError nonzero exit or failed lifecycle creates an error child without failure prose", () => {
		const variants: Array<Partial<NormalizedToolResult>> = [
			{ isError: true, details: { exitCode: 0 } },
			{ details: { exitCode: 7 } },
			{ details: { exitCode: 0 }, metadata: { lifecycle: { status: "failed" } } },
		];
		for (const [index, overrides] of variants.entries()) {
			const topology = buildConversationTopology({ sessionId: `s${index}`, events: [event("u1", "user", "Run it."), event("a-tools", "assistant", "", { stopReason: "toolUse", toolCalls: [call("run-1", "bash", { command: "node script.js" })] }), result("run-1", "finished", { toolName: "bash", ...overrides }), event("a1", "assistant", "It did not complete.", { stopReason: "stop" })] });
			expect(children(topology)).toHaveLength(1);
			expect(children(topology)[0]).toMatchObject({ childType: "error", status: "failed" });
		}
	});

	test("subagent start poll and final lifecycle yields exactly one final subagent result child", () => {
		const topology = buildConversationTopology({
			sessionId: "s1",
			events: [
				event("u1", "user", "Delegate an audit."),
				event("a-tools", "assistant", "", { stopReason: "toolUse", toolCalls: [
					call("agent-start", "agent", { action: "start", agentId: "Agent 7/unsafe", target: "audit model role routes" }),
					call("agent-poll", "agent", { action: "poll", agentId: "Agent 7/unsafe" }),
					call("agent-final", "agent", { action: "result", agentId: "Agent 7/unsafe" }),
				] }),
				result("agent-start", "spawned", { toolName: "agent", details: { agentId: "Agent 7/unsafe", status: "running" } }),
				result("agent-poll", "still running", { toolName: "agent", details: { agentId: "Agent 7/unsafe", status: "running" } }),
				result("agent-final", "Audit complete", { toolName: "agent", details: { agentId: "Agent 7/unsafe", status: "completed", conclusion: "Routes preserve the configured role.", mutatedFiles: false } }),
				event("a1", "assistant", "The delegated audit completed.", { stopReason: "stop" }),
			],
		});
		expect(children(topology)).toHaveLength(1);
		expect(children(topology)[0]).toMatchObject({
			id: expect.stringMatching(/^s1:pair:u1:agent:Agent-7-unsafe:[0-9a-f]{32}$/),
			childType: "subagent_result",
			origin: "subagent",
			operation: "delegate",
			status: "completed",
			metadata: { agentId: "Agent-7-unsafe", rawAgentId: "Agent 7/unsafe", delegatedTarget: "audit model role routes", mutation: false },
		});
		expect(children(topology)[0]?.body).toContain("Routes preserve");
		expect(children(topology)[0]?.body).not.toContain("still running");
	});

	test("distinct raw subagent identities that sanitize equally retain two collision-proof children", () => {
		const topology = buildConversationTopology({
			sessionId: "s1",
			events: [
				event("u1", "user", "Delegate both audits."),
				event("a-tools", "assistant", "", { stopReason: "toolUse", toolCalls: [
					call("agent/final:one", "agent", { action: "result", agentId: "Agent/A", target: "audit route A" }),
					call("agent/final:two", "agent", { action: "result", agentId: "Agent A", target: "audit route B" }),
				] }),
				result("agent/final:one", "first complete", { toolName: "agent", details: { agentId: "Agent/A", status: "completed", conclusion: "First audit complete." } }),
				result("agent/final:two", "second complete", { toolName: "agent", details: { agentId: "Agent A", status: "completed", conclusion: "Second audit complete." } }),
				event("a1", "assistant", "Both audits completed.", { stopReason: "stop" }),
			],
		});
		const agentChildren = children(topology).filter((node) => node.childType === "subagent_result");
		expect(agentChildren).toHaveLength(2);
		expect(new Set(agentChildren.map((node) => node.id)).size).toBe(2);
		expect(agentChildren.map((node) => node.metadata.rawAgentId).sort()).toEqual(["Agent A", "Agent/A"]);
		expect(agentChildren.map((node) => node.metadata.toolCallId).sort()).toEqual(["agent/final:one", "agent/final:two"]);
		expect(agentChildren.every((node) => node.id.includes("Agent-A") && /:[0-9a-f]{32}$/.test(node.id))).toBe(true);
	});

	test("todo task transitions collapse to one latest task state child per stable identity", () => {
		const topology = buildConversationTopology({
			sessionId: "s1",
			events: [
				event("u1", "user", "Track the task."),
				event("a-tools", "assistant", "", { stopReason: "toolUse", toolCalls: [
					call("todo-1", "todo", { id: "task-1", text: "Verify topology", status: "pending" }),
					call("todo-2", "todo", { id: "task-1", text: "Verify topology", status: "in_progress" }),
					call("todo-3", "todo", { id: "task-1", text: "Verify topology", status: "completed" }),
				] }),
				result("todo-1", "updated", { toolName: "todo" }), result("todo-2", "updated", { toolName: "todo" }), result("todo-3", "updated", { toolName: "todo" }),
				event("a1", "assistant", "Tracked it.", { stopReason: "stop" }),
			],
		});
		expect(children(topology)).toHaveLength(1);
		expect(children(topology)[0]).toMatchObject({ childType: "task_state", operation: "track", status: "completed", metadata: { taskId: "task-1", taskText: "Verify topology" } });
		expect(children(topology)[0]?.id).toMatch(/^s1:pair:u1:task:[0-9a-f]{16}$/);
	});

	test("noise outcomes remain hidden children", () => {
		const noise = [
			"Skipped due to queued user message",
			"[Superseded by a newer read of this file]",
			"(no output)",
			"poll status: still running",
			"cancelled before execution",
			"[INFO] repeated log line\n[INFO] repeated log line",
		];
		for (const [index, text] of noise.entries()) {
			const topology = buildConversationTopology({ sessionId: `s${index}`, events: [event("u1", "user", "Inspect it."), event("a-tools", "assistant", "", { stopReason: "toolUse", toolCalls: [call("read-1", "read", { path: "a.ts" })] }), result("read-1", text, { toolName: "read" }), event("a1", "assistant", "No substantive result.", { stopReason: "stop" })] });
			expect(children(topology)).toHaveLength(0);
		}
	});

	test("duplicate tool names pair results by exact toolCallId only", () => {
		const topology = buildConversationTopology({ sessionId: "s1", events: [
			event("u1", "user", "Read both."),
			event("a-tools", "assistant", "", { stopReason: "toolUse", toolCalls: [call("one", "read", { path: "one.ts" }), call("two", "read", { path: "two.ts" })] }),
			result("two", "two content", { toolName: "read" }), result("one", "one content", { toolName: "read" }),
			event("a1", "assistant", "Done.", { stopReason: "stop" }),
		] });
		expect(children(topology).find((node) => node.metadata.toolCallId === "one")?.metadata.path).toBe("one.ts");
		expect(children(topology).find((node) => node.metadata.toolCallId === "two")?.metadata.path).toBe("two.ts");
	});

	test("structured files commits URLs and generated images attach as artifacts to the owning child", () => {
		const topology = buildConversationTopology({ sessionId: "s1", events: [
			event("u1", "user", "Generate and write the asset."),
			event("a-tools", "assistant", "", { stopReason: "toolUse", toolCalls: [
				call("write-1", "write", { path: "dist/result.svg", url: "https://example.test/result", commit: "abcdef1234567" }),
				call("image-1", "image_gen", { prompt: "diagram", outputPath: "dist/diagram.png" }),
			] }),
			result("write-1", "wrote output", { toolName: "write", details: { files: ["dist/result.svg"] } }),
			result("image-1", "generated", { toolName: "image_gen", details: { imagePath: "dist/diagram.png" } }),
			event("a1", "assistant", "Assets generated.", { stopReason: "stop" }),
		] });
		const writeChild = children(topology).find((node) => node.metadata.toolCallId === "write-1")!;
		const imageChild = children(topology).find((node) => node.metadata.toolCallId === "image-1")!;
		expect(topology.artifacts).toEqual(expect.arrayContaining([
			expect.objectContaining({ nodeId: writeChild.id, kind: "file", ref: "dist/result.svg" }),
			expect.objectContaining({ nodeId: writeChild.id, kind: "commit", ref: "abcdef1234567" }),
			expect.objectContaining({ nodeId: writeChild.id, kind: "url", ref: "https://example.test/result" }),
			expect.objectContaining({ nodeId: imageChild.id, kind: "image", ref: "dist/diagram.png" }),
		]));
	});

	test("every child has stable ownership structural semantics and true origin", () => {
		const topology = buildConversationTopology({ sessionId: "s1", events: [
			event("u1", "user", "Read it."),
			event("a-tools", "assistant", "", { stopReason: "toolUse", toolCalls: [call("read-1", "grep", { pattern: "nodeRole", path: "a.ts" })] }),
			result("read-1", "a.ts:1:nodeRole", { toolName: "grep" }),
			event("a1", "assistant", "Found it.", { stopReason: "stop" }),
		] });
		const assistant = mains(topology).find((node) => node.population === "assistant")!;
		expect(children(topology)[0]).toMatchObject({
			id: "s1:pair:u1:tool:read-1",
			population: "assistant",
			nodeRole: "child",
			origin: "tool",
			childType: "tool_evidence",
			pairId: "s1:pair:u1",
			parentNodeId: assistant.id,
			operation: "observe",
			purposeSource: "structured_intent",
			status: "completed",
		});
	});
});
