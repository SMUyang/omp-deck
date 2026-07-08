/**
 * Shared auto-rebuild state machine for session topology.
 *
 * Used by both the RPC bridge (`rpc.ts`) and the in-process bridge
 * (`in-process.ts`). Each bridge constructs an instance with concrete
 * implementations of the file-stat / checkpoint / rebuild functions, then
 * calls `maybeTrigger()` on `turn_end` / `agent_end`.
 *
 * Guarantees:
 * - Single-flight: the lock is claimed synchronously before any await, so
 *   concurrent triggers never start overlapping rebuilds.
 * - Catch-up: if a trigger arrives while a rebuild is in-flight, a pending
 *   flag is set and the rebuild re-runs once after completion (the staleness
 *   check inside the re-run skips if nothing actually changed).
 * - Staleness skip: if the checkpoint's mtime/size match the current file
 *   stat, the rebuild is skipped entirely.
 */

import { rebuildSessionContextFromFile } from "../session-context.ts";
import { getSessionContextStatus } from "../db/session-context.ts";
import { logger } from "../log.ts";

const log = logger("auto-rebuild");

export interface AutoRebuildCheckpoint {
	built: boolean;
	sourceMtimeMs?: number;
	sourceSizeBytes?: number;
}

export interface AutoRebuildDeps {
	readonly sessionId: string;
	getSessionFile: () => string | undefined;
	statFile: (path: string) => Promise<{ mtimeMs: number; size: number }>;
	getCheckpoint: (sessionId: string) => AutoRebuildCheckpoint;
	rebuild: (sessionId: string, sessionFile: string) => Promise<void>;
	sleep: (ms: number) => Promise<void>;
}

export class AutoRebuildTopology {
	#inFlight = false;
	#pending = false;
	readonly #deps: AutoRebuildDeps;

	constructor(deps: AutoRebuildDeps) {
		this.#deps = deps;
	}

	trigger(): Promise<void> {
		return this.#run();
	}

	maybeTrigger(): void {
		void this.#run();
	}

	async #run(): Promise<void> {
		if (this.#inFlight) {
			this.#pending = true;
			return;
		}
		this.#inFlight = true;
		try {
			do {
				this.#pending = false;
				const sessionFile = this.#deps.getSessionFile();
				if (!sessionFile) break; // terminal — no file to rebuild

				let stale = true;
				try {
					const stat = await this.#deps.statFile(sessionFile);
					const checkpoint = this.#deps.getCheckpoint(this.#deps.sessionId);
					if (
						checkpoint.built &&
						checkpoint.sourceMtimeMs === Math.trunc(stat.mtimeMs) &&
						checkpoint.sourceSizeBytes === stat.size
					) {
						stale = false;
					}
				} catch {
					stale = false; // file not ready — skip rebuild but still check pending
				}

				if (stale) {
					await this.#deps.sleep(500);
					await this.#deps.rebuild(this.#deps.sessionId, sessionFile);
				}
			} while (this.#pending);
		} catch (err) {
			log.debug(`auto-rebuild skipped for ${this.#deps.sessionId}: ${err}`);
		} finally {
			this.#inFlight = false;
		}
	}
}


/**
 * Factory: constructs an `AutoRebuildTopology` wired to real file/DB/rebuild
 * implementations. Bridges call this with just `sessionId` + `getSessionFile`.
 * Tests construct `AutoRebuildTopology` directly with stub deps.
 */
export function createAutoRebuildTopology(deps: {
	sessionId: string;
	getSessionFile: () => string | undefined;
}): AutoRebuildTopology {
	return new AutoRebuildTopology({
		...deps,
		statFile: (p) => Bun.file(p).stat(),
		getCheckpoint: (id) => getSessionContextStatus(id),
		rebuild: (id, f) => rebuildSessionContextFromFile({ sessionId: id, sessionFile: f }).then(() => {}),
		sleep: (ms) => Bun.sleep(ms),
	});
}
