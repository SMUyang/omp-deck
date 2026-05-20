/**
 * Filesystem watcher rooted at the marketplace plugin cache directory. Fires
 * a debounced `skills_changed` broadcast whenever a SKILL.md, plugin.json, or
 * plugin tree mutates so the UI can refetch without polling.
 *
 * Gated by `OMP_DECK_WATCH_SKILLS` (default on). Set `=0` to disable when
 * running on filesystems that misbehave under recursive watch (some VPNs,
 * network drives, OneDrive shadowing). On first watcher error we log + stop
 * — the cockpit still works, the UI just has to refetch manually.
 *
 * Phase 1 of the Skills Cockpit (docs/proposals/skills-cockpit.md). Polling
 * fallback is deferred until we see an actual environment that needs it.
 */

import { watch, type FSWatcher } from "node:fs";

import { getPluginsCacheDir } from "@oh-my-pi/pi-coding-agent/extensibility/plugins/marketplace";

import { broadcastBus } from "./broadcast-bus.ts";
import { logger } from "./log.ts";

const log = logger("skills:watcher");

// Many filesystem events fire during a single install/uninstall (file copies,
// rename-to-rename, etc). Debouncing keeps the WS fan-out cheap; 250ms is
// short enough that the UI feels live and long enough to coalesce a burst.
const DEBOUNCE_MS = 250;

export function startSkillsWatcher(): () => void {
	if (process.env.OMP_DECK_WATCH_SKILLS === "0") {
		log.info("skills watcher disabled via OMP_DECK_WATCH_SKILLS=0");
		return () => {};
	}

	const root = getPluginsCacheDir();
	let watcher: FSWatcher | undefined;
	let pending: ReturnType<typeof setTimeout> | undefined;
	let disposed = false;

	const fire = (): void => {
		if (disposed) return;
		broadcastBus.broadcast({ type: "skills_changed" });
	};

	const schedule = (): void => {
		if (pending) clearTimeout(pending);
		pending = setTimeout(fire, DEBOUNCE_MS);
	};

	try {
		watcher = watch(root, { recursive: true, persistent: false }, (_eventType, filename) => {
			// We don't filter by `filename` here — both SKILL.md mutations and
			// plugin.json / install_path mutations should refetch the catalog.
			// Filtering would also mishandle directory-level renames.
			if (filename === null || filename === undefined) {
				// Some platforms emit null filenames on bulk events; still fire.
				schedule();
				return;
			}
			schedule();
		});

		watcher.on("error", (err) => {
			log.warn(`watcher error, stopping (cockpit will rely on manual refresh)`, err);
			disposeWatcher();
		});

		log.info(`watching ${root} for skills_changed broadcasts`);
	} catch (err) {
		log.warn(`failed to start watcher at ${root} (cockpit will rely on manual refresh)`, err);
		watcher = undefined;
	}

	function disposeWatcher(): void {
		disposed = true;
		if (pending) {
			clearTimeout(pending);
			pending = undefined;
		}
		if (watcher) {
			try {
				watcher.close();
			} catch {
				// best-effort
			}
			watcher = undefined;
		}
	}

	return disposeWatcher;
}
