import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync, readFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parse as parseYaml } from "yaml";

import { buildOmpConfigRouter } from "./routes-omp-config.ts";

// ── Fixture setup ────────────────────────────────────────────────────────────

let tmpDir: string;
let savedAgentDir: string | undefined;

function seedConfig(content: string): void {
	writeFileSync(path.join(tmpDir, "config.yml"), content, "utf-8");
}

beforeEach(() => {
	tmpDir = mkdtempSync(path.join(os.tmpdir(), "omp-config-test-"));
	mkdirSync(tmpDir, { recursive: true });
	savedAgentDir = process.env.OMP_AGENT_DIR;
	process.env.OMP_AGENT_DIR = tmpDir;
});

afterEach(() => {
	if (savedAgentDir === undefined) delete process.env.OMP_AGENT_DIR;
	else process.env.OMP_AGENT_DIR = savedAgentDir;
	rmSync(tmpDir, { recursive: true, force: true });
});

function app() {
	return buildOmpConfigRouter();
}

function readConfigOnDisk(): Record<string, unknown> {
	const raw = readFileSync(path.join(tmpDir, "config.yml"), "utf-8");
	return parseYaml(raw) as Record<string, unknown>;
}

// ── GET: redaction ───────────────────────────────────────────────────────────

describe("GET /settings/omp-config — secret redaction", () => {
	test("redacts apiKey/token/password string values from the response", async () => {
		seedConfig([
			"defaultThinkingLevel: high",
			"github:",
			"  token: ghp_abc123",
			"providers:",
			"  custom:",
			"    apiKey: sk-secret-xyz",
			"    baseUrl: https://api.example.com",
		].join("\n"));

		const res = await app().request("/settings/omp-config");
		expect(res.status).toBe(200);
		const body = (await res.json()) as { config: Record<string, unknown> };

		const config = body.config;
		expect(config).toHaveProperty("defaultThinkingLevel", "high");
		expect((config.github as Record<string, unknown>).token).toBe("[redacted]");
		const providers = (config.providers as Record<string, Record<string, unknown>> | undefined)?.custom;
		expect(providers?.apiKey).toBe("[redacted]");
		// Non-secret neighbors are preserved verbatim.
		expect(providers?.baseUrl).toBe("https://api.example.com");
	});

	test("does NOT redact booleans/numbers under token-like keys (showTokenUsage)", async () => {
		seedConfig(["display:", "  showTokenUsage: true"].join("\n"));
		const res = await app().request("/settings/omp-config");
		const body = (await res.json()) as { config: Record<string, unknown> };
		expect((body.config.display as Record<string, unknown>).showTokenUsage).toBe(true);
	});

	test("does NOT redact non-secret keys like contextWindow", async () => {
		seedConfig(["compaction:", "  thresholdPercent: 80"].join("\n"));
		const res = await app().request("/settings/omp-config");
		const body = (await res.json()) as { config: Record<string, unknown> };
		expect((body.config.compaction as Record<string, unknown>).thresholdPercent).toBe(80);
	});
});

// ── PATCH: dangerous keys ────────────────────────────────────────────────────

describe("PATCH /settings/omp-config — dangerous key rejection", () => {
	test.each(["__proto__", "constructor", "prototype"])(
		"rejects %s with 400",
		async (dangerousKey) => {
			seedConfig("defaultThinkingLevel: high\n");
			const res = await app().request("/settings/omp-config", {
				method: "PATCH",
				body: JSON.stringify({ updates: { [dangerousKey]: { polluted: true } } }),
			});
			expect(res.status).toBe(400);
			// No write happened.
			expect(Object.hasOwn(readConfigOnDisk(), dangerousKey)).toBe(false);
		},
	);

	test("rejects nested dangerous key inside a nested object", async () => {
		seedConfig("compaction:\n  enabled: true\n");
		const res = await app().request("/settings/omp-config", {
			method: "PATCH",
			body: JSON.stringify({ updates: { compaction: { ["__proto__"]: { x: 1 } } } }),
		});
		expect(res.status).toBe(400);
		expect((readConfigOnDisk().compaction as Record<string, unknown>).enabled).toBe(true);
	});
});

// ── PATCH: schema type validation ────────────────────────────────────────────

describe("PATCH /settings/omp-config — schema type validation", () => {
	test("rejects boolean field with a number value", async () => {
		seedConfig("autoResume: false\n");
		const res = await app().request("/settings/omp-config", {
			method: "PATCH",
			body: JSON.stringify({ updates: { autoResume: 42 } }),
		});
		expect(res.status).toBe(400);
		expect(readConfigOnDisk().autoResume).toBe(false);
	});

	test("rejects enum field with an out-of-range value", async () => {
		seedConfig("defaultThinkingLevel: high\n");
		const res = await app().request("/settings/omp-config", {
			method: "PATCH",
			body: JSON.stringify({ updates: { defaultThinkingLevel: "ultra" } }),
		});
		expect(res.status).toBe(400);
		expect(readConfigOnDisk().defaultThinkingLevel).toBe("high");
	});

	test("rejects number field with a string value", async () => {
		seedConfig("retry:\n  maxRetries: 3\n");
		const res = await app().request("/settings/omp-config", {
			method: "PATCH",
			body: JSON.stringify({ updates: { retry: { maxRetries: "lots" } } }),
		});
		expect(res.status).toBe(400);
		expect((readConfigOnDisk().retry as Record<string, unknown>).maxRetries).toBe(3);
	});

	test("accepts a valid nested update and persists it", async () => {
		seedConfig("retry:\n  maxRetries: 3\n");
		const res = await app().request("/settings/omp-config", {
			method: "PATCH",
			body: JSON.stringify({ updates: { retry: { maxRetries: 5 } } }),
		});
		expect(res.status).toBe(200);
		expect((readConfigOnDisk().retry as Record<string, unknown>).maxRetries).toBe(5);
	});

	test("allows unknown top-level keys (forward compatibility with omp)", async () => {
		seedConfig("defaultThinkingLevel: high\n");
		const res = await app().request("/settings/omp-config", {
			method: "PATCH",
			body: JSON.stringify({ updates: { futureSetting: { value: 1 } } }),
		});
		expect(res.status).toBe(200);
		expect((readConfigOnDisk().futureSetting as Record<string, unknown>).value).toBe(1);
	});
});

// ── PATCH: [redacted] placeholder keeps existing secrets ─────────────────────

describe("PATCH /settings/omp-config — [redacted] placeholder", () => {
	test("saving a redacted value back does NOT clobber the real secret", async () => {
		seedConfig(["github:", "  token: ghp_real_secret"].join("\n"));
		const res = await app().request("/settings/omp-config", {
			method: "PATCH",
			body: JSON.stringify({ updates: { github: { token: "[redacted]" } } }),
		});
		expect(res.status).toBe(200);
		const disk = readConfigOnDisk();
		expect((disk.github as Record<string, unknown>).token).toBe("ghp_real_secret");
	});

	test("null deletes a key", async () => {
		seedConfig(["github:", "  token: ghp_real_secret"].join("\n"));
		const res = await app().request("/settings/omp-config", {
			method: "PATCH",
			body: JSON.stringify({ updates: { github: { token: null } } }),
		});
		expect(res.status).toBe(200);
		expect((readConfigOnDisk().github as Record<string, unknown>).token).toBeUndefined();
	});

	test("PATCH response is also redacted", async () => {
		seedConfig(["github:", "  token: ghp_real_secret"].join("\n"));
		const res = await app().request("/settings/omp-config", {
			method: "PATCH",
			body: JSON.stringify({ updates: { quietStartup: true } }),
		});
		const body = (await res.json()) as { config: Record<string, unknown> };
		expect((body.config.github as Record<string, unknown>).token).toBe("[redacted]");
		expect((body.config.github as Record<string, unknown>).token).not.toBe("ghp_real_secret");
	});
});
