import { describe, expect, test } from "bun:test";
import type { SessionSnapshot } from "@omp-deck/protocol";

import { executeDeckSlashCommand } from "./deck-slash-commands.ts";
import { buildOmpUsageCommand, buildSessionStatusText, renderProviderUsageJson } from "./session-status.ts";

const snapshot: SessionSnapshot = {
	sessionId: "s-123",
	sessionFile: "/tmp/session.jsonl",
	cwd: "/workspace/project",
	model: { provider: "zai", id: "glm-5.2" },
	isStreaming: false,
	messages: [
		{
			role: "assistant",
			content: [{ type: "text", text: "ok" }],
			usage: {
				input: 1200,
				output: 300,
				cacheRead: 50,
				cacheWrite: 25,
				totalTokens: 1575,
				cost: { total: 0.0123 },
			},
		},
	],
	todoPhases: [],
	contextUsage: { tokens: 42000, contextWindow: 200000, percent: 21 },
};

describe("session status report", () => {
	test("builds a compact status report with session, context, chat usage, and provider usage", async () => {
		const text = await buildSessionStatusText({
			snapshot,
			providerUsageJson: {
				reports: [
					{
						provider: "zai",
						limits: [
							{
								label: "ZAI Token Quota",
								status: "warning",
								window: { label: "Quota", resetsAt: Date.now() + 3600000 },
								amount: { usedFraction: 0.92, remainingFraction: 0.08, unit: "tokens" },
							},
						],
					},
				],
			},
		});

		expect(text).toContain("Status");
		expect(text).toContain("zai/glm-5.2");
		expect(text).toContain("42.0k / 200.0k tokens (21.0%)");
		expect(text).toContain("1.6k tokens");
		expect(text).toContain("$0.012300");
		expect(text).toContain("ZAI Token Quota");
		expect(text).toContain("92.0% used");
	});

	test("renders pending context usage when RPC omits tokens or percent", async () => {
		const malformed = {
			...snapshot,
			contextUsage: { contextWindow: 200000 },
		} as unknown as SessionSnapshot;

		const text = await buildSessionStatusText({ snapshot: malformed, providerUsageJson: { reports: [] } });

		expect(text).toContain("200.0k window, usage refresh pending");
	});

	test("deck-native /status consumes the command instead of falling through", async () => {
		const result = await executeDeckSlashCommand("/status", {
			cwd: "/workspace/project",
			getStatusText: () => "Status\n- ok",
		});

		expect(result).toEqual({ kind: "consumed", output: "Status\n- ok" });
	});

	test("provider usage renderer orders current provider first", () => {
		const text = renderProviderUsageJson(
			{
				reports: [
					{
						provider: "other",
						limits: [
							{ label: "Other Daily", amount: { usedFraction: 0.1, unit: "requests" } },
						],
					},
					{
						provider: "zai",
						limits: [
							{ label: "ZAI Weekly", amount: { usedFraction: 0.9, unit: "tokens" } },
						],
					},
				],
			},
			"zai",
		);

		expect(text.indexOf("zai")).toBeLessThan(text.indexOf("other"));
	});

	test("provider usage command prefixes bun shebang scripts", async () => {
		const temp = await Bun.write(
			"/tmp/omp-deck-status-bun-script",
			"#!/usr/bin/env bun\nconsole.log('ok')\n",
		);
		expect(temp).toBeGreaterThan(0);
		const command = await buildOmpUsageCommand("/tmp/omp-deck-status-bun-script");

		if (process.platform === "win32") {
			expect(command).toEqual(["bun", "/tmp/omp-deck-status-bun-script", "usage", "--json"]);
		} else {
			expect(command).toEqual(["env", "-S", "bun", "/tmp/omp-deck-status-bun-script", "usage", "--json"]);
		}
	});

	test("provider usage command leaves native binaries direct", async () => {
		await Bun.write("/tmp/omp-deck-status-native", "not a shebang\n");

		const command = await buildOmpUsageCommand("/tmp/omp-deck-status-native");

		expect(command).toEqual(["/tmp/omp-deck-status-native", "usage", "--json"]);
	});
});
