/**
 * Git-based auto-update checker for fork deployments.
 *
 * Periodically fetches origin/main and compares HEAD. When new commits
 * are detected:
 *   - If OMP_DECK_AUTO_UPDATE=true: pulls, rebuilds, and restarts.
 *   - Otherwise: status is exposed via GET /api/git-update for polling.
 *
 * This complements the npm-registry update-check (which tracks the
 * upstream npm package). For git/fork installs, this is the relevant
 * signal.
 */

import { resolveRepoRoot, runUpdateSteps } from "./update-runner.ts";
import { logger } from "./log.ts";

const log = logger("git-update");

const DEFAULT_INTERVAL_MS = 30 * 60 * 1000; // 30 min


export interface GitUpdateStatus {
	checking: boolean;
	updateAvailable: boolean;
	localSha: string | null;
	remoteSha: string | null;
	lastCheckedAt: number | null;
	lastError: string | null;
}

let status: GitUpdateStatus = {
	checking: false,
	updateAvailable: false,
	localSha: null,
	remoteSha: null,
	lastCheckedAt: null,
	lastError: null,
};

let timer: ReturnType<typeof setInterval> | null = null;

async function runGit(args: string[], cwd: string): Promise<string> {
	const proc = Bun.spawn({
		cmd: ["git", ...args],
		cwd,
		stdout: "pipe",
		stderr: "pipe",
	});
	const exitCode = await proc.exited;
	const stdout = await new Response(proc.stdout).text();
	if (exitCode !== 0) {
		const stderr = await new Response(proc.stderr).text();
		throw new Error(stderr.trim() || `git ${args[0]} exited ${exitCode}`);
	}
	return stdout.trim();
}

async function checkOnce(
	repoRoot: string,
	onUpdate?: () => void,
) {
	if (status.checking) return; // prevent concurrent checks
	try {
		// Fetch quietly — don't merge, just update remote refs
		await runGit(["fetch", "origin", "main", "--quiet"], repoRoot);
		const localSha = await runGit(["rev-parse", "HEAD"], repoRoot);
		const remoteSha = await runGit(["rev-parse", "origin/main"], repoRoot);

		status.localSha = localSha;
		status.remoteSha = remoteSha;
		status.lastCheckedAt = Date.now();
		status.lastError = null;

		if (localSha !== remoteSha) {
			status.updateAvailable = true;
			log.info(`update available: ${localSha.slice(0, 8)} → ${remoteSha.slice(0, 8)}`);
			if (process.env.OMP_DECK_AUTO_UPDATE === "true" && onUpdate) {
				// Guard: don't auto-pull if the working tree has uncommitted changes
				try {
					const dirty = await runGit(["status", "--porcelain"], repoRoot);
					if (dirty) {
						log.warn("auto-update skipped — working tree has uncommitted changes");
						status.lastError = "working tree dirty — commit or stash before auto-update";
						return;
					}
				} catch { /* best-effort — let runUpdateSteps handle it */ }

				log.info("auto-update enabled — pulling and rebuilding");
				const result = await runUpdateSteps(repoRoot);
				if (result.ok) {
					log.info("auto-update succeeded — restarting");
					status.updateAvailable = false;
					onUpdate();
				} else {
					log.warn(`auto-update failed: ${result.error}`);
					status.lastError = result.error ?? "update steps failed";
				}
			}
		} else {
			status.updateAvailable = false;
		}
	} catch (err) {
		status.lastError = err instanceof Error ? err.message : String(err);
		log.warn(`git update check failed: ${status.lastError}`);
	} finally {
		status.checking = false;
	}
}

export function startGitUpdateChecker(onUpdate?: () => void): void {
	const intervalMs = parseInt10(process.env.OMP_DECK_UPDATE_INTERVAL_MS, DEFAULT_INTERVAL_MS);
	if (process.env.OMP_DECK_DISABLE_UPDATE_CHECK === "1") return;

	const repoRoot = resolveRepoRoot();
	log.info(`git update checker started (interval ${Math.round(intervalMs / 1000)}s)`);

	// Initial check after 10s (let server finish booting)
	setTimeout(() => void checkOnce(repoRoot, onUpdate), 10_000);

	// Periodic check
	timer = setInterval(() => void checkOnce(repoRoot, onUpdate), intervalMs);
}

export function stopGitUpdateChecker(): void {
	if (timer) {
		clearInterval(timer);
		timer = null;
	}
}

export function getGitUpdateStatus(): GitUpdateStatus {
	return { ...status };
}

function parseInt10(raw: string | undefined, fallback: number): number {
	if (!raw) return fallback;
	const n = Number(raw);
	return Number.isFinite(n) && n > 0 ? n : fallback;
}
