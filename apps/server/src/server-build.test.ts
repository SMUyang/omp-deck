import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, test } from "bun:test";

const here = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(here, "..");

let outDir: string | undefined;

afterEach(() => {
	if (outDir) {
		rmSync(outDir, { recursive: true, force: true });
		outDir = undefined;
	}
});

function runBuildToTempOutDir() {
	outDir = mkdtempSync(path.join(tmpdir(), "omp-deck-server-build-"));
	return Bun.spawnSync({
		cmd: [process.execPath, "run", "build"],
		cwd: serverRoot,
		env: { ...process.env, OMP_DECK_SERVER_BUILD_OUTDIR: outDir },
		stdout: "pipe",
		stderr: "pipe",
	});
}

describe("server production build", () => {
	test("bundles without pulling top-level-await document converters into the server bundle", () => {
		const proc = runBuildToTempOutDir();
		const stdout = proc.stdout.toString();
		const stderr = proc.stderr.toString();
		expect(proc.exitCode, `${stdout}\n${stderr}`).toBe(0);
	});

	test("copies runtime database migrations beside the bundled server", () => {
		const proc = runBuildToTempOutDir();
		const stdout = proc.stdout.toString();
		const stderr = proc.stderr.toString();
		expect(proc.exitCode, `${stdout}\n${stderr}`).toBe(0);
		expect(existsSync(path.join(outDir!, "migrations", "001-init.sql"))).toBe(true);
	});
});
