/**
 * Tests for the queue-edit / queue-cancel surface added in T-? (Queued-message
 * edit & cancel). These exercise the bridge's shadow-queue algorithm in
 * isolation: a tiny stub AgentSession mirrors the SDK's `getQueuedMessages`
 * / `popLastQueuedMessage` / `clearQueue` / `prompt` semantics while a real
 * turn is in flight (isStreaming = true) so the bridge's cancel/edit path
 * exercises its sync pop-then-re-enqueue invariant end-to-end.
 *
 * We don't pull in `@oh-my-pi/pi-coding-agent` here — the InProcessSessionHandle
 * accepts an `AgentSession`-shaped object via duck typing in the constructor
 * (private field is typed but methods access via `unknown as { … }` casts).
 */
import { describe, expect, test } from "bun:test";

import { InProcessSessionHandle } from "./in-process.ts";

interface QueueEntry {
	text: string;
}

/**
 * Hand-rolled stub that mimics the small slice of `AgentSession` the bridge
 * actually touches: prompt (queues when streaming), getQueuedMessages,
 * popLastQueuedMessage, clearQueue, isStreaming, queuedMessageCount, dispose.
 * No model, no events, no fanciness — purely the SDK queue contract.
 */
class StubSession {
	isStreaming = true;
	sessionId = "stub-1";
	model = undefined;
	thinkingLevel = undefined;
	messages: unknown[] = [];

	#steering: QueueEntry[] = [];
	#followUp: QueueEntry[] = [];

	get queuedMessageCount(): number {
		return this.#steering.length + this.#followUp.length;
	}

	async prompt(text: string, opts?: { streamingBehavior?: "steer" | "followUp" }): Promise<void> {
		if (!this.isStreaming) {
			throw new Error("StubSession.prompt called while not streaming (no model wired)");
		}
		if (opts?.streamingBehavior === "steer") this.#steering.push({ text });
		else this.#followUp.push({ text });
	}

	getQueuedMessages(): { steering: string[]; followUp: string[] } {
		return {
			steering: this.#steering.map((e) => e.text),
			followUp: this.#followUp.map((e) => e.text),
		};
	}

	popLastQueuedMessage(): string | undefined {
		if (this.#steering.length > 0) return this.#steering.pop()?.text;
		if (this.#followUp.length > 0) return this.#followUp.pop()?.text;
		return undefined;
	}

	clearQueue(): { steering: string[]; followUp: string[] } {
		const s = this.#steering.map((e) => e.text);
		const f = this.#followUp.map((e) => e.text);
		this.#steering = [];
		this.#followUp = [];
		return { steering: s, followUp: f };
	}

	getTodoPhases(): unknown[] {
		return [];
	}

	getContextUsage(): undefined {
		return undefined;
	}

	async dispose(): Promise<void> {}
}

function makeHandle(): { handle: InProcessSessionHandle; session: StubSession; emitted: unknown[] } {
	const session = new StubSession();
	const emitted: unknown[] = [];
	const handle = new InProcessSessionHandle({
		session: session as unknown as never,
		sessionManager: {} as never,
		cwd: "/tmp/stub",
		sessionId: "stub-1",
		getModelRegistry: async () => ({}) as never,
		planBridge: {
			// The queue tests don't exercise plan mode; a minimal stub keeps the
			// constructor + dispose paths happy without coupling these tests to
			// the full PlanModeBridge surface.
			dispose() {},
			getPlanModeContext: () => undefined,
			getPendingPlanApproval: () => undefined,
		} as never,
		onDispose: () => {},
	});
	handle.subscribe((ev) => emitted.push(ev));
	return { handle, session, emitted };
}

describe("InProcessSessionHandle queue shadow", () => {
	test("prompt() while streaming pushes to shadow and emits prompt_queued + queue_state", async () => {
		const { handle, emitted } = makeHandle();
		await handle.prompt("alpha");
		const snap = handle.getQueueSnapshot();
		expect(snap.map((q) => q.text)).toEqual(["alpha"]);
		expect(snap[0]?.behavior).toBe("followUp");
		const types = emitted.map((e) => (e as { type?: string }).type);
		expect(types).toEqual(["prompt_queued", "queue_state"]);
	});

	test("cancelQueuedById removes a middle entry and preserves order + ids", async () => {
		const { handle, session, emitted } = makeHandle();
		await handle.prompt("a");
		await handle.prompt("b");
		await handle.prompt("c");
		const [, midEntry] = handle.getQueueSnapshot();
		emitted.length = 0;

		const ok = await handle.cancelQueuedById(midEntry!.id);
		expect(ok).toBe(true);

		const after = handle.getQueueSnapshot();
		expect(after.map((q) => q.text)).toEqual(["a", "c"]);
		expect(session.getQueuedMessages().followUp).toEqual(["a", "c"]);
		// Exactly one queue_state echo broadcast.
		expect(emitted.map((e) => (e as { type?: string }).type)).toEqual(["queue_state"]);
	});

	test("cancelQueuedById returns false for an unknown id and emits nothing", async () => {
		const { handle, emitted } = makeHandle();
		await handle.prompt("only");
		emitted.length = 0;

		const ok = await handle.cancelQueuedById("does-not-exist");
		expect(ok).toBe(false);
		expect(handle.getQueueSnapshot().map((q) => q.text)).toEqual(["only"]);
		expect(emitted).toHaveLength(0);
	});

	test("editQueuedById replaces text in place and preserves the original queuedId", async () => {
		const { handle, session } = makeHandle();
		await handle.prompt("draft");
		await handle.prompt("keep");
		const [target] = handle.getQueueSnapshot();
		const originalId = target!.id;

		const ok = await handle.editQueuedById(originalId, "polished");
		expect(ok).toBe(true);

		const after = handle.getQueueSnapshot();
		expect(after.map((q) => q.text)).toEqual(["polished", "keep"]);
		expect(after[0]?.id).toBe(originalId);
		expect(session.getQueuedMessages().followUp).toEqual(["polished", "keep"]);
	});

	test("clearQueue empties shadow and emits queue_state", async () => {
		const { handle, emitted } = makeHandle();
		await handle.prompt("a");
		await handle.prompt("b");
		emitted.length = 0;

		const counts = handle.clearQueue();
		expect(counts).toEqual({ steering: 0, followUp: 2 });
		expect(handle.getQueueSnapshot()).toEqual([]);
		const types = emitted.map((e) => (e as { type?: string }).type);
		// queue_cleared (legacy) + queue_state (new wholesale rebroadcast).
		expect(types).toContain("queue_cleared");
		expect(types).toContain("queue_state");
	});

	test("emit() drains the matching shadow head on a non-synthetic user message_start", async () => {
		const { handle, emitted } = makeHandle();
		await handle.prompt("first");
		await handle.prompt("second");
		emitted.length = 0;

		handle.emit({
			type: "message_start",
			message: { role: "user", content: "first", synthetic: false, timestamp: 0 },
		} as never);

		expect(handle.getQueueSnapshot().map((q) => q.text)).toEqual(["second"]);
		const types = emitted.map((e) => (e as { type?: string }).type);
		// queue_state arrives BEFORE the message_start so client sees drain first.
		expect(types).toEqual(["queue_state", "message_start"]);
	});

	test("emit() ignores synthetic user message_start (slash-command round-trip)", async () => {
		const { handle, emitted } = makeHandle();
		await handle.prompt("/help");
		emitted.length = 0;

		handle.emit({
			type: "message_start",
			message: { role: "user", content: "/help", synthetic: true, timestamp: 0 },
		} as never);

		expect(handle.getQueueSnapshot().map((q) => q.text)).toEqual(["/help"]);
		expect(emitted.map((e) => (e as { type?: string }).type)).toEqual(["message_start"]);
	});

	test("snapshot exposes queuedPrompts when shadow is non-empty", async () => {
		const { handle } = makeHandle();
		await handle.prompt("queued-once");
		const snap = handle.snapshot();
		expect(snap.queuedPrompts).toHaveLength(1);
		expect(snap.queuedPrompts?.[0]).toMatchObject({ text: "queued-once", behavior: "followUp" });
	});
});
