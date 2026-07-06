import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type {
	TopologyContextInjectionState,
	TopologyRerankConfig,
	UpdateTopologyContextInjectionRequest,
} from "@omp-deck/protocol";

import {
	MANAGED_ENV_KEYS_LOADED,
	readManagedEnvFile,
	writeManagedEnvUpdates,
} from "./env-store.ts";
import { buildOrientationRouter } from "./routes-orientation.ts";
import { MAINTENANCE_GATE_ENV_KEYS, TOPOLOGY_RERANK_ENV_KEYS } from "./orientation-store.ts";

const ENV_KEYS = [
	"OMP_DECK_DATA_DIR",
	"OMP_DECK_API_BASE",
	"OMP_DECK_TOPOLOGY_CONTEXT_ENABLED",
	"OMP_DECK_TOPOLOGY_CONTEXT_MAX_FOCUS_CHARS",
	"OMP_DECK_TOPOLOGY_CONTEXT_TIMEOUT_MS",
	"OMP_DECK_MAINTENANCE_GATE_DISABLED",
	"OMP_MAINTENANCE_GATE_MIN_OP_MSGS",
	"OMP_MAINTENANCE_GATE_MIN_RELEASE_AGE_MS",
	"OMP_MAINTENANCE_GATE_FIRE_FLOOR_MS",
	"OMP_DECK_TOPOLOGY_RERANK_ENABLED",
	"OMP_DECK_TOPOLOGY_RERANK_ROLE",
	"OMP_DECK_TOPOLOGY_RERANK_MIN_CONTEXT_PERCENT",
	"OMP_DECK_TOPOLOGY_RERANK_MIN_CANDIDATE_NODES",
	"OMP_DECK_TOPOLOGY_RERANK_LOCAL_CONFIDENCE_BELOW",
	"OMP_DECK_TOPOLOGY_RERANK_TIMEOUT_MS",
	"OMP_DECK_TOPOLOGY_RERANK_PROVIDER",
	"OMP_DECK_TOPOLOGY_RERANK_HTTP_BASE_URL",
	"OMP_DECK_TOPOLOGY_RERANK_HTTP_ENDPOINT_PATH",
	"OMP_DECK_TOPOLOGY_RERANK_HTTP_TIMEOUT_MS",
	"OMP_DECK_TOPOLOGY_RERANK_HTTP_CONFIDENCE_THRESHOLD",
	"OMP_DECK_TOPOLOGY_RERANK_HTTP_MIN_CANDIDATE_NODES",
	"OMP_DECK_TOPOLOGY_RERANK_HTTP_MIN_CONTEXT_PERCENT",
	"OMP_DECK_TOPOLOGY_RERANK_HTTP_AUTH_HEADER_NAME",
	"OMP_DECK_TOPOLOGY_RERANK_HTTP_MODEL",
	"OMP_DECK_TOPOLOGY_RERANK_HTTP_PROTOCOL",
	"HOME",
	"OMP_AGENT_DIR",
	"USERPROFILE",
];

const TOPOLOGY_MANAGED_KEYS = [
	"OMP_DECK_TOPOLOGY_CONTEXT_ENABLED",
	"OMP_DECK_API_BASE",
	"OMP_DECK_TOPOLOGY_CONTEXT_MAX_FOCUS_CHARS",
	"OMP_DECK_TOPOLOGY_CONTEXT_TIMEOUT_MS",
] as const;

let saved: Record<string, string | undefined>;
let tmpDataDir: string;
let tmpHomeDir: string;
let tmpAgentDir: string;
const tmpDirs: string[] = [];

beforeEach(() => {
	saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
	tmpDataDir = mkdtempSync(path.join(os.tmpdir(), "omp-deck-orient-route-"));
	tmpHomeDir = mkdtempSync(path.join(os.tmpdir(), "omp-deck-orient-route-home-"));
	tmpAgentDir = mkdtempSync(path.join(os.tmpdir(), "omp-deck-orient-route-agent-"));
	tmpDirs.push(tmpDataDir, tmpHomeDir, tmpAgentDir);
	process.env.OMP_DECK_DATA_DIR = tmpDataDir;
	process.env.HOME = tmpHomeDir;
	process.env.USERPROFILE = tmpHomeDir;
	process.env.OMP_AGENT_DIR = tmpAgentDir;
	MANAGED_ENV_KEYS_LOADED.clear();
	for (const k of ENV_KEYS) {
		if (
			k !== "OMP_DECK_DATA_DIR" &&
			k !== "HOME" &&
			k !== "USERPROFILE" &&
			k !== "OMP_AGENT_DIR"
		) {
			delete process.env[k];
		}
	}
});

afterEach(() => {
	for (const k of ENV_KEYS) {
		if (saved[k] === undefined) delete process.env[k];
		else process.env[k] = saved[k];
	}
	MANAGED_ENV_KEYS_LOADED.clear();
	for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("topology-context-injection routes", () => {
	describe("GET /orientation/topology-context-injection", () => {
		test("returns default disabled state with all defaults populated", async () => {
			const app = buildOrientationRouter();
			const res = await app.request("/orientation/topology-context-injection");
			expect(res.status).toBe(200);
			const body = (await res.json()) as TopologyContextInjectionState;
			expect(body.enabled).toBe(false);
			expect(body.active).toBe(false);
			expect(body.inactiveReason).toBe("disabled");
			expect(body.apiBase.value).toBe("http://127.0.0.1:8787");
			expect(body.apiBase.source).toBe("default");
			expect(body.maxFocusChars.value).toBe(50_000);
			expect(body.maxFocusChars.source).toBe("default");
			expect(body.timeoutMs.value).toBe(1500);
			expect(body.timeoutMs.source).toBe("default");
		});
	});

	describe("PUT /orientation/topology-context-injection", () => {
		test("accepts full enable with loopback apiBase and numeric knobs, persists managed env", async () => {
			const app = buildOrientationRouter();
			const req: UpdateTopologyContextInjectionRequest = {
				enabled: true,
				apiBase: "http://127.0.0.1:8787/api",
				maxFocusChars: 9000,
				timeoutMs: 2500,
			};
			const res = await app.request("/orientation/topology-context-injection", {
				method: "PUT",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(req),
			});
			expect(res.status).toBe(200);

			const body = (await res.json()) as TopologyContextInjectionState;
			expect(body.enabled).toBe(true);
			expect(body.apiBase.value).toBe("http://127.0.0.1:8787");
			expect(body.maxFocusChars.value).toBe(9000);
			expect(body.timeoutMs.value).toBe(2500);

			const envPath = path.join(tmpDataDir, ".env");
			const envContent = readFileSync(envPath, "utf-8");
			expect(envContent).toContain("OMP_DECK_TOPOLOGY_CONTEXT_MAX_FOCUS_CHARS=9000");
			expect(envContent).toContain("OMP_DECK_API_BASE=http://127.0.0.1:8787");
			expect(envContent).toContain("OMP_DECK_TOPOLOGY_CONTEXT_TIMEOUT_MS=2500");
		});

		test("accepts IPv6 loopback apiBase", async () => {
			const app = buildOrientationRouter();
			const res = await app.request("/orientation/topology-context-injection", {
				method: "PUT",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ apiBase: "http://[::1]:8787/api" }),
			});
			expect(res.status).toBe(200);
			const body = (await res.json()) as TopologyContextInjectionState;
			expect(body.apiBase.value).toBe("http://[::1]:8787");
		});

		test("rejects remote apiBase with 400 and mentions loopback HTTP", async () => {
			const app = buildOrientationRouter();
			const res = await app.request("/orientation/topology-context-injection", {
				method: "PUT",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ apiBase: "https://example.com/api" }),
			});
			expect(res.status).toBe(400);
			const body = (await res.json()) as { error: string };
			expect(body.error).toContain("loopback");
		});

		test("rejects non-positive numeric knob with 400 and mentions positive integer", async () => {
			const app = buildOrientationRouter();
			const res = await app.request("/orientation/topology-context-injection", {
				method: "PUT",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ maxFocusChars: 0 }),
			});
			expect(res.status).toBe(400);
			const body = (await res.json()) as { error: string };
			expect(body.error).toContain("positive integer");
		});

		test("rejects non-object json body with 400", async () => {
			const app = buildOrientationRouter();
			const res = await app.request("/orientation/topology-context-injection", {
				method: "PUT",
				headers: { "content-type": "application/json" },
				body: "null",
			});
			expect(res.status).toBe(400);
		});

		test("rejects non-boolean enabled value with 400", async () => {
			const app = buildOrientationRouter();
			const res = await app.request("/orientation/topology-context-injection", {
				method: "PUT",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ enabled: 123 }),
			});
			expect(res.status).toBe(400);
		});

		test("rejects non-string apiBase with 400", async () => {
			const app = buildOrientationRouter();
			const res = await app.request("/orientation/topology-context-injection", {
				method: "PUT",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ apiBase: 123 }),
			});
			expect(res.status).toBe(400);
		});

		test("rejects decimal numeric knob with 400", async () => {
			const app = buildOrientationRouter();
			const res = await app.request("/orientation/topology-context-injection", {
				method: "PUT",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ timeoutMs: 1.7 }),
			});
			expect(res.status).toBe(400);
			const body = (await res.json()) as { error: string };
			expect(body.error).toContain("positive integer");
		});

		test("null values clear managed env overrides, reverting to defaults", async () => {
			// Seed managed env directly so each test independently targets
			// the route behavior, not another endpoint's success.
			await writeManagedEnvUpdates({
				OMP_DECK_TOPOLOGY_CONTEXT_ENABLED: "1",
				OMP_DECK_API_BASE: "http://127.0.0.1:12700",
				OMP_DECK_TOPOLOGY_CONTEXT_MAX_FOCUS_CHARS: "5000",
				OMP_DECK_TOPOLOGY_CONTEXT_TIMEOUT_MS: "500",
			});

			const app = buildOrientationRouter();
			const res = await app.request("/orientation/topology-context-injection", {
				method: "PUT",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					enabled: false,
					apiBase: null,
					maxFocusChars: null,
					timeoutMs: null,
				}),
			});
			expect(res.status).toBe(200);

			const body = (await res.json()) as TopologyContextInjectionState;
			expect(body.enabled).toBe(false);
			expect(body.apiBase.value).toBe("http://127.0.0.1:8787");
			expect(body.apiBase.source).toBe("default");
			expect(body.maxFocusChars.source).toBe("default");
			expect(body.maxFocusChars.value).toBe(50_000);
			expect(body.timeoutMs.source).toBe("default");

			// Verify the managed env file no longer contains overridden keys.
			const file = readManagedEnvFile();
			for (const key of TOPOLOGY_MANAGED_KEYS) {
				expect(file.values.get(key)).toBeUndefined();
			}
		});
	});
});


describe("maintenance-gate route validation", () => {
	test("PUT rejects non-object json body with 400", async () => {
		const app = buildOrientationRouter();
		const res = await app.request("/orientation/maintenance-gate", {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: "null",
		});
		expect(res.status).toBe(400);
	});

	test("PUT rejects non-boolean enabled value with 400", async () => {
		const app = buildOrientationRouter();
		const res = await app.request("/orientation/maintenance-gate", {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ enabled: 123 }),
		});
		expect(res.status).toBe(400);
	});

	test("PUT rejects decimal numeric knob with 400", async () => {
		const app = buildOrientationRouter();
		const res = await app.request("/orientation/maintenance-gate", {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ minOpMsgs: 2.9 }),
		});
		expect(res.status).toBe(400);
	});

	test("PUT persists valid boolean and integer values", async () => {
		const app = buildOrientationRouter();
		const res = await app.request("/orientation/maintenance-gate", {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ enabled: false, minOpMsgs: 7 }),
		});
		expect(res.status).toBe(200);
		const file = readManagedEnvFile();
		expect(file.values.get(MAINTENANCE_GATE_ENV_KEYS.disabled)).toBe("1");
		expect(file.values.get(MAINTENANCE_GATE_ENV_KEYS.minOpMsgs)).toBe("7");
	});
});

describe("topology-rerank routes", () => {
	test("GET returns defaults (enabled=true) when unset", async () => {
		const app = buildOrientationRouter();
		const res = await app.request("/orientation/topology-rerank");
		expect(res.status).toBe(200);
		const body = (await res.json()) as TopologyRerankConfig;
		expect(body.enabled).toBe(true);
		expect(body.enabledSource).toBe("default");
		expect(body.rerankModelRole).toBe("topology_query_reranker");
		expect(body.minContextPercent.value).toBe(12);
		expect(body.minCandidateNodes.value).toBe(16);
		expect(body.localConfidenceBelow.value).toBe(0.72);
		expect(body.timeoutMs.value).toBe(30_000);
	});

	test("PUT persists explicit disabled and knob overrides", async () => {
		const app = buildOrientationRouter();
		const res = await app.request("/orientation/topology-rerank", {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ enabled: false, minCandidateNodes: 32, localConfidenceBelow: 0.5 }),
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as TopologyRerankConfig;
		expect(body.enabled).toBe(false);
		expect(body.enabledSource).toBe("env-file");
		expect(body.minCandidateNodes.value).toBe(32);
		expect(body.localConfidenceBelow.value).toBe(0.5);

		const envContent = readFileSync(path.join(tmpDataDir, ".env"), "utf-8");
		expect(envContent).toContain("OMP_DECK_TOPOLOGY_RERANK_ENABLED=0");
	});

	test("PUT persists decimal minContextPercent", async () => {
		const app = buildOrientationRouter();
		const res = await app.request("/orientation/topology-rerank", {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ minContextPercent: 12.5 }),
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as TopologyRerankConfig;
		expect(body.minContextPercent.value).toBe(12.5);
	});

	test("PUT persists rerank model role", async () => {
		const app = buildOrientationRouter();
		const res = await app.request("/orientation/topology-rerank", {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ rerankModelRole: "custom_topology_reranker" }),
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as TopologyRerankConfig;
		expect(body.rerankModelRole).toBe("custom_topology_reranker");
		expect(body.rerankModelRoleSource).toBe("env-file");

		const file = readManagedEnvFile();
		expect(file.values.get(TOPOLOGY_RERANK_ENV_KEYS.rerankModelRole)).toBe("custom_topology_reranker");
	});

	test("PUT null rerank model role clears override", async () => {
		await writeManagedEnvUpdates({
			[TOPOLOGY_RERANK_ENV_KEYS.rerankModelRole]: "custom_topology_reranker",
		});

		const app = buildOrientationRouter();
		const res = await app.request("/orientation/topology-rerank", {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ rerankModelRole: null }),
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as TopologyRerankConfig;
		expect(body.rerankModelRole).toBe("topology_query_reranker");
		expect(body.rerankModelRoleSource).toBe("default");

		const file = readManagedEnvFile();
		expect(file.values.get(TOPOLOGY_RERANK_ENV_KEYS.rerankModelRole)).toBeUndefined();
	});

	test("PUT rejects non-string rerank model role", async () => {
		const app = buildOrientationRouter();
		const res = await app.request("/orientation/topology-rerank", {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ rerankModelRole: 123 }),
		});
		expect(res.status).toBe(400);
	});

	test("PUT rejects non-object body", async () => {
		const app = buildOrientationRouter();
		const res = await app.request("/orientation/topology-rerank", {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: "null",
		});
		expect(res.status).toBe(400);
	});

	test("PUT rejects non-boolean enabled", async () => {
		const app = buildOrientationRouter();
		const res = await app.request("/orientation/topology-rerank", {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ enabled: 123 }),
		});
		expect(res.status).toBe(400);
	});

	test("PUT rejects out-of-range localConfidenceBelow", async () => {
		const app = buildOrientationRouter();
		const res = await app.request("/orientation/topology-rerank", {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ localConfidenceBelow: 1.5 }),
		});
		expect(res.status).toBe(400);
	});

	test("PUT persists rerank provider=http and http segment knobs", async () => {
		const app = buildOrientationRouter();
		const res = await app.request("/orientation/topology-rerank", {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				provider: "http",
				http: {
					baseUrl: "https://api.example.com",
					endpointPath: "/v1/rerank",
					protocol: "siliconflow-rerank",
					timeoutMs: 12000,
					confidenceThreshold: 0.5,
					minCandidateNodes: 8,
					minContextPercent: 20,
					authHeaderName: "X-API-Key",
					model: "BAAI/bge-reranker-v2-m3",
				},
			}),
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as TopologyRerankConfig;
		expect(body.provider.value).toBe("http");
		expect(body.http.baseUrl.value).toBe("https://api.example.com");
		expect(body.http.endpointPath.value).toBe("/v1/rerank");
		expect(body.http.protocol.value).toBe("siliconflow-rerank");
		expect(body.http.timeoutMs.value).toBe(12_000);
		expect(body.http.confidenceThreshold.value).toBe(0.5);
		expect(body.http.minCandidateNodes.value).toBe(8);
		expect(body.http.minContextPercent.value).toBe(20);
		expect(body.http.authHeaderName.value).toBe("X-API-Key");
		expect(body.http.model.value).toBe("BAAI/bge-reranker-v2-m3");

		const file = readManagedEnvFile();
		expect(file.values.get("OMP_DECK_TOPOLOGY_RERANK_PROVIDER")).toBe("http");
		expect(file.values.get("OMP_DECK_TOPOLOGY_RERANK_HTTP_BASE_URL")).toBe("https://api.example.com");
		expect(file.values.get("OMP_DECK_TOPOLOGY_RERANK_HTTP_ENDPOINT_PATH")).toBe("/v1/rerank");
		expect(file.values.get("OMP_DECK_TOPOLOGY_RERANK_HTTP_PROTOCOL")).toBe("siliconflow-rerank");
		expect(file.values.get("OMP_DECK_TOPOLOGY_RERANK_HTTP_TIMEOUT_MS")).toBe("12000");
		expect(file.values.get("OMP_DECK_TOPOLOGY_RERANK_HTTP_CONFIDENCE_THRESHOLD")).toBe("0.5");
		expect(file.values.get("OMP_DECK_TOPOLOGY_RERANK_HTTP_MIN_CANDIDATE_NODES")).toBe("8");
		expect(file.values.get("OMP_DECK_TOPOLOGY_RERANK_HTTP_MIN_CONTEXT_PERCENT")).toBe("20");
		expect(file.values.get("OMP_DECK_TOPOLOGY_RERANK_HTTP_AUTH_HEADER_NAME")).toBe("X-API-Key");
		expect(file.values.get("OMP_DECK_TOPOLOGY_RERANK_HTTP_MODEL")).toBe("BAAI/bge-reranker-v2-m3");
	});

	test("PUT null provider restores model_role", async () => {
		await writeManagedEnvUpdates({ OMP_DECK_TOPOLOGY_RERANK_PROVIDER: "http" });
		const app = buildOrientationRouter();
		const res = await app.request("/orientation/topology-rerank", {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ provider: null }),
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as TopologyRerankConfig;
		expect(body.provider.value).toBe("model_role");

		const file = readManagedEnvFile();
		expect(file.values.get("OMP_DECK_TOPOLOGY_RERANK_PROVIDER")).toBeUndefined();
	});

	test("PUT rejects invalid provider value", async () => {
		const app = buildOrientationRouter();
		const res = await app.request("/orientation/topology-rerank", {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ provider: "weird" }),
		});
		expect(res.status).toBe(400);
	});

	test("PUT null values clear managed env overrides", async () => {
		await writeManagedEnvUpdates({
			[TOPOLOGY_RERANK_ENV_KEYS.enabled]: "0",
			[TOPOLOGY_RERANK_ENV_KEYS.minCandidateNodes]: "64",
		});

		const app = buildOrientationRouter();
		const res = await app.request("/orientation/topology-rerank", {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ enabled: null, minCandidateNodes: null }),
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as TopologyRerankConfig;
		expect(body.enabled).toBe(true); // default restored
		expect(body.enabledSource).toBe("default");
		expect(body.minCandidateNodes.value).toBe(16); // default restored
		expect(body.minCandidateNodes.source).toBe("default");

		const file = readManagedEnvFile();
		expect(file.values.get(TOPOLOGY_RERANK_ENV_KEYS.enabled)).toBeUndefined();
		expect(file.values.get(TOPOLOGY_RERANK_ENV_KEYS.minCandidateNodes)).toBeUndefined();
	});
});
