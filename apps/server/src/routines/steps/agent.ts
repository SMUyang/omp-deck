/**
 * `agent` step: shell out to `omp -p <prompt>` headless. Captures stdout as
 * the agent's final text. Structured-output mode appends a JSON schema
 * instruction to the prompt and parses stdout as JSON.
 *
 * V1 caveats — documented for the V1.5 task that revisits this:
 *   - `skills_allowed` and `mcp_servers_allowed` aren't yet plumbed; the agent
 *     runs with its default surface. Will land when the bridge exposes
 *     per-invocation surface restriction.
 *   - Token counts are estimated from prompt+output character length using a
 *     ~4-char-per-token heuristic. Real counts require the in-process bridge
 *     path; cost is BYOK-billed anyway so the estimate is for budget caps
 *     only.
 */

import type { RoutineStep } from "@omp-deck/protocol";
import { costMicros } from "../budget.ts";
import { renderString } from "../template.ts";
import type { RunContext, StepResult } from "../types.ts";
import { validateRoutineSpec as _vrs } from "@omp-deck/protocol";
import { resolveOmpBin } from "../../config.ts";
import { buildOmpCommand } from "../../runtime-bun.ts";

void _vrs; // keep import; unused but ensures protocol re-export typechecks here

const MAX_EXCERPT = 8 * 1024;
/** Hard cap on the prompt arg so we don't blow Windows' ~32KB command-line limit. Truncates with a marker. */
const MAX_PROMPT_CHARS = 30 * 1024;
const CHARS_PER_TOKEN = 4;

export async function executeAgentStep(
	step: Extract<RoutineStep, { type: "agent" }>,
	context: RunContext,
	signal: AbortSignal,
	defaultCwd: string,
): Promise<StepResult> {
	let prompt = renderString(step.prompt, context as unknown as Record<string, unknown>);
	if (step.structured_output) {
		const schemaJson = JSON.stringify(step.structured_output.schema);
		prompt = `${prompt}\n\nRespond with ONLY JSON matching this schema (no prose, no fences):\n${schemaJson}`;
	}
	if (prompt.length > MAX_PROMPT_CHARS) {
		prompt = prompt.slice(0, MAX_PROMPT_CHARS) + `\n[prompt truncated at ${MAX_PROMPT_CHARS} chars]`;
	}

	const models = buildModelAttempts(step.model, step.fallback_models);
	const failures: AgentAttemptFailure[] = [];
	for (const model of models) {
		const result = await runAgentAttempt({ step, prompt, model, signal, defaultCwd });
		if (result.status === "success" || result.status === "aborted") return result;
		failures.push({
			model,
			error: result.error ?? "unknown failure",
			stderr: result.stderrExcerpt,
		});
	}

	const last = failures.at(-1);
	return {
		status: "failed",
		stdoutExcerpt: "",
		stderrExcerpt: last?.stderr ?? "",
		error: formatAttemptFailures(failures),
		durationMs: 0,
	};
}

interface AgentAttemptFailure {
	model: string | undefined;
	error: string;
	stderr: string;
}

interface AgentAttemptInput {
	step: Extract<RoutineStep, { type: "agent" }>;
	prompt: string;
	model: string | undefined;
	signal: AbortSignal;
	defaultCwd: string;
}

function buildModelAttempts(model: string | undefined, fallbackModels: string[] | undefined): Array<string | undefined> {
	const attempts: Array<string | undefined> = [model];
	for (const fallback of fallbackModels ?? []) {
		if (!attempts.includes(fallback)) attempts.push(fallback);
	}
	return attempts;
}

async function runAgentAttempt(input: AgentAttemptInput): Promise<StepResult> {
	const startedMs = Date.now();
	const args = ["-p", input.prompt];
	if (input.model) {
		args.push("-m", input.model);
	}

	try {
		const proc = Bun.spawn([...buildOmpCommand(resolveOmpBin()), ...args], {
			cwd: input.defaultCwd,
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
			windowsHide: true,
		});
		const onAbort = () => {
			try {
				proc.kill();
			} catch {
				/* already gone */
			}
		};
		input.signal.addEventListener("abort", onAbort);
		try {
			const [stdout, stderr, exitCode] = await Promise.all([
				readClipped(proc.stdout),
				readClipped(proc.stderr),
				proc.exited,
			]);
			const durationMs = Date.now() - startedMs;
			if (input.signal.aborted) {
				return {
					status: "aborted",
					stdoutExcerpt: stdout,
					stderrExcerpt: stderr,
					error: "aborted",
					durationMs,
					model: input.model,
				};
			}
			if (exitCode !== 0) {
				return {
					status: "failed",
					stdoutExcerpt: stdout,
					stderrExcerpt: stderr,
					error: `omp exit code ${exitCode}`,
					durationMs,
					model: input.model,
				};
			}

			// Estimate tokens for budget tracking. Conservative — model token
			// counts are not exposed by `omp -p` stdout; the V1 estimate is
			// good enough for max_llm_cost_usd to fire on runaway calls.
			const tokensIn = Math.ceil(input.prompt.length / CHARS_PER_TOKEN);
			const tokensOut = Math.ceil(stdout.length / CHARS_PER_TOKEN);
			const cost = costMicros(input.model, tokensIn, tokensOut);

			let json: unknown;
			let parseError: string | undefined;
			if (input.step.structured_output) {
				try {
					json = JSON.parse(stdout.trim());
				} catch (err) {
					parseError = `structured_output parse failure: ${String(err)}`;
				}
				if (input.step.structured_output.strict !== false && parseError) {
					return {
						status: "failed",
						stdoutExcerpt: stdout,
						stderrExcerpt: stderr,
						error: parseError,
						durationMs,
						model: input.model,
						llmTokensIn: tokensIn,
						llmTokensOut: tokensOut,
						llmCostMicros: cost,
					};
				}
			}

			return {
				status: "success",
				stdoutExcerpt: stdout,
				stderrExcerpt: stderr,
				json,
				durationMs,
				model: input.model,
				llmTokensIn: tokensIn,
				llmTokensOut: tokensOut,
				llmCostMicros: cost,
			};
		} finally {
			input.signal.removeEventListener("abort", onAbort);
		}
	} catch (err) {
		return {
			status: "failed",
			stdoutExcerpt: "",
			stderrExcerpt: "",
			error: String(err),
			durationMs: Date.now() - startedMs,
			model: input.model,
		};
	}
}

function formatAttemptFailures(failures: AgentAttemptFailure[]): string {
	if (failures.length === 0) return "agent step failed before any model attempt";
	return failures
		.map((failure) => {
			const model = failure.model ?? "<default>";
			const stderr = failure.stderr ? `; stderr: ${failure.stderr}` : "";
			return `${model}: ${failure.error}${stderr}`;
		})
		.join(" | ");
}

async function readClipped(stream: ReadableStream<Uint8Array> | null): Promise<string> {
	if (!stream) return "";
	const reader = stream.getReader();
	const decoder = new TextDecoder("utf-8");
	let acc = "";
	while (true) {
		const { value, done } = await reader.read();
		if (done) break;
		acc += decoder.decode(value, { stream: true });
		if (acc.length > MAX_EXCERPT) {
			acc = acc.slice(0, MAX_EXCERPT) + "\n…(truncated)";
			try {
				await reader.cancel();
			} catch {
				/* ignore */
			}
			break;
		}
	}
	acc += decoder.decode();
	return acc;
}
