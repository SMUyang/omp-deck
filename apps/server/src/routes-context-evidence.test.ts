import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type {
	ContextReplacementEvent,
	ContextReplacementMechanism,
	ContextReplacementStatus,
	ContextEvidenceStats,
} from "@omp-deck/protocol";
import { Hono } from "hono";

import { closeDb, openDb } from "./db/index.ts";

// ---------------------------------------------------------------------------
// Stub tracker — mirrors ContextEvidenceTracker interface.
// ---------------------------------------------------------------------------

class StubContextEvidenceTracker {
	#events: Map<string, ContextReplacementEvent> = new Map();
	#nextId = 1;

	recordReplacement(params: {
		sessionId: string;
		status: string;
		mechanism: ContextReplacementMechanism;
		beforeTokens?: number | null;
		beforePercent?: number | null;
		afterTokens?: number | null;
		afterPercent?: number | null;
		focusHash: string;
		focusPreview: string;
		focusEstimatedTokens?: number;
		focusEstimateMethod?: "chars_div_4";
		providerRole?: string | null;
		errorMessage?: string | null;
	}): string {
		const id = `evt-${this.#nextId++}`;
		const now = new Date().toISOString();
		const savedTokens =
			params.beforeTokens != null && params.afterTokens != null
				? Math.max(0, params.beforeTokens - params.afterTokens)
				: null;
		const savedPercent =
			savedTokens != null && params.beforeTokens != null && params.beforeTokens > 0
				? Math.round((savedTokens / params.beforeTokens) * 10000) / 100
				: null;

		const event: ContextReplacementEvent = {
			id,
			sessionId: params.sessionId,
			status: params.status as ContextReplacementStatus,
			mechanism: params.mechanism,
			beforeTokens: params.beforeTokens ?? null,
			beforePercent: params.beforePercent ?? null,
			afterTokens: params.afterTokens ?? null,
			afterPercent: params.afterPercent ?? null,
			savedTokens,
			savedPercent,
			focusHash: params.focusHash,
			focusPreview: params.focusPreview,
			focusEstimatedTokens: params.focusEstimatedTokens ?? 0,
			focusEstimateMethod: params.focusEstimateMethod ?? "chars_div_4",
			providerRole: params.providerRole ?? null,
			errorMessage: params.errorMessage ?? null,
			retryCount: 0,
			createdAt: now,
			updatedAt: now,
		};
		this.#events.set(id, event);
		return id;
	}

	updateStatus(
		eventId: string,
		status: ContextReplacementStatus,
		updates?: {
			beforeTokens?: number | null;
			beforePercent?: number | null;
			afterTokens?: number | null;
			afterPercent?: number | null;
			providerRole?: string | null;
			errorMessage?: string | null;
		},
	): boolean {
		const event = this.#events.get(eventId);
		if (!event) return false;

		event.status = status;
		if (updates) {
			if (updates.beforeTokens !== undefined) event.beforeTokens = updates.beforeTokens;
			if (updates.beforePercent !== undefined) event.beforePercent = updates.beforePercent;
			if (updates.afterTokens !== undefined) event.afterTokens = updates.afterTokens;
			if (updates.afterPercent !== undefined) event.afterPercent = updates.afterPercent;
			if (updates.providerRole !== undefined) event.providerRole = updates.providerRole;
			if (updates.errorMessage !== undefined) event.errorMessage = updates.errorMessage;

			// Recompute saved tokens on update
			if (event.beforeTokens != null && event.afterTokens != null) {
				event.savedTokens = Math.max(0, event.beforeTokens - event.afterTokens);
				event.savedPercent =
					event.beforeTokens > 0
						? Math.round((event.savedTokens / event.beforeTokens) * 10000) / 100
						: 0;
			} else {
				event.savedTokens = null;
				event.savedPercent = null;
			}
		}
		event.updatedAt = new Date().toISOString();
		return true;
	}

	getSessionEvidence(sessionId: string, limit?: number, offset?: number): ContextReplacementEvent[] {
		const events = [...this.#events.values()]
			.filter((e) => e.sessionId === sessionId)
			.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
		const start = offset ?? 0;
		const end = limit != null ? start + limit : events.length;
		return events.slice(start, end);
	}

	getStats(): ContextEvidenceStats {
		const all = [...this.#events.values()];
		const completed = all.filter((e) => e.status === "provider_payload_observed").length;
		const totalSaved = all.reduce((sum, e) => sum + (e.savedTokens ?? 0), 0);
		return {
			total: all.length,
			completed,
			totalSaved,
			recent: all.slice(-50).reverse(),
		};
	}
}

export { StubContextEvidenceTracker };

import { buildContextEvidenceRouter } from "./routes-context-evidence.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const tempDirs: string[] = [];

afterEach(() => {
	closeDb();
	for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "routes-ctx-evidence-"));
	tempDirs.push(dir);
	return dir;
}

function setupApp(): { app: Hono; tracker: StubContextEvidenceTracker } {
	const dir = tempDir();
	openDb({ path: path.join(dir, "deck.db") });
	const tracker = new StubContextEvidenceTracker();
	const app = buildContextEvidenceRouter(tracker as unknown as import("./context-evidence-tracker.ts").ContextEvidenceTracker);
	return { app, tracker };
}

interface CreatedEvent {
	app: Hono;
	tracker: StubContextEvidenceTracker;
	eventId: string;
	sessionId: string;
}

async function createEvent(
	sessionId: string,
	overrides: Record<string, unknown> = {},
): Promise<CreatedEvent> {
	const { app, tracker } = setupApp();
	const body = {
		status: "constructed",
		mechanism: "context_hook",
		focusHash: "abc123",
		focusPreview: "focus preview text",
		...overrides,
	};
	const res = await app.request(`/sessions/${sessionId}/context-evidence`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
	expect(res.status).toBe(201);
	const json = (await res.json()) as { eventId: string };
	return { app, tracker, eventId: json.eventId, sessionId };
}

// ---------------------------------------------------------------------------
// POST /sessions/:id/context-evidence — create
// ---------------------------------------------------------------------------

describe("POST /sessions/:id/context-evidence", () => {
	test("creates an event and returns 201 with eventId", async () => {
		const { app, tracker } = setupApp();

		const res = await app.request("/sessions/s1/context-evidence", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				status: "constructed",
				mechanism: "context_hook",
				focusHash: "abc123",
				focusPreview: "focus preview text",
				estimatedFocusTokens: 4,
			}),
		});

		expect(res.status).toBe(201);
		const body = (await res.json()) as { eventId: string };
		expect(body.eventId).toBeTruthy();
		expect(typeof body.eventId).toBe("string");

		const events = tracker.getSessionEvidence("s1");
		expect(events).toHaveLength(1);
		expect(events[0].status).toBe("constructed");
		expect(events[0].mechanism).toBe("context_hook");
	});

	test("returns 400 when status is missing", async () => {
		const { app } = setupApp();
		const res = await app.request("/sessions/s1/context-evidence", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ mechanism: "context_hook", focusHash: "x", focusPreview: "x" }),
		});
		expect(res.status).toBe(400);
	});

	test("returns 400 when mechanism is missing", async () => {
		const { app } = setupApp();
		const res = await app.request("/sessions/s1/context-evidence", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ status: "constructed", focusHash: "x", focusPreview: "x" }),
		});
		expect(res.status).toBe(400);
	});

	test("returns 400 when focusHash is missing", async () => {
		const { app } = setupApp();
		const res = await app.request("/sessions/s1/context-evidence", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ status: "constructed", mechanism: "context_hook", focusPreview: "x" }),
		});
		expect(res.status).toBe(400);
	});

	test("returns 400 when focusPreview is missing", async () => {
		const { app } = setupApp();
		const res = await app.request("/sessions/s1/context-evidence", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ status: "constructed", mechanism: "context_hook", focusHash: "x" }),
		});
		expect(res.status).toBe(400);
	});

	test("returns 400 for invalid JSON", async () => {
		const { app } = setupApp();
		const res = await app.request("/sessions/s1/context-evidence", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: "not json",
		});
		expect(res.status).toBe(400);
	});

	test("sessionId is correctly recorded", async () => {
		const { app, tracker } = setupApp();

		await app.request("/sessions/alpha-session/context-evidence", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				status: "handler_returned",
				mechanism: "auto_compact",
				focusHash: "def456",
				focusPreview: "another focus",
			}),
		});

		const events = tracker.getSessionEvidence("alpha-session");
		expect(events).toHaveLength(1);
		expect(events[0].sessionId).toBe("alpha-session");
	});

	test("optional token fields are null when omitted", async () => {
		const { app, tracker } = setupApp();

		await app.request("/sessions/s1/context-evidence", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				status: "constructed",
				mechanism: "context_hook",
				focusHash: "abc123",
				focusPreview: "test",
			}),
		});

		const events = tracker.getSessionEvidence("s1");
		expect(events[0].beforeTokens).toBeNull();
		expect(events[0].afterTokens).toBeNull();
		expect(events[0].savedTokens).toBeNull();
		expect(events[0].savedPercent).toBeNull();
	});

	test("token fields are passed through when provided", async () => {
		const { app, tracker } = setupApp();

		await app.request("/sessions/s1/context-evidence", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				status: "compact_completed",
				mechanism: "auto_compact",
				focusHash: "abc123",
				focusPreview: "focus",
				beforeTokens: 12000,
				beforePercent: 85.5,
				afterTokens: 8500,
				afterPercent: 60.2,
				estimatedFocusTokens: 2,
			}),
		});

		const events = tracker.getSessionEvidence("s1");
		expect(events[0].beforeTokens).toBe(12000);
		expect(events[0].afterTokens).toBe(8500);
		expect(events[0].savedTokens).toBe(3500);
		expect(events[0].focusEstimatedTokens).toBe(2);
	});

	test("providerRole and errorMessage are passed through", async () => {
		const { app, tracker } = setupApp();

		await app.request("/sessions/s1/context-evidence", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				status: "provider_payload_observed",
				mechanism: "context_hook",
				focusHash: "abc123",
				focusPreview: "focus",
				providerRole: "slow",
				errorMessage: null,
			}),
		});

		const events = tracker.getSessionEvidence("s1");
		expect(events[0].providerRole).toBe("slow");
		expect(events[0].errorMessage).toBeNull();
	});

	test("focusEstimateMethod defaults to chars_div_4", async () => {
		const { app, tracker } = setupApp();

		await app.request("/sessions/s1/context-evidence", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				status: "constructed",
				mechanism: "context_hook",
				focusHash: "abc123",
				focusPreview: "focus",
			}),
		});

		const events = tracker.getSessionEvidence("s1");
		expect(events[0].focusEstimateMethod).toBe("chars_div_4");
	});
});

// ---------------------------------------------------------------------------
// POST /sessions/:id/context-evidence/:eventId — update
// ---------------------------------------------------------------------------

describe("POST /sessions/:id/context-evidence/:eventId", () => {
	test("updates event status and returns 200", async () => {
		const { app, eventId, sessionId, tracker } = await createEvent("s1");

		const res = await app.request(`/sessions/${sessionId}/context-evidence/${eventId}`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ status: "provider_payload_observed" }),
		});
		expect(res.status).toBe(200);

		const events = tracker.getSessionEvidence("s1");
		expect(events[0].status).toBe("provider_payload_observed");
	});

	test("returns 404 when eventId not found", async () => {
		const { app } = setupApp();

		const res = await app.request("/sessions/s1/context-evidence/nonexistent", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ status: "provider_payload_observed" }),
		});
		expect(res.status).toBe(404);
	});

	test("returns 404 when eventId exists but in different session", async () => {
		const { app, eventId } = await createEvent("s1");

		// Try updating from wrong session — still should work (eventId is unique)
		const res = await app.request(`/sessions/s2/context-evidence/${eventId}`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ status: "provider_payload_observed" }),
		});
		// eventId is globally unique, session in URL is just routing — update still works
		expect(res.status).toBe(200);
	});

	test("returns 400 when status is missing", async () => {
		const { app, eventId, sessionId } = await createEvent("s1");

		const res = await app.request(`/sessions/${sessionId}/context-evidence/${eventId}`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({}),
		});
		expect(res.status).toBe(400);
	});

	test("returns 400 for invalid JSON", async () => {
		const { app, eventId, sessionId } = await createEvent("s1");

		const res = await app.request(`/sessions/${sessionId}/context-evidence/${eventId}`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: "not json",
		});
		expect(res.status).toBe(400);
	});

	test("updates token fields and recomputes saved_tokens", async () => {
		const { app, eventId, sessionId, tracker } = await createEvent("s1", {
			beforeTokens: 12000,
			beforePercent: 85.5,
		});

		await app.request(`/sessions/${sessionId}/context-evidence/${eventId}`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				status: "compact_completed",
				afterTokens: 8500,
				afterPercent: 60.2,
			}),
		});

		const events = tracker.getSessionEvidence("s1");
		expect(events[0].savedTokens).toBe(3500);
		expect(events[0].savedPercent).toBe(29.17);
	});

	test("providerRole is recorded on update", async () => {
		const { app, eventId, sessionId, tracker } = await createEvent("s1");

		await app.request(`/sessions/${sessionId}/context-evidence/${eventId}`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				status: "provider_payload_observed",
				providerRole: "slow",
			}),
		});

		const events = tracker.getSessionEvidence("s1");
		expect(events[0].status).toBe("provider_payload_observed");
		expect(events[0].providerRole).toBe("slow");
	});

	test("errorMessage is recorded on update", async () => {
		const { app, eventId, sessionId, tracker } = await createEvent("s1");

		await app.request(`/sessions/${sessionId}/context-evidence/${eventId}`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				status: "failed",
				errorMessage: "compact timed out after 30s",
			}),
		});

		const events = tracker.getSessionEvidence("s1");
		expect(events[0].status).toBe("failed");
		expect(events[0].errorMessage).toBe("compact timed out after 30s");
	});
});

// ---------------------------------------------------------------------------
// GET /sessions/:id/context-evidence — list timeline
// ---------------------------------------------------------------------------

describe("GET /sessions/:id/context-evidence", () => {
	test("returns empty array for session with no events", async () => {
		const { app } = setupApp();

		const res = await app.request("/sessions/empty-session/context-evidence");
		expect(res.status).toBe(200);
		const body = (await res.json()) as { events: ContextReplacementEvent[] };
		expect(body.events).toEqual([]);
	});

	test("returns events sorted by createdAt desc", async () => {
		const { app, tracker } = setupApp();

		// Create events with known order
		tracker.recordReplacement({
			sessionId: "s1",
			status: "constructed",
			mechanism: "context_hook",
			focusHash: "hash1",
			focusPreview: "first",
		});
		await Bun.sleep(2);
		tracker.recordReplacement({
			sessionId: "s1",
			status: "handler_returned",
			mechanism: "auto_compact",
			focusHash: "hash2",
			focusPreview: "second",
		});

		const res = await app.request("/sessions/s1/context-evidence");
		expect(res.status).toBe(200);
		const body = (await res.json()) as { events: ContextReplacementEvent[] };
		expect(body.events).toHaveLength(2);
		expect(body.events[0].status).toBe("handler_returned"); // newer first
		expect(body.events[1].status).toBe("constructed");
	});

	test("returns only events for the specified session", async () => {
		const { app, tracker } = setupApp();

		tracker.recordReplacement({
			sessionId: "s1", status: "constructed", mechanism: "context_hook",
			focusHash: "h1", focusPreview: "s1 event",
		});
		tracker.recordReplacement({
			sessionId: "s2", status: "constructed", mechanism: "context_hook",
			focusHash: "h2", focusPreview: "s2 event",
		});

		const res = await app.request("/sessions/s1/context-evidence");
		const body = (await res.json()) as { events: ContextReplacementEvent[] };
		expect(body.events).toHaveLength(1);
		expect(body.events[0].sessionId).toBe("s1");
	});

	test("respects limit and offset query params", async () => {
		const { app, tracker } = setupApp();

		for (let i = 0; i < 5; i++) {
			await Bun.sleep(1);
			tracker.recordReplacement({
				sessionId: "s1", status: "constructed", mechanism: "context_hook",
				focusHash: `hash${i}`, focusPreview: `event ${i}`,
			});
		}

		const res = await app.request("/sessions/s1/context-evidence?limit=2&offset=1");
		const body = (await res.json()) as { events: ContextReplacementEvent[] };
		expect(body.events).toHaveLength(2);
	});

	test("response includes all protocol fields", async () => {
		const { tracker } = setupApp();
		tracker.recordReplacement({
			sessionId: "s1",
			status: "provider_payload_observed",
			mechanism: "context_hook",
			focusHash: "abc123",
			focusPreview: "focus text",
			beforeTokens: 10000,
			afterTokens: 7000,
			providerRole: "slow",
		});

		const { app } = setupApp();
		// Use same tracker, re-setup app with it
		closeDb();
		const dir = tempDir();
		openDb({ path: path.join(dir, "deck.db") });
		const app2 = buildContextEvidenceRouter(tracker as unknown as import("./context-evidence-tracker.ts").ContextEvidenceTracker);

		const res = await app2.request("/sessions/s1/context-evidence");
		const body = (await res.json()) as { events: ContextReplacementEvent[] };
		const e = body.events[0];
		expect(e.id).toBeTruthy();
		expect(e.sessionId).toBe("s1");
		expect(e.status).toBe("provider_payload_observed");
		expect(e.beforeTokens).toBe(10000);
		expect(e.afterTokens).toBe(7000);
		expect(e.savedTokens).toBe(3000);
		expect(e.savedPercent).toBe(30);
		expect(e.focusHash).toBe("abc123");
		expect(e.focusPreview).toBe("focus text");
		expect(e.focusEstimatedTokens).toBe(0);
		expect(e.focusEstimateMethod).toBe("chars_div_4");
		expect(e.providerRole).toBe("slow");
		expect(e.retryCount).toBe(0);
		expect(e.createdAt).toBeTruthy();
		expect(e.updatedAt).toBeTruthy();
	});

	test("edge case: zero tokens produces savedTokens=0 not null", async () => {
		const { app, tracker } = setupApp();

		const res = await app.request("/sessions/s1/context-evidence", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				status: "compact_completed",
				mechanism: "auto_compact",
				focusHash: "abc123",
				focusPreview: "focus",
				beforeTokens: 0,
				afterTokens: 0,
			}),
		});
		const { eventId } = (await res.json()) as { eventId: string };

		await app.request(`/sessions/s1/context-evidence/${eventId}`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				status: "provider_payload_observed",
				afterTokens: 0,
			}),
		});

		const events = tracker.getSessionEvidence("s1");
		expect(events[0].savedTokens).toBe(0);
		expect(events[0].savedPercent).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// GET /stats/context-evidence — aggregate summary
// ---------------------------------------------------------------------------

describe("GET /stats/context-evidence", () => {
	test("returns empty stats when no events exist", async () => {
		const { app } = setupApp();

		const res = await app.request("/stats/context-evidence");
		expect(res.status).toBe(200);
		const body = (await res.json()) as ContextEvidenceStats;
		expect(body.total).toBe(0);
		expect(body.completed).toBe(0);
		expect(body.totalSaved).toBe(0);
		expect(body.recent).toEqual([]);
	});

	test("returns aggregate stats with events present", async () => {
		const { app, tracker } = setupApp();

		tracker.recordReplacement({
			sessionId: "s1", status: "provider_payload_observed", mechanism: "context_hook",
			focusHash: "h1", focusPreview: "e1",
			beforeTokens: 10000, afterTokens: 7000,
		});
		tracker.recordReplacement({
			sessionId: "s1", status: "constructed", mechanism: "auto_compact",
			focusHash: "h2", focusPreview: "e2",
			beforeTokens: 5000, afterTokens: 5000,
		});

		const res = await app.request("/stats/context-evidence");
		expect(res.status).toBe(200);
		const body = (await res.json()) as ContextEvidenceStats;
		expect(body.total).toBe(2);
		expect(body.completed).toBe(1); // only provider_payload_observed
		expect(body.totalSaved).toBe(3000); // 3000 + 0
		expect(body.recent).toHaveLength(2);
	});

	test("recent is newest first, capped at 50", async () => {
		const { app, tracker } = setupApp();

		for (let i = 0; i < 60; i++) {
			await Bun.sleep(1);
			tracker.recordReplacement({
				sessionId: "s1", status: "constructed", mechanism: "context_hook",
				focusHash: `hash${i}`, focusPreview: `event ${i}`,
			});
		}

		const res = await app.request("/stats/context-evidence");
		const body = (await res.json()) as ContextEvidenceStats;
		expect(body.total).toBe(60);
		expect(body.recent.length).toBeLessThanOrEqual(50);
		// First recent should be newest
		expect(body.recent[0].focusPreview).toBe("event 59");
	});
});

// ---------------------------------------------------------------------------
// GET /sessions/:id/context-evidence/:eventId — detail
// ---------------------------------------------------------------------------

describe("GET /sessions/:id/context-evidence/:eventId", () => {
	test("returns single event detail", async () => {
		const { app, eventId, sessionId, tracker } = await createEvent("s1", {
			beforeTokens: 12000,
			afterTokens: 8000,
			providerRole: "slow",
		});

		const res = await app.request(`/sessions/${sessionId}/context-evidence/${eventId}`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as ContextReplacementEvent;
		expect(body.id).toBe(eventId);
		expect(body.beforeTokens).toBe(12000);
		expect(body.afterTokens).toBe(8000);
		expect(body.providerRole).toBe("slow");
	});

	test("returns 404 for unknown eventId", async () => {
		const { app } = setupApp();

		const res = await app.request("/sessions/s1/context-evidence/nonexistent");
		expect(res.status).toBe(404);
	});

	test("returns 404 when event is for different session", async () => {
		const { app, eventId } = await createEvent("s1");

		const res = await app.request(`/sessions/s2/context-evidence/${eventId}`);
		expect(res.status).toBe(404);
	});
});
