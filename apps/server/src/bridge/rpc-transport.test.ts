import { describe, expect, test } from "bun:test";

import { selectPendingResponseKey } from "./rpc-transport.ts";

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
