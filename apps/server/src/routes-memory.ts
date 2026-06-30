import { Hono } from "hono";

import type { Config } from "./config.ts";
import { getMemoryGraph, getMemoryStatus, searchMemories } from "./memory-service.ts";

export function buildMemoryRouter(config: Config): Hono {
	const app = new Hono();

	app.get("/memory/status", (c) => {
		const agentDir = config.agentDir || "";
		return c.json(getMemoryStatus(agentDir));
	});

	app.get("/memory/search", (c) => {
		const query = c.req.query("q") ?? "";
		const limitRaw = c.req.query("limit");
		const limit = limitRaw ? Math.min(Math.max(parseInt(limitRaw, 10) || 50, 1), 200) : 50;
		const agentDir = config.agentDir || "";
		const { items } = searchMemories(agentDir, query, limit);
		return c.json({ query, count: items.length, items });
	});

	app.get("/memory/graph", (c) => {
		const query = c.req.query("q") ?? "";
		const bank = c.req.query("bank") || undefined;
		const limitRaw = c.req.query("limit");
		const limit = limitRaw ? parseInt(limitRaw, 10) : undefined;
		const agentDir = config.agentDir || "";
		return c.json(getMemoryGraph(agentDir, { bank, query, limit }));
	});

	return app;
}
