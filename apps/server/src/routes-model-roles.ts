import { Hono } from "hono";
import type { ModelInfo } from "@omp-deck/protocol";

export interface ModelRolesSnapshot {
	roles: Record<string, string>;
	models: ModelInfo[];
}

export interface ModelRolesPatchRequest {
	roles?: Record<string, string | null>;
}

export interface ModelRolesRouterDeps {
	ompSettings?: {
		get(): Promise<ModelRolesSnapshot>;
		patch(updates: ModelRolesPatchRequest): Promise<ModelRolesSnapshot>;
		put(roles: Record<string, string>): Promise<ModelRolesSnapshot>;
	};
	/** Called after a successful PATCH/PUT so the backend can hot-reload
	 *  model-role changes (e.g. restart the omp subprocess in RPC mode). */
	onRolesChanged?: () => Promise<void>;
}

type SerializedJob<T> = () => Promise<T>;

export function buildModelRolesRouter(deps: ModelRolesRouterDeps): Hono {
	const app = new Hono();
	let writeChain: Promise<unknown> = Promise.resolve();

	app.get("/settings/model-roles", async (c) => {
		if (!deps.ompSettings) return c.json({ error: "model roles are unavailable for this backend" }, 501);
		return c.json(await deps.ompSettings.get());
	});

	app.patch("/settings/model-roles", async (c) => {
		if (!deps.ompSettings) return c.json({ error: "model roles are unavailable for this backend" }, 501);
		let body: ModelRolesPatchRequest;
		try {
			body = (await c.req.json()) as ModelRolesPatchRequest;
		} catch {
			return c.json({ error: "invalid json body" }, 400);
		}
		const error = validatePatchBody(body);
		if (error) return c.json({ error }, 400);
		try {
			const result = await serializeWrite(() => deps.ompSettings!.patch(body));
			if (deps.onRolesChanged) await deps.onRolesChanged();
			return c.json(result);
		} catch (err) {
			return modelRoleErrorResponse(c, err);
		}
	});

	app.put("/settings/model-roles", async (c) => {
		if (!deps.ompSettings) return c.json({ error: "model roles are unavailable for this backend" }, 501);
		let body: { roles?: Record<string, string> };
		try {
			body = (await c.req.json()) as { roles?: Record<string, string> };
		} catch {
			return c.json({ error: "invalid json body" }, 400);
		}
		const error = validatePutBody(body);
		if (error) return c.json({ error }, 400);
		const roles = body.roles;
		if (!roles) return c.json({ error: "roles is required" }, 400);
		try {
			const result = await serializeWrite(() => deps.ompSettings!.put(roles));
			if (deps.onRolesChanged) await deps.onRolesChanged();
			return c.json(result);
		} catch (err) {
			return modelRoleErrorResponse(c, err);
		}
	});

	function serializeWrite<T>(job: SerializedJob<T>): Promise<T> {
		const next = writeChain.then(job, job);
		writeChain = next.catch(() => undefined);
		return next;
	}

	return app;
}

function validatePatchBody(body: ModelRolesPatchRequest): string | undefined {
	if (!isRecord(body)) return "request body must be an object";
	if (body.roles === undefined) return undefined;
	if (!isRecord(body.roles)) return "roles must be an object";
	for (const [role, value] of Object.entries(body.roles)) {
		if (!role.trim()) return "role names must be non-empty";
		if (value !== null && typeof value !== "string") return `role ${role} must be a string or null`;
		if (typeof value === "string" && !value.trim()) return `role ${role} must not be empty`;
	}
	return undefined;
}

function validatePutBody(body: { roles?: Record<string, string> }): string | undefined {
	if (!isRecord(body)) return "request body must be an object";
	if (body.roles === undefined) return "roles is required";
	if (!isRecord(body.roles)) return "roles must be an object";
	for (const [role, value] of Object.entries(body.roles)) {
		if (!role.trim()) return "role names must be non-empty";
		if (typeof value !== "string") return `role ${role} must be a string`;
		if (!value.trim()) return `role ${role} must not be empty`;
	}
	return undefined;
}

function modelRoleErrorResponse(c: { json: (body: { error: string }, status: 422 | 500) => Response }, err: unknown): Response {
	const message = String((err as Error).message ?? err);
	if (message.startsWith("unknown model for role ")) return c.json({ error: message }, 422);
	return c.json({ error: message }, 500);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
