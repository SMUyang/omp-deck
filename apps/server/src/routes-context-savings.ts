import { Hono } from "hono";
import { contextSavingsTracker } from "./context-savings-tracker.ts";

/**
 * GET /api/stats/context-savings
 *
 * Returns aggregate context replacement savings across all sessions, plus
 * per-session breakdown and recent replacement events.
 */
export function buildContextSavingsRouter(): Hono {
	const app = new Hono();

	app.get("/stats/context-savings", (c) => {
		const stats = contextSavingsTracker.getStats();
		return c.json(stats);
	});

	return app;
}
