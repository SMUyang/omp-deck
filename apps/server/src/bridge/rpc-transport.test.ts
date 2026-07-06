import { describe, expect, test } from "bun:test";

import { getRpcCommandTimeoutMs, selectPendingResponseKey } from "./rpc-transport.ts";

describe("RPC transport response correlation", () => {
	test("matches an idless legacy response to the sole pending command of that type", () => {
		const key = selectPendingResponseKey(
			{ command: "set_subagent_subscription" },
			[
				{ id: "r1", command: "set_subagent_subscription" },
			],
		);

		expect(key).toBe("r1");
	});

	test("does not guess when an idless legacy response matches multiple pending commands", () => {
		const key = selectPendingResponseKey(
			{ command: "get_state" },
			[
				{ id: "r1", command: "get_state" },
				{ id: "r2", command: "get_state" },
			],
		);

		expect(key).toBeUndefined();
	});
});

describe("RPC transport command timeouts", () => {
	test("allows compact to run longer than ordinary RPC commands", () => {
		expect(getRpcCommandTimeoutMs({ type: "get_state" })).toBe(60_000);
		expect(getRpcCommandTimeoutMs({ type: "compact" })).toBeGreaterThan(120_000);
	});

	test("allows auto compact callers to apply a shorter local budget", () => {
		expect(getRpcCommandTimeoutMs({ type: "compact" }, { timeoutMs: 10_000 })).toBe(10_000);
	});
});
