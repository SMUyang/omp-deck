import { describe, expect, test } from "bun:test";

import { buildCpaUsageResponse } from "./routes-cpa-usage.ts";
import type { CpaUsageClientConfig, CpaUsageFetcher } from "./routes-cpa-usage.ts";

const PASSWORD = "super-secret-pass-123";

function makeConfig(overrides: Partial<CpaUsageClientConfig> = {}): CpaUsageClientConfig {
	return {
		baseUrl: "https://collector.example.test",
		username: "cpa",
		password: PASSWORD,
		timeoutMs: 5000,
		...overrides,
	};
}

interface FakeRoute {
	status?: number;
	body: unknown;
}

function makeFetcher(
	routes: Record<string, FakeRoute>,
	captured?: { auth?: string },
): CpaUsageFetcher {
	return async (url: string, init: RequestInit): Promise<Response> => {
		if (captured) {
			captured.auth = new Headers(init.headers).get("Authorization") ?? undefined;
		}
		const pathname = new URL(url).pathname;
		for (const [suffix, route] of Object.entries(routes)) {
			if (pathname.endsWith(suffix)) {
				return new Response(JSON.stringify(route.body), {
					status: route.status ?? 200,
					headers: { "content-type": "application/json" },
				});
			}
		}
		return new Response("{}", {
			status: 404,
			headers: { "content-type": "application/json" },
		});
	};
}

const healthBody = { ok: true, status: "healthy" };

function makeWindowBody(windowSeconds: number): Record<string, unknown> {
	return {
		window_seconds: windowSeconds,
		totals: {
			requests: 100,
			errors: 5,
			error_rate: 0.05,
			input_tokens: 10_000,
			output_tokens: 5_000,
			cached_tokens: 2_000,
			reasoning_tokens: 1_000,
			total_tokens: 18_000,
		},
		per_api_key: [{ key_id: "key-1", n: 80, total_tokens: 14_000 }],
		per_model: [{ model: "glm-4.6", n: 60, total_tokens: 12_000 }],
		per_account: [],
	};
}

describe("CPA usage response builder", () => {
	test("missing config returns available false with configuration error", async () => {
		const response = await buildCpaUsageResponse(undefined, makeFetcher({}));

		expect(response.available).toBe(false);
		expect(response.generatedAt).toEqual(expect.any(Number));
		expect(response.error).toBe(
			"CPA usage collector is not configured (set CPA_USAGE_BASE_URL/USERNAME/PASSWORD).",
		);
		expect(response.health).toBeUndefined();
		expect(response.windows).toBeUndefined();
	});

	test("successful health and all windows return normalized response", async () => {
		const fetcher = makeFetcher({
			"/health": { body: healthBody },
			"/usage/1h": { body: makeWindowBody(3600) },
			"/usage/24h": { body: makeWindowBody(86_400) },
			"/usage/7d": { body: makeWindowBody(604_800) },
		});

		const response = await buildCpaUsageResponse(makeConfig(), fetcher);

		expect(response.available).toBe(true);
		expect(response.error).toBeUndefined();
		expect(response.health).toEqual({ ok: true, status: "healthy" });
		expect(response.windows?.h1?.window_seconds).toBe(3600);
		expect(response.windows?.h24?.window_seconds).toBe(86_400);
		expect(response.windows?.d7?.window_seconds).toBe(604_800);
		expect(response.windows?.h1?.totals).toMatchObject({
			requests: 100,
			errors: 5,
			error_rate: 0.05,
			total_tokens: 18_000,
		});
		expect(response.windows?.h1?.per_model).toHaveLength(1);
		expect(response.windows?.h1?.per_api_key).toHaveLength(1);
	});

	test("malformed window payload is omitted while valid windows remain", async () => {
		const fetcher = makeFetcher({
			"/health": { body: healthBody },
			"/usage/1h": { body: makeWindowBody(3600) },
			"/usage/24h": { body: makeWindowBody(86_400) },
			"/usage/7d": { body: { totals: "not-an-object", junk: true } },
		});

		const response = await buildCpaUsageResponse(makeConfig(), fetcher);

		expect(response.available).toBe(true);
		expect(response.windows?.h1).toBeDefined();
		expect(response.windows?.h24).toBeDefined();
		expect(response.windows?.d7).toBeUndefined();
	});

	test("HTTP failure includes status code but never the password", async () => {
		const captured: { auth?: string } = {};
		const fetcher = makeFetcher(
			{
				"/health": { body: null, status: 401 },
				"/usage/1h": { body: null, status: 401 },
				"/usage/24h": { body: null, status: 500 },
				"/usage/7d": { body: null, status: 401 },
			},
			captured,
		);

		const response = await buildCpaUsageResponse(makeConfig({ password: PASSWORD }), fetcher);

		// Authorization header was sent on every request.
		expect(captured.auth).toMatch(/^Basic /);

		// Configured but collector returned errors.
		expect(response.available).toBe(true);
		expect(response.error).toBeTruthy();

		// Password must never appear in the response or error text.
		expect(response.error).not.toContain(PASSWORD);
		expect(JSON.stringify(response)).not.toContain(PASSWORD);
	});
});
