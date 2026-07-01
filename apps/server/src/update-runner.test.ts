import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { detectInstallType, type UpdateStepResult, runUpdateSteps } from "./update-runner.ts";

let tmpDir: string | undefined;

afterEach(() => {
	if (tmpDir) {
		rmSync(tmpDir, { recursive: true, force: true });
		tmpDir = undefined;
	}
});

describe("detectInstallType", () => {
	test("returns 'git' when .git directory exists in source root", () => {
		tmpDir = mkdtempSync(path.join(tmpdir(), "omp-deck-update-git-"));
		// Simulate a git repo: create .git dir
		mkdirRecursive(path.join(tmpDir, ".git"));
		const result = detectInstallType(tmpDir);
		expect(result).toBe("git");
	});

	test("returns 'npm-global' when no .git and source is under node_modules", () => {
		tmpDir = mkdtempSync(path.join(tmpdir(), "omp-deck-update-npm-"));
		const nmPath = path.join(tmpDir, "node_modules", "omp-deck");
		mkdirRecursive(nmPath);
		const result = detectInstallType(nmPath);
		expect(result).toBe("npm-global");
	});

	test("returns 'unknown' for other paths", () => {
		tmpDir = mkdtempSync(path.join(tmpdir(), "omp-deck-update-unknown-"));
		const result = detectInstallType(tmpDir);
		expect(result).toBe("unknown");
	});
});

describe("runUpdateSteps", () => {
	test("rejects unknown install type", async () => {
		tmpDir = mkdtempSync(path.join(tmpdir(), "omp-deck-update-unknown-"));
		const result = await runUpdateSteps(tmpDir, { spawner: async () => ({ command: [], exitCode: 0, stdout: "", stderr: "" }) });
		expect(result.ok).toBe(false);
		expect(result.error).toContain("unsupported");
	});

	test("runs git pull + bun install for git installs", async () => {
		tmpDir = mkdtempSync(path.join(tmpdir(), "omp-deck-update-git-"));
		mkdirRecursive(path.join(tmpDir, ".git"));
		const commands: string[][] = [];
		const result = await runUpdateSteps(tmpDir, {
			spawner: async (cmd) => {
				commands.push([...cmd]);
			return { command: cmd, exitCode: 0, stdout: "ok", stderr: "" };
			},
		});
		expect(result.ok).toBe(true);
		expect(commands[0]?.[0]).toBe("git");
		expect(commands[0]?.[1]).toBe("pull");
		expect(commands.some((c) => c[0]?.includes("bun") && c.includes("install"))).toBe(true);
		expect(commands.some((c) => c[0]?.includes("bun") && c.includes("build"))).toBe(true);
	});
});

// Helper
function mkdirRecursive(p: string): void {
	mkdirSync(p, { recursive: true });
}
