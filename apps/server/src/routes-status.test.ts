import { describe, expect, test } from "bun:test";

import { buildProviderUsageResponse } from "./routes-status.ts";

describe("status provider usage response", () => {
	test("normalizes omp usage JSON for the web status panel", async () => {
		const response = await buildProviderUsageResponse("/fake/omp", async () => ({
			generatedAt: 123,
			reports: [
				{
					provider: "zai",
					fetchedAt: 111,
					limits: [
						{
							label: "ZAI Token Quota",
							status: "warning",
							window: { label: "Quota", resetsAt: 999 },
							amount: {
								usedFraction: 0.92,
								remainingFraction: 0.08,
								unit: "tokens",
							},
						},
					],
					notes: ["shared account"],
				},
			],
		}));

		expect(response.error).toBeUndefined();
		expect(response.generatedAt).toBe(123);
		expect(response.reports).toHaveLength(1);
		expect(response.reports[0]).toMatchObject({ provider: "zai", fetchedAt: 111, notes: ["shared account"] });
		expect(response.reports[0]?.limits[0]).toMatchObject({
			label: "ZAI Token Quota",
			status: "warning",
			windowLabel: "Quota",
			resetsAt: 999,
			unit: "tokens",
			usedFraction: 0.92,
			remainingFraction: 0.08,
		});
	});

	test("returns an error response when provider usage fetch fails", async () => {
		const response = await buildProviderUsageResponse("/fake/omp", async () => {
			throw new Error("boom");
		});

		expect(response.reports).toEqual([]);
		expect(response.error).toContain("boom");
	});
});
