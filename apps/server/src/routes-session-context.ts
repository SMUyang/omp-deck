import { Hono } from "hono";

import type { SessionContextFocusResponse } from "@omp-deck/protocol";

import type { AgentBridge } from "./bridge/types.ts";
import { getSessionContextGraph, getSessionContextStatus } from "./db/session-context.ts";
import { logger } from "./log.ts";
import { getStoredQueryTopologyFocus, getStoredSessionContextPack, rebuildSessionContextFromFile } from "./session-context.ts";

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

async function resolveSessionContextTarget(bridge: AgentBridge, id: string): Promise<{ sessionFile?: string; exists: boolean }> {
	const handle = bridge.getSession(id);
	if (handle) return { sessionFile: handle.sessionFile, exists: true };
	const sessions = await bridge.listSessions({});
	const session = sessions.find((candidate) => candidate.id === id);
	if (!session) return { exists: false };
	return { sessionFile: session.path, exists: true };
}

export function buildSessionContextRouter(bridge: AgentBridge): Hono {
	const app = new Hono();

	app.post("/sessions/:id/context/rebuild", async (c) => {
		const id = c.req.param("id");
		try {
			const target = await resolveSessionContextTarget(bridge, id);
			if (!target.exists) return c.json({ error: "session not found" }, 404);
			if (!target.sessionFile) return c.json({ error: "session has no session file" }, 404);
			return c.json(await rebuildSessionContextFromFile({ sessionId: id, sessionFile: target.sessionFile }));
		} catch (err) {
			const msg = String((err as Error).message ?? err);
			if (msg.includes("session file not found")) {
				return c.json({ error: "session_file_not_ready", retryable: true }, 409);
			}
			log.error("context rebuild failed", err);
			return c.json({ error: msg }, 500);
		}
	});

	app.get("/sessions/:id/context-status", async (c) => {
		const id = c.req.param("id");
		try {
			const target = await resolveSessionContextTarget(bridge, id);
			if (!target.exists) return c.json({ error: "session not found" }, 404);
			return c.json(getSessionContextStatus(id));
		} catch (err) {
			log.error("context status failed", err);
			return c.json({ error: String((err as Error).message ?? err) }, 500);
		}
	});

	app.get("/sessions/:id/context-pack", async (c) => {
		const id = c.req.param("id");
		const query = c.req.query("q") ?? "";
		const budget = parseBudget(c.req.query("budget"));
		try {
			const target = await resolveSessionContextTarget(bridge, id);
			if (!target.exists) return c.json({ error: "session not found" }, 404);
			return c.json(getStoredSessionContextPack({ sessionId: id, query, budget }));
		} catch (err) {
			log.error("context pack failed", err);
			return c.json({ error: String((err as Error).message ?? err) }, 500);
		}
	});

	app.get("/sessions/:id/context-focus", async (c) => {
		const id = c.req.param("id");
		const query = c.req.query("q") ?? "";
		const rawPercent = c.req.query("contextPercent");
		const parsedPercent = rawPercent === undefined ? null : Number(rawPercent);
		try {
			const target = await resolveSessionContextTarget(bridge, id);
			if (!target.exists) return c.json({ error: "session not found" }, 404);
			const graph = getSessionContextGraph(id, 200);
			if (graph.nodes.length === 0) {
				return c.json({
					sessionId: id,
					query,
					focus: "",
					nodeCount: 0,
					edgeCount: 0,
					truncated: false,
					emptyReason: "session_not_built",
				} satisfies SessionContextFocusResponse);
			}
			const fullGraph = c.req.query("full") === "1" || c.req.query("full") === "true";
			const focus = await getStoredQueryTopologyFocus({
				sessionId: id,
				query,
				contextPercent: Number.isFinite(parsedPercent) ? parsedPercent : null,
				fullGraph,
			});
			return c.json({
				sessionId: id,
				query,
				focus,
				nodeCount: graph.totalNodes,
				edgeCount: graph.edges.length,
				truncated: graph.truncated,
				...(focus ? {} : { emptyReason: "no_relevant_context" as const }),
			} satisfies SessionContextFocusResponse);
		} catch (err) {
			log.error("context focus failed", err);
			return c.json({ error: String((err as Error).message ?? err) }, 500);
		}
	});

	app.get("/sessions/:id/context-graph", async (c) => {
		const id = c.req.param("id");
		try {
			const target = await resolveSessionContextTarget(bridge, id);
			if (!target.exists) return c.json({ error: "session not found" }, 404);
			return c.json(getSessionContextGraph(id, parseLimit(c.req.query("limit"), 200)));
		} catch (err) {
			log.error("context graph failed", err);
			return c.json({ error: String((err as Error).message ?? err) }, 500);
		}
	});

	return app;
}
