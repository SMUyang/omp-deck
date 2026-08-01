import { describe, expect, test } from "bun:test";

import { Hono } from "hono";
import type { ModelInfo } from "@omp-deck/protocol";


import { buildModelRolesRouter, type ModelRolesRouterDeps } from "./routes-model-roles.ts";

// ── Inline response shape (kept local until protocol types are added) ──────────

interface ModelRolesResponse {
	roles: Record<string, string>;
	models: ModelInfo[];
}

// ── Fake OMP settings singleton (in-memory source of truth) ────────────────────

interface OmpSettingsSnapshot {
	roles: Record<string, string>;
	models: ModelInfo[];
}

/**
 * Minimal in-memory fake implementing the `ompSettings` seam.  The builder MUST
 * call through to this object on every request — it must not cache a snapshot.
 */
function createFakeOmpSettings(
	initialRoles: Record<string, string>,
	models: ModelInfo[],
): NonNullable<ModelRolesRouterDeps["ompSettings"]> {
	let roles: Record<string, string> = { ...initialRoles };
	return {
		async get(): Promise<OmpSettingsSnapshot> {
			return { roles: { ...roles }, models };
		},
		async patch(updates: { roles?: Record<string, string | null> }): Promise<OmpSettingsSnapshot> {
			for (const [key, value] of Object.entries(updates.roles ?? {})) {
				if (value === null) delete roles[key];
				else roles[key] = value;
			}
			return { roles: { ...roles }, models };
		},
		async put(nextRoles: Record<string, string>): Promise<OmpSettingsSnapshot> {
			roles = { ...nextRoles };
			return { roles: { ...roles }, models };
		},
	};
}

function mountRouter(ompSettings: NonNullable<ModelRolesRouterDeps["ompSettings"]>): Hono {
	const app = new Hono();
	app.route("/", buildModelRolesRouter({ ompSettings }));
	return app;
}

// ── Shared fixtures ────────────────────────────────────────────────────────────

const INITIAL_MODELS: ModelInfo[] = [
	{ provider: "anthropic", id: "claude-3-5-sonnet", label: "Claude 3.5 Sonnet", isAvailable: true },
	{ provider: "openai", id: "gpt-4o", label: "GPT-4o", isAvailable: true },
];

const INITIAL_ROLES: Record<string, string> = {
	advisor: "anthropic/claude-3-5-sonnet",
	adviser: "openai/gpt-4o",
	default: "anthropic/claude-3-5-sonnet",
};

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("model roles routes", () => {
	describe("GET /settings/model-roles", () => {
		test("returns dynamic role keys from OMP settings, preserving both advisor and adviser spellings", async () => {
			const app = mountRouter(createFakeOmpSettings(INITIAL_ROLES, INITIAL_MODELS));

			const res = await app.request("/settings/model-roles");
			expect(res.status).toBe(200);

			const body = (await res.json()) as ModelRolesResponse;
			// Both spellings survive — no enum collapse, no aliasing.
			expect(body.roles).toHaveProperty("advisor", "anthropic/claude-3-5-sonnet");
			expect(body.roles).toHaveProperty("adviser", "openai/gpt-4o");
			expect(body.roles).toHaveProperty("default", "anthropic/claude-3-5-sonnet");
		});

		test("returns the available models array so the UI can populate a model picker", async () => {
			const app = mountRouter(createFakeOmpSettings(INITIAL_ROLES, INITIAL_MODELS));

			const res = await app.request("/settings/model-roles");
			const body = (await res.json()) as ModelRolesResponse;

			expect(Array.isArray(body.models)).toBe(true);
			expect(body.models.length).toBeGreaterThan(0);
		});
	});

	describe("POST /settings/model-roles/auto-configure", () => {
		test("preserves an already-prefixed model ID through the route recommendation", async () => {
			const model: ModelInfo = {
				provider: "zai",
				id: "zai/glm-5.2",
				label: "GLM 5.2",
				isAvailable: true,
			};
			const app = new Hono();
			app.route("/", buildModelRolesRouter({
				ompSettings: createFakeOmpSettings({ default: "existing/model" }, [model]),
				listModels: async () => [model],
			}));

			const res = await app.request("/settings/model-roles/auto-configure", { method: "POST" });
			const body = (await res.json()) as {
				recommended: Record<string, string>;
				matched: Array<{ selector: string }>;
				existing: Record<string, string>;
			};

			expect(res.status).toBe(200);
			expect(Object.values(body.recommended)).toContain("zai/glm-5.2");
			expect(Object.values(body.recommended)).not.toContain("zai/zai/glm-5.2");
			expect(body.matched.map((entry) => entry.selector)).toContain("zai/glm-5.2");
			expect(body.existing).toEqual({ default: "existing/model" });
		});
	});

	describe("backend capability gate", () => {
		test("returns 501 when the active bridge cannot edit OMP model roles", async () => {
			const app = new Hono();
			app.route("/", buildModelRolesRouter({}));

			const res = await app.request("/settings/model-roles");

			expect(res.status).toBe(501);
		});
	});

	describe("write error mapping", () => {
		test("returns 422 when bridge validation rejects an unknown model", async () => {
			const app = mountRouter({
				async get() {
					return { roles: {}, models: INITIAL_MODELS };
				},
				async patch() {
					throw new Error("unknown model for role advisor: missing/model");
				},
				async put() {
					return { roles: {}, models: INITIAL_MODELS };
				},
			});

			const res = await app.request("/settings/model-roles", {
				method: "PATCH",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ roles: { advisor: "missing/model" } }),
			});

			expect(res.status).toBe(422);
		});

		test("returns 500 when bridge persistence fails for a non-validation reason", async () => {
			const app = mountRouter({
				async get() {
					return { roles: {}, models: INITIAL_MODELS };
				},
				async patch() {
					throw new Error("flush failed");
				},
				async put() {
					return { roles: {}, models: INITIAL_MODELS };
				},
			});

			const res = await app.request("/settings/model-roles", {
				method: "PATCH",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ roles: { advisor: "anthropic/claude-3-5-sonnet" } }),
			});

			expect(res.status).toBe(500);
		});
	});

	describe("PATCH /settings/model-roles", () => {
		test("accepts an arbitrary role key without fixed-enum rejection", async () => {
			const app = mountRouter(createFakeOmpSettings(INITIAL_ROLES, INITIAL_MODELS));

			const res = await app.request("/settings/model-roles", {
				method: "PATCH",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ roles: { "brand-new-role": "openai/gpt-4o" } }),
			});
			expect(res.status).toBe(200);

			const body = (await res.json()) as ModelRolesResponse;
			// New key is present alongside existing keys — no 400 for unknown role.
			expect(body.roles).toHaveProperty("brand-new-role", "openai/gpt-4o");
			expect(body.roles).toHaveProperty("advisor");
		});

		test("round-trips the OMP native provider/modelId string without splitting or re-formatting", async () => {
			const app = mountRouter(createFakeOmpSettings({}, INITIAL_MODELS));

			const res = await app.request("/settings/model-roles", {
				method: "PATCH",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ roles: { custom: "anthropic/claude-3-5-sonnet" } }),
			});
			expect(res.status).toBe(200);

			const body = (await res.json()) as ModelRolesResponse;
			// The '/' must survive verbatim — the value is one string, not an object.
			expect(body.roles["custom"]).toBe("anthropic/claude-3-5-sonnet");
		});

		test("removes a role key when the update value is null", async () => {
			const app = mountRouter(
				createFakeOmpSettings(
					{ advisor: "anthropic/claude-3-5-sonnet", planner: "openai/gpt-4o" },
					INITIAL_MODELS,
				),
			);

			const res = await app.request("/settings/model-roles", {
				method: "PATCH",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ roles: { advisor: null } }),
			});
			expect(res.status).toBe(200);

			const body = (await res.json()) as ModelRolesResponse;
			expect(body.roles).not.toHaveProperty("advisor");
			expect(body.roles).toHaveProperty("planner", "openai/gpt-4o");
		});
	});

	describe("PUT /settings/model-roles", () => {
		test("replaces the entire role set with the provided body", async () => {
			const app = mountRouter(
				createFakeOmpSettings(
					{ advisor: "anthropic/claude-3-5-sonnet", old: "openai/gpt-4o" },
					INITIAL_MODELS,
				),
			);

			const res = await app.request("/settings/model-roles", {
				method: "PUT",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ roles: { fresh: "anthropic/claude-3-5-sonnet" } }),
			});
			expect(res.status).toBe(200);

			const body = (await res.json()) as ModelRolesResponse;
			expect(body.roles).toEqual({ fresh: "anthropic/claude-3-5-sonnet" });
			expect(body.roles).not.toHaveProperty("advisor");
			expect(body.roles).not.toHaveProperty("old");
		});
	});

	describe("read-after-write consistency", () => {
		test("GET reflects the latest PATCH without caching the snapshot", async () => {
			const app = mountRouter(createFakeOmpSettings(INITIAL_ROLES, INITIAL_MODELS));

			const before = (await (await app.request("/settings/model-roles")).json()) as ModelRolesResponse;
			expect(before.roles).toHaveProperty("advisor");

			await app.request("/settings/model-roles", {
				method: "PATCH",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ roles: { researcher: "zai/glm-5" } }),
			});

			const after = (await (await app.request("/settings/model-roles")).json()) as ModelRolesResponse;
			// Builder must re-read from ompSettings on every request.
			expect(after.roles).toHaveProperty("researcher", "zai/glm-5");
			expect(after.roles).toHaveProperty("advisor");
		});
	});
});
