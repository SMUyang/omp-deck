import { describe, expect, test } from "bun:test";

import { buildStatusPanelViewModel } from "./status/StatusPanel.tsx";
import type { SessionUi } from "@/lib/types";
import type { ProviderUsageResponse } from "@omp-deck/protocol";

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

describe("StatusPanel view model", () => {
	test("derives session, context, chat, and provider usage rows", () => {
		const vm = buildStatusPanelViewModel(session, providerUsage);

		expect(vm.sessionRows).toContainEqual({ label: "model", value: "zai/glm-5.2" });
		expect(vm.contextLine).toBe("42.0k / 200.0k · 21.0%");
		expect(vm.chatLine).toContain("1.3k tokens");
		expect(vm.providerSections[0]?.title).toBe("zai");
		expect(vm.providerSections[0]?.limits[0]?.summary).toBe("92.0% used · 8.0% left");
	});
});
