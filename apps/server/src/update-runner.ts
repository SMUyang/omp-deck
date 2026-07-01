/**
 * Auto-update runner — detects installation type and executes the
 * appropriate update sequence (git pull or npm/bun global upgrade).
 *
 * After a successful update, the caller should trigger a server restart
 * so the new code takes effect.
 */
import { existsSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { resolveBunExecutable } from "./runtime-bun.ts";
import { logger } from "./log.ts";

const log = logger("update-runner");

export type InstallType = "git" | "npm-global" | "unknown";

export interface UpdateStepResult {
	command: string[];
	exitCode: number;
	stdout: string;
	stderr: string;
}

export interface UpdateRunResult {
	ok: boolean;
	installType: InstallType;
	steps: UpdateStepResult[];
	error?: string;
}

interface UpdateOptions {
	spawner?: (cmd: string[], cwd: string) => Promise<UpdateStepResult>;
}

/**
 * Detect how omp-deck was installed by examining the source tree.
 * - `.git` directory present → git clone (supports `git pull`)
 * - path contains `node_modules/omp-deck` → npm/bun global install
 * - neither → unknown (manual/custom deployment)
 */
export function detectInstallType(sourceRoot: string): InstallType {
	if (existsSync(path.join(sourceRoot, ".git"))) return "git";
	if (sourceRoot.includes(path.join("node_modules", "omp-deck"))) return "npm-global";
	return "unknown";
}

/**
 * Resolve the repository root from the running module path.
 * `apps/server/src/update-runner.ts` → repo root is 3 levels up.
 */
export function resolveRepoRoot(): string {
	const here = path.dirname(fileURLToPath(import.meta.url));
	return path.resolve(here, "..", "..", "..");
}

function defaultSpawner(cmd: string[], cwd: string): Promise<UpdateStepResult> {
	return new Promise((resolve) => {
		const proc = Bun.spawnSync({ cmd, cwd, stdout: "pipe", stderr: "pipe" });
		resolve({
			command: cmd,
			exitCode: proc.exitCode,
			stdout: proc.stdout.toString(),
			stderr: proc.stderr.toString(),
		});
	});
}

/**
 * Run the full update sequence. Each step is logged; the first failure
 * aborts remaining steps.
 */
export async function runUpdateSteps(
	sourceRoot: string,
	opts: UpdateOptions = {},
): Promise<UpdateRunResult> {
	const installType = detectInstallType(sourceRoot);
	const spawner = opts.spawner ?? defaultSpawner;
	const bunBin = resolveBunExecutable();
	const steps: UpdateStepResult[] = [];

	if (installType === "unknown") {
		return { ok: false, installType, steps, error: "unsupported install type — update manually" };
	}

	const stepList: Array<{ cmd: string[]; label: string }> =
		installType === "git"
			? [
					{ cmd: ["git", "pull"], label: "git pull" },
					{ cmd: [bunBin, "install"], label: "bun install" },
					{ cmd: [bunBin, "run", "--filter", "@omp-deck/web", "build"], label: "web build" },
				]
			: [
					{ cmd: [bunBin, "install", "-g", "omp-deck@latest"], label: "global upgrade" },
				];

	for (const step of stepList) {
		log.info(`running: ${step.label}`);
		const result = await spawner(step.cmd, sourceRoot);
		steps.push(result);
		if (result.exitCode !== 0) {
			const error = `${step.label} failed (exit ${result.exitCode}): ${result.stderr || result.stdout}`;
			log.warn(error);
			return { ok: false, installType, steps, error };
		}
	}

	log.info("update steps completed successfully");
	return { ok: true, installType, steps };
}
