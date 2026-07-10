import type {
	ContextReplacementEvent,
	ContextReplacementStatus,
	CreateContextEvidenceRequest,
	UpdateContextEvidenceRequest,
} from "@omp-deck/protocol";
import { Hono } from "hono";

import type { ContextEvidenceTracker } from "./context-evidence-tracker.ts";

/**
 * POST   /sessions/:id/context-evidence              – create event
 * GET    /sessions/:id/context-evidence              – list events for session
 * POST   /sessions/:id/context-evidence/:eventId      – update event status
 */
export function buildContextEvidenceRouter(tracker: ContextEvidenceTracker): Hono {
	const app = new Hono();

	// ── Create ────────────────────────────────────────────────────────────

	app.post("/sessions/:id/context-evidence", async (c) => {
		const sessionId = c.req.param("id");

		let body: CreateContextEvidenceRequest;
		try {
			body = (await c.req.json()) as CreateContextEvidenceRequest;
		} catch {
			return c.json({ error: "invalid json body" }, 400);
		}

		if (!body.status || !body.mechanism) {
			return c.json({ error: "status and mechanism are required" }, 400);
		}
		if (!body.focusHash || !body.focusPreview) {
			return c.json({ error: "focusHash and focusPreview are required" }, 400);
		}

		const eventId = tracker.recordReplacement({
			sessionId,
			status: body.status,
			mechanism: body.mechanism,
			beforeTokens: body.beforeTokens ?? null,
			beforePercent: body.beforePercent ?? null,
			afterTokens: body.afterTokens ?? null,
			afterPercent: body.afterPercent ?? null,
			focusHash: body.focusHash,
			focusPreview: body.focusPreview,
			focusEstimatedTokens: body.estimatedFocusTokens ?? 0,
			focusEstimateMethod: body.focusEstimateMethod ?? "chars_div_4",
			providerRole: body.providerRole ?? null,
			errorMessage: body.errorMessage ?? null,
		});

		return c.json({ eventId }, 201);
	});

	// ── List ──────────────────────────────────────────────────────────────

	app.get("/sessions/:id/context-evidence", (c) => {
		const sessionId = c.req.param("id");
		const limit = c.req.query("limit");
		const offset = c.req.query("offset");

		const events: ContextReplacementEvent[] = tracker.getSessionEvidence(
			sessionId,
			limit ? Number.parseInt(limit, 10) : undefined,
			offset ? Number.parseInt(offset, 10) : undefined,
		);

		return c.json({ events });
	});

	// ── Update ────────────────────────────────────────────────────────────

	app.post("/sessions/:id/context-evidence/:eventId", async (c) => {
		const eventId = c.req.param("eventId");

		let body: UpdateContextEvidenceRequest;
		try {
			body = (await c.req.json()) as UpdateContextEvidenceRequest;
		} catch {
			return c.json({ error: "invalid json body" }, 400);
		}

		if (!body.status) {
			return c.json({ error: "status is required" }, 400);
		}

		const updated = tracker.updateStatus(eventId, body.status as ContextReplacementStatus, {
			beforeTokens: body.beforeTokens,
			beforePercent: body.beforePercent,
			afterTokens: body.afterTokens,
			afterPercent: body.afterPercent,
			providerRole: body.providerRole,
			errorMessage: body.errorMessage,
		});

		if (!updated) {
			return c.json({ error: "event not found" }, 404);
		}

		return c.json({ ok: true });
	});


	// ── Stats ─────────────────────────────────────────────────────────────

	app.get("/stats/context-evidence", (c) => {
		const stats = tracker.getStats();
		return c.json(stats);
	});

	// ── Detail ────────────────────────────────────────────────────────────

	app.get("/sessions/:id/context-evidence/:eventId", (c) => {
		const eventId = c.req.param("eventId");
		const sessionId = c.req.param("id");
		const events = tracker.getSessionEvidence(sessionId);
		const event = events.find((e) => e.id === eventId);
		if (!event) {
			return c.json({ error: "event not found" }, 404);
		}
		return c.json(event);
	});
	return app;
}
