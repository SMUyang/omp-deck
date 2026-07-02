import type { Database } from "bun:sqlite";
import { Hono } from "hono";
import type { CreateWorkspaceRequest, CreateWorkspaceResponse, DeleteWorkspaceResponse, ListWorkspacesResponse, WorkspaceEntry } from "@omp-deck/protocol";
import type { Config } from "./config.ts";
import type { AgentBridge } from "./bridge/types.ts";
import { composeWorkspaceEntries, createUserWorkspace, deleteUserWorkspace, listUserWorkspaces } from "./workspaces.ts";

export interface WorkspacesRouterDeps {
	config: Config;
	db: Database;
	bridge: Pick<AgentBridge, "listSessions">;
}

async function listEntries(deps: WorkspacesRouterDeps): Promise<ListWorkspacesResponse> {
	const allSessions = await deps.bridge.listSessions({});
	const workspaces: WorkspaceEntry[] = composeWorkspaceEntries({
		defaultCwd: deps.config.defaultCwd,
		extraWorkspaces: deps.config.extraWorkspaces,
		userWorkspaces: listUserWorkspaces(deps.db),
		sessionCwds: allSessions.map((session) => session.cwd).filter((cwd): cwd is string => Boolean(cwd)),
	});
	return { workspaces, defaultCwd: deps.config.defaultCwd };
}

function isCreateWorkspaceRequest(value: unknown): value is CreateWorkspaceRequest {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const record = value as Record<string, unknown>;
	if (typeof record.cwd !== "string" || record.cwd.trim().length === 0) return false;
	if (record.label !== undefined && typeof record.label !== "string") return false;
	if (record.createDirectory !== undefined && typeof record.createDirectory !== "boolean") return false;
	return true;
}

export function buildWorkspacesRouter(deps: WorkspacesRouterDeps): Hono {
	const app = new Hono();
	app.get("/workspaces", async (c) => c.json(await listEntries(deps)));
	app.post("/workspaces", async (c) => {
		let body: unknown;
		try {
			body = await c.req.json();
		} catch {
			return c.json({ error: "invalid JSON body" }, 400);
		}
		if (!isCreateWorkspaceRequest(body)) return c.json({ error: "cwd is required" }, 400);
		try {
			const workspace = await createUserWorkspace(deps.db, body);
			const list = await listEntries(deps);
			const response: CreateWorkspaceResponse = { ...list, workspace };
			return c.json(response);
		} catch (err) {
			return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
		}
	});
	app.delete("/workspaces/:id", async (c) => {
		const deleted = deleteUserWorkspace(deps.db, c.req.param("id"));
		if (!deleted) return c.json({ error: "workspace not found" }, 404);
		const response: DeleteWorkspaceResponse = { ok: true, ...(await listEntries(deps)) };
		return c.json(response);
	});
	return app;
}
