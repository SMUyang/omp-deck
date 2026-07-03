import { afterEach, describe, expect, test } from "bun:test";
import type { RoutineStep } from "@omp-deck/protocol";
import type { RunContext } from "../types.ts";
import { executeAgentStep } from "./agent.ts";


interface SpawnOutcome {
	stdout: string;
	stderr: string;
	exitCode: number;
}

interface SpawnRecorder {
	/** Ordered list of model ids passed via `-m` across all spawn calls. */
	calls: string[];
}

const originalSpawn = Bun.spawn;

afterEach(() => {
	// Restore the real Bun.spawn so no other test file is polluted.
	const bunSpawn = Bun as unknown as { spawn: typeof Bun.spawn };
	bunSpawn.spawn = originalSpawn;
});

function makeCtx(): RunContext {
	return {
		run: {
			id: "run_fallback_test",
			started: "2026-07-03T00:00:00.000Z",
			iso_started: "2026-07-03T00:00:00.000Z",
			date: "2026-07-03",
			trigger_kind: "manual",
		},
		trigger: {},
		steps: {},
		env: {},
		secrets: {},
		state: {},
	};
}

function makeStep(model: string, fallbackModels: string[]): Extract<RoutineStep, { type: "agent" }> {
	return {
		id: "agent_step",
		type: "agent",
		prompt: "Say hello",
		model,
		fallback_models: fallbackModels,
	};
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((v) => typeof v === "string");
}

/**
 * Replace Bun.spawn with a stub that maps the `-m <model>` in the command
 * array to a fixed SpawnOutcome. Each call produces a fake subprocess whose
 * stdout/stderr are real ReadableStreams and whose `exited` resolves to the
 * configured exit code. Returns a recorder so tests can assert call order.
 */
function stubSpawnByModel(outcomes: Record<string, SpawnOutcome>): SpawnRecorder {
	const calls: string[] = [];
	const impl = (...args: unknown[]): unknown => {
		const cmd = args[0];
		if (!isStringArray(cmd)) {
			return {
				stdout: null,
				stderr: null,
				exited: Promise.resolve(1),
				kill() {},
				pid: -1,
				stdin: null,
			};
		}
		const mIdx = cmd.indexOf("-m");
		const model: string | undefined = mIdx >= 0 ? cmd[mIdx + 1] : undefined;
		if (model !== undefined) calls.push(model);
		const outcome: SpawnOutcome =
			model !== undefined && outcomes[model] !== undefined
				? outcomes[model]
				: { stdout: "", stderr: `no spawn outcome for model: ${model ?? "(none)"}`, exitCode: 1 };

		return {
			stdout: new Response(outcome.stdout).body,
			stderr: new Response(outcome.stderr).body,
			exited: Promise.resolve(outcome.exitCode),
			kill() {},
			pid: -1,
			stdin: null,
		};
	};

	const bunSpawn = Bun as unknown as { spawn: typeof Bun.spawn };
	bunSpawn.spawn = impl as unknown as typeof Bun.spawn;
	return { calls };
}

describe("executeAgentStep — model fallback", () => {
	test("tries fallback_models in order when primary fails, returns first success with its model and stdout", async () => {
		const recorder = stubSpawnByModel({
			"claude-sonnet-4-6": { stdout: "", stderr: "rate limited", exitCode: 1 },
			"gpt-4o-mini": { stdout: "", stderr: "unavailable", exitCode: 2 },
			"claude-haiku-4-5": { stdout: "Hello from Haiku", stderr: "", exitCode: 0 },
		});

		const step = makeStep("claude-sonnet-4-6", ["gpt-4o-mini", "claude-haiku-4-5"]);
		const result = await executeAgentStep(step, makeCtx(), new AbortController().signal, ".");

		expect(result.status).toBe("success");
		expect(result.model).toBe("claude-haiku-4-5");
		expect(result.stdoutExcerpt).toContain("Hello from Haiku");
		expect(recorder.calls).toEqual([
			"claude-sonnet-4-6",
			"gpt-4o-mini",
			"claude-haiku-4-5",
		]);
	});

	test("returns failed with evidence of every attempted model when all models fail", async () => {
		const recorder = stubSpawnByModel({
			"claude-sonnet-4-6": { stdout: "", stderr: "primary down", exitCode: 1 },
			"gpt-4o-mini": { stdout: "", stderr: "fallback down", exitCode: 2 },
			"claude-haiku-4-5": { stdout: "", stderr: "haiku down", exitCode: 3 },
		});

		const step = makeStep("claude-sonnet-4-6", ["gpt-4o-mini", "claude-haiku-4-5"]);
		const result = await executeAgentStep(step, makeCtx(), new AbortController().signal, ".");

		expect(result.status).toBe("failed");
		expect(result.error).toContain("claude-sonnet-4-6");
		expect(result.error).toContain("gpt-4o-mini");
		expect(result.error).toContain("claude-haiku-4-5");
		expect(recorder.calls).toEqual([
			"claude-sonnet-4-6",
			"gpt-4o-mini",
			"claude-haiku-4-5",
		]);
	});
});
