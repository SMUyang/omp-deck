import { Hono } from "hono";

import { getDb } from "./db/index.ts";

/**
 * GET /api/stats/context-savings
 *
 * Returns aggregate context replacement savings across all sessions from the
 * persistent context_replacement_events table, plus recent replacement events.
 * Stats survive process restart; they are not reset when the in-memory tracker
 * is recreated.
 */
export function buildContextSavingsRouter(): Hono {
	const app = new Hono();

	app.get("/stats/context-savings", (c) => {
		const db = getDb();

		const totalRow = db
			.query<{ n: number }, []>("SELECT COUNT(*) as n FROM context_replacement_events")
			.get();
		const completedRow = db
			.query<{ n: number }, []>(
				"SELECT COUNT(*) as n FROM context_replacement_events WHERE status = 'provider_payload_observed'",
			)
			.get();
		const totalSavedRow = db
			.query<{ n: number }, []>(
				"SELECT COALESCE(SUM(saved_tokens), 0) as n FROM context_replacement_events",
			)
			.get();
		const recent = db
			.query(
				`SELECT id, session_id AS "sessionId", status, mechanism,
				        before_tokens AS "beforeTokens", before_percent AS "beforePercent",
				        after_tokens AS "afterTokens", after_percent AS "afterPercent",
				        saved_tokens AS "savedTokens", saved_percent AS "savedPercent",
				        focus_hash AS "focusHash", focus_preview AS "focusPreview",
				        focus_estimated_tokens AS "focusEstimatedTokens",
				        'chars_div_4' AS "focusEstimateMethod",
				        provider_role AS "providerRole", error_message AS "errorMessage",
				        retry_count AS "retryCount", created_at AS "createdAt",
				        updated_at AS "updatedAt"
				 FROM context_replacement_events
				 ORDER BY created_at DESC, rowid DESC LIMIT 50`,
			)
			.all();

		return c.json({
			total: totalRow?.n ?? 0,
			completed: completedRow?.n ?? 0,
			totalSaved: totalSavedRow?.n ?? 0,
			recent,
		});
	});

	return app;
}
