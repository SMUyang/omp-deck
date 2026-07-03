import { describe, expect, test } from "bun:test";

import { buildStatusPanelViewModel } from "./status/StatusPanel.tsx";
import type { SessionUi } from "@/lib/types";
import type { CpaUsageResponse, CpaUsageWindow, ProviderUsageResponse } from "@omp-deck/protocol";

const session: SessionUi = {
	sessionId: "s-1234567890",
	cwd: "/Users/hyan/project",
	sessionName: "Work",
	model: { provider: "zai", id: "glm-5.2" },
	messages: [],
	toolCalls: {},
	todoPhases: [],
	status: "idle",
	usage: { input: 1000, output: 250, cacheRead: 20, cacheWrite: 10, totalTokens: 1280, cost: 0.0123 },
	turnCount: 2,
	contextUsage: { tokens: 42000, contextWindow: 200000, percent: 21 },
};

const providerUsage: ProviderUsageResponse = {
	reports: [
		{
			provider: "zai",
			limits: [
				{
					label: "ZAI Token Quota",
					status: "warning",
					windowLabel: "Quota",
					unit: "tokens",
					usedFraction: 0.92,
					remainingFraction: 0.08,
				},
			],
		},
	],
};

function cpaWindow(
	window_seconds: number,
	totals: { requests: number; errors: number; error_rate: number; total_tokens: number },
): CpaUsageWindow {
	return {
		window_seconds,
		totals: {
			requests: totals.requests,
			errors: totals.errors,
			error_rate: totals.error_rate,
			input_tokens: 0,
			output_tokens: 0,
			cached_tokens: 0,
			reasoning_tokens: 0,
			total_tokens: totals.total_tokens,
		},
		per_api_key: [{ key_id: "default-key", n: Math.round(totals.requests * 0.6) }],
		per_model: [{ model: "glm-5.2", n: Math.round(totals.requests * 0.8) }],
		per_account: [],
	};
}

describe("StatusPanel view model", () => {
	test("derives session, context, chat, and provider usage rows", () => {
		const vm = buildStatusPanelViewModel(session, providerUsage);

		expect(vm.sessionRows).toContainEqual({ label: "model", value: "zai/glm-5.2" });
		expect(vm.contextLine).toBe("42.0k / 200.0k · 21.0%");
		expect(vm.chatLine).toContain("1.3k tokens");
		expect(vm.providerSections[0]?.title).toBe("zai");
		expect(vm.providerSections[0]?.limits[0]?.summary).toBe("92.0% used · 8.0% left");
	});

	test("keeps CPA usage errors separate from provider usage", () => {
		const cpaUnavailable: CpaUsageResponse = {
			available: false,
			generatedAt: 1,
			error: "CPA usage collector is not configured (set CPA_USAGE_BASE_URL/USERNAME/PASSWORD).",
		};

		const vm = buildStatusPanelViewModel(session, providerUsage, cpaUnavailable);

		// CPA reports its own error and renders no windows.
		expect(vm.cpaUsage.error).toContain("not configured");
		expect(vm.cpaUsage.windows).toEqual([]);
		// Provider usage is independent: still rendered, no provider error leaked from CPA.
		expect(vm.providerSections[0]?.title).toBe("zai");
		expect(vm.providerSections[0]?.limits[0]?.summary).toBe("92.0% used · 8.0% left");
		expect(vm.providerError).toBeUndefined();
	});

	test("formats 1h/24h/7d CPA windows with request, error, and token summaries", () => {
		const cpaUsage: CpaUsageResponse = {
			available: true,
			generatedAt: 1_700_000_000_000,
			windows: {
				h1: cpaWindow(3600, { requests: 100, errors: 2, error_rate: 0.02, total_tokens: 50_000 }),
				h24: cpaWindow(86_400, { requests: 2000, errors: 10, error_rate: 0.005, total_tokens: 1_200_000 }),
				d7: cpaWindow(604_800, { requests: 12_000, errors: 60, error_rate: 0.005, total_tokens: 7_500_000 }),
			},
		};

		const vm = buildStatusPanelViewModel(session, providerUsage, cpaUsage);

		expect(vm.cpaUsage.error).toBeUndefined();
		expect(vm.cpaUsage.windows.map((w) => w.label)).toEqual(["1h", "24h", "7d"]);

		const h1 = vm.cpaUsage.windows[0]!;
		expect(h1.requests).toContain("100");
		expect(h1.errors).toContain("2.0%");
		expect(h1.tokens).toContain("50.0k");
		expect(h1.topModels).toEqual(expect.arrayContaining([expect.stringContaining("glm-5.2")]));
		expect(h1.topApiKeys).toEqual(expect.arrayContaining([expect.stringContaining("default-key")]));

		const d7 = vm.cpaUsage.windows[2]!;
		expect(d7.requests).toContain("12,000");
		expect(d7.tokens).toContain("7.50M");
	});

	test("always shows CPA copy clarifying actual usage, not remaining quota", () => {
		const vm = buildStatusPanelViewModel(session, providerUsage);

		expect(vm.cpaUsage.description).toContain("not remaining quota");
	});
});
