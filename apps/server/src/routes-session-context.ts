import { Hono } from "hono";

import type { AgentBridge } from "./bridge/types.ts";
import { getSessionContextGraph } from "./db/session-context.ts";
import { logger } from "./log.ts";
import { getStoredSessionContextPack, rebuildSessionContextFromFile } from "./session-context.ts";

const log = logger("routes-session-context");

function parseLimit(value: string | undefined, fallback: number): number {
	const parsed = value ? Number.parseInt(value, 10) : fallback;
	if (!Number.isFinite(parsed)) return fallback;
	return Math.min(Math.max(parsed, 1), 500);
}

function parseBudget(value: string | undefined): number {
	const parsed = value ? Number.parseInt(value, 10) : 4000;
	if (!Number.isFinite(parsed)) return 4000;
	return Math.min(Math.max(parsed, 500), 12000);
}

export function buildSessionContextRouter(bridge: AgentBridge): Hono {
	const app = new Hono();

	app.post("/sessions/:id/context/rebuild", async (c) => {
		const id = c.req.param("id");
		const handle = bridge.getSession(id);
		if (!handle?.sessionFile) return c.json({ error: "session not found or has no session file" }, 404);
		try {
			return c.json(await rebuildSessionContextFromFile({ sessionId: id, sessionFile: handle.sessionFile }));
		} catch (err) {
			log.error("context rebuild failed", err);
			return c.json({ error: String((err as Error).message ?? err) }, 500);
		}
	});

	app.get("/sessions/:id/context-pack", (c) => {
		const id = c.req.param("id");
		const handle = bridge.getSession(id);
		if (!handle) return c.json({ error: "session not found" }, 404);
		const query = c.req.query("q") ?? "";
		const budget = parseBudget(c.req.query("budget"));
		return c.json(getStoredSessionContextPack({ sessionId: id, query, budget }));
	});

	app.get("/sessions/:id/context-graph", (c) => {
		const id = c.req.param("id");
		const handle = bridge.getSession(id);
		if (!handle) return c.json({ error: "session not found" }, 404);
		return c.json(getSessionContextGraph(id, parseLimit(c.req.query("limit"), 200)));
	});

	return app;
}
