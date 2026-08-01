import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function runThresholdProbe(input: { managed: string; shell?: string }) {
	const dataDir = mkdtempSync(join(tmpdir(), "omp-deck-env-bootstrap-"));
	tempDirs.push(dataDir);
	writeFileSync(join(dataDir, ".env"), `OMP_DECK_TOPOLOGY_COMPACT_THRESHOLD_PERCENT=${input.managed}\n`, { mode: 0o600 });
	const script = [
		'import "./bootstrap-env.ts";',
		'import { CONTEXT_REPLACEMENT_THRESHOLD_PERCENT, shouldReplaceContext } from "./session-context.ts";',
		'console.log(JSON.stringify({ threshold: CONTEXT_REPLACEMENT_THRESHOLD_PERCENT, below: shouldReplaceContext(CONTEXT_REPLACEMENT_THRESHOLD_PERCENT - 0.1), at: shouldReplaceContext(CONTEXT_REPLACEMENT_THRESHOLD_PERCENT) }));',
	].join("\n");
	const env: Record<string, string | undefined> = { ...process.env, OMP_DECK_DATA_DIR: dataDir };
	if (input.shell === undefined) delete env.OMP_DECK_TOPOLOGY_COMPACT_THRESHOLD_PERCENT;
	else env.OMP_DECK_TOPOLOGY_COMPACT_THRESHOLD_PERCENT = input.shell;
	return Bun.spawnSync({
		cmd: [process.execPath, "-e", script],
		cwd: import.meta.dir,
		env,
		stdout: "pipe",
		stderr: "pipe",
	});
}

describe("server managed-env bootstrap", () => {
	test("loads managed topology threshold before session-context initializes", () => {
		const result = runThresholdProbe({ managed: "1" });
		expect(result.exitCode).toBe(0);
		expect(JSON.parse(result.stdout.toString())).toEqual({ threshold: 1, below: false, at: true });
	});

	test("preserves launching-shell precedence over managed env", () => {
		const result = runThresholdProbe({ managed: "1", shell: "3" });
		expect(result.exitCode).toBe(0);
		expect(JSON.parse(result.stdout.toString())).toEqual({ threshold: 3, below: false, at: true });
	});
});
