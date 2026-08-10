/**
 * Resolve the path to the Bun executable for spawning child processes.
 *
 * Issue #6: `process.execPath` is the canonical answer (the binary that
 * launched the currently-running interpreter) and it works for ~99% of
 * users — but it captures the install location AT PROCESS START, not "the
 * bun that lives on PATH now." If the user installed Bun via the official
 * installer (`~/.bun/bin/bun`), the deck server started, then they later:
 *
 *   - Reinstalled Bun via Homebrew (now at `/opt/homebrew/bin/bun`)
 *   - Uninstalled the old install, leaving `~/.bun/bin/` empty
 *   - Switched Bun versions via mise / asdf / proto
 *
 * `process.execPath` still points at the dead path. Subsequent
 * `Bun.spawn({ cmd: [process.execPath, ...] })` calls (telegram bridge
 * supervisor, deck restart) blow up with `ENOENT: no such file or
 * directory, posix_spawn '/Users/.../bin/bun'`.
 *
 * Reported by Axel on macOS via the issue tracker (issue #6).
 *
 * Strategy:
 *   1. Try `process.execPath` first — fast path, correct for the common case.
 *   2. Fall back to `Bun.which("bun")` — searches PATH the way the user's
 *      shell would, finds wherever Bun lives now.
 *   3. Throw a clear error with both attempts logged if neither works.
 *
 * The result is memoized for the process lifetime: a working Bun binary
 * isn't going to move during a single deck-server run, and re-checking on
 * every spawn would be wasted IO.
 */
import { existsSync, readFileSync } from "node:fs";

let cached: string | undefined;

export function resolveBunExecutable(): string {
	if (cached) return cached;

	const attempts: Array<{ source: string; value: string | null | undefined }> = [
		{ source: "process.execPath", value: process.execPath },
		{ source: "Bun.which(\"bun\")", value: Bun.which("bun") },
	];

	for (const { value } of attempts) {
		if (value && existsSync(value)) {
			cached = value;
			return cached;
		}
	}

	const detail = attempts
		.map(({ source, value }) => `${source}=${value ?? "<null>"}`)
		.join("; ");
	throw new Error(
		`could not resolve bun executable for child-process spawn — neither candidate exists on disk (${detail}). ` +
			`Reinstall Bun (https://bun.sh) and ensure 'bun' is on PATH.`,
	);
}

/** Test-only: reset the memoized result. */
export function resetResolvedBunExecutable(): void {
	cached = undefined;
}

/**
 * Build a command for a Bun-backed CLI without relying on its shebang PATH.
 * Launchd/systemd environments commonly omit the Bun directory from PATH.
 */
export function buildOmpCommand(ompBin: string): string[] {
	if (!isBunScript(ompBin)) return [ompBin];
	return [resolveBunExecutable(), ompBin];
}

function isBunScript(command: string): boolean {
	try {
		const firstLine = readFileSync(command, "utf8").slice(0, 256).split(/\r?\n/, 1)[0] ?? "";
		return /^#!.*\bbun\b/.test(firstLine) || command.endsWith("/cli.js");
	} catch {
		return command.endsWith("/cli.js");
	}
}
