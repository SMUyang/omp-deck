/**
 * Zip-based auto-update for non-git installations.
 *
 * When omp-deck is downloaded as a GitHub zip/tarball (not git clone),
 * this module handles:
 *   1. Fetch latest commit SHA from GitHub API
 *   2. Compare with local stamp
 *   3. Download tarball
 *   4. Extract and replace source files (preserving user data)
 *   5. Run bun install + web build
 *
 * User data preserved during update:
 *   data/, .env*, .logs/, .pi/, bun.lock, ~/.omp/agent/extensions/
 */

import { existsSync, mkdirSync, rmSync, cpSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import * as path from "node:path";
import { resolveBunExecutable } from "./runtime-bun.ts";
import { logger } from "./log.ts";

const log = logger("zip-update");

const GITHUB_API = "https://api.github.com/repos/SMUyang/omp-deck/commits/main";
const TARBALL_URL = "https://github.com/SMUyang/omp-deck/tarball/main";
const STAMP_FILE = ".deck-update-sha";
const FETCH_TIMEOUT_MS = 15_000;

/** Files/dirs preserved during zip update. */
const PRESERVE = new Set([
	"data", ".env", ".env.local", ".logs", ".pi", "bun.lock",
	"node_modules", "task_plan.md", "progress.md", "findings.md",
]);

export interface ZipUpdateResult {
	ok: boolean;
	oldSha?: string;
	newSha?: string;
	error?: string;
}

/** Fetch the latest commit SHA from GitHub API. */
export async function fetchLatestSha(): Promise<string | null> {
	try {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
		const resp = await fetch(GITHUB_API, {
			headers: { "Accept": "application/vnd.github.v3+json", "User-Agent": "omp-deck" },
			signal: controller.signal,
		});
		clearTimeout(timer);
		if (!resp.ok) return null;
		const data = await resp.json() as Record<string, unknown>;
		const sha = (data as { sha?: string }).sha;
		return sha ?? null;
	} catch {
		return null;
	}
}

/** Read the local stamp file (last updated SHA). */
function readStamp(repoRoot: string): string | null {
	try {
		return readFileSync(path.join(repoRoot, STAMP_FILE), "utf-8").trim();
	} catch {
		return null;
	}
}

/** Write the stamp file after a successful update. */
function writeStamp(repoRoot: string, sha: string): void {
	writeFileSync(path.join(repoRoot, STAMP_FILE), sha);
}

/** Check if a zip update is available (SHA differs from stamp). */
export async function checkZipUpdate(repoRoot: string): Promise<{ available: boolean; latestSha: string | null; currentSha: string | null }> {
	const currentSha = readStamp(repoRoot);
	const latestSha = await fetchLatestSha();
	if (!latestSha) return { available: false, latestSha: null, currentSha };
	return { available: currentSha !== latestSha, latestSha, currentSha };
}

/**
 * Execute the zip update: download tarball, extract, replace files.
 * Preserves user data (data/, .env, .logs/, etc.).
 */
export async function runZipUpdate(repoRoot: string): Promise<ZipUpdateResult> {
	const latestSha = await fetchLatestSha();
	if (!latestSha) {
		return { ok: false, error: "Failed to fetch latest version from GitHub" };
	}

	const currentSha = readStamp(repoRoot);
	if (currentSha === latestSha) {
		log.info("already up to date");
		return { ok: true, oldSha: currentSha ?? undefined, newSha: latestSha };
	}

	log.info(`updating: ${currentSha ?? "unknown"} → ${latestSha.slice(0, 7)}`);

	// Download tarball
	const tmpDir = path.join(repoRoot, ".tmp-update");
	const tarballPath = path.join(tmpDir, "omp-deck.tar.gz");
	try {
		mkdirSync(tmpDir, { recursive: true });

		log.info("downloading tarball...");
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), 60_000);
		const resp = await fetch(TARBALL_URL, { signal: controller.signal });
		clearTimeout(timer);
		if (!resp.ok) {
			return { ok: false, error: `Download failed: HTTP ${resp.status}` };
		}
		const buffer = await resp.arrayBuffer();
		writeFileSync(tarballPath, Buffer.from(buffer));

		// Extract
		log.info("extracting...");
		const extractDir = path.join(tmpDir, "extracted");
		mkdirSync(extractDir, { recursive: true });

		const tarCmd = process.platform === "win32"
			? ["tar", "xzf", tarballPath, "-C", extractDir]
			: ["tar", "xzf", tarballPath, "-C", extractDir];
		const proc = Bun.spawnSync({ cmd: tarCmd, cwd: tmpDir, stdout: "pipe", stderr: "pipe" });
		if (proc.exitCode !== 0) {
			return { ok: false, error: `Extract failed: ${proc.stderr.toString()}` };
		}

		// Find extracted directory (GitHub names it `SMUyang-omp-deck-{sha}/`)
		const entries = readdirSync(extractDir);
		const extractedDir = entries.find((e) => e.startsWith("SMUyang-omp-deck-") || e.startsWith("omp-deck-"));
		if (!extractedDir) {
			return { ok: false, error: "Could not find extracted directory" };
		}
		const sourceDir = path.join(extractDir, extractedDir);

		// Replace files: delete old source files (preserve user data), copy new ones
		log.info("replacing source files (preserving user data)...");

		// Delete old files that are NOT in PRESERVE set
		for (const entry of readdirSync(repoRoot)) {
			if (PRESERVE.has(entry) || entry.startsWith(".tmp")) continue;
			const fullPath = path.join(repoRoot, entry);
			try {
				rmSync(fullPath, { recursive: true, force: true });
			} catch { /* best-effort */ }
		}

		// Copy new files from extracted directory
		for (const entry of readdirSync(sourceDir)) {
			const src = path.join(sourceDir, entry);
			const dst = path.join(repoRoot, entry);
			if (PRESERVE.has(entry)) continue; // don't overwrite user data
			try {
				cpSync(src, dst, { recursive: true });
			} catch { /* best-effort */ }
		}

		// Run bun install
		log.info("installing dependencies...");
		const bunBin = resolveBunExecutable();
		const installProc = Bun.spawnSync({
			cmd: [bunBin, "install"],
			cwd: repoRoot,
			stdout: "pipe", stderr: "pipe",
		});
		if (installProc.exitCode !== 0) {
			log.warn(`bun install warnings: ${installProc.stderr.toString().slice(0, 200)}`);
		}

		// Build web
		log.info("building web UI...");
		const buildProc = Bun.spawnSync({
			cmd: [bunBin, "run", "--filter", "@omp-deck/web", "build"],
			cwd: repoRoot,
			stdout: "pipe", stderr: "pipe",
		});
		if (buildProc.exitCode !== 0) {
			log.warn(`web build warnings: ${buildProc.stderr.toString().slice(0, 200)}`);
		}

		// Write stamp
		writeStamp(repoRoot, latestSha);

		// Cleanup
		rmSync(tmpDir, { recursive: true, force: true });

		log.info("zip update completed successfully");
		return { ok: true, oldSha: currentSha ?? undefined, newSha: latestSha };

	} catch (err) {
		// Cleanup on failure
		rmSync(tmpDir, { recursive: true, force: true });
		const msg = err instanceof Error ? err.message : String(err);
		log.error(`zip update failed: ${msg}`);
		return { ok: false, error: msg };
	}
}
