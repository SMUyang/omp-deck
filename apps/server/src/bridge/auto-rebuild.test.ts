import { describe, expect, test } from "bun:test";

import { AutoRebuildTopology, type AutoRebuildDeps } from "./auto-rebuild.ts";

/** Build stub deps with controllable behaviour for deterministic async tests. */
function makeDeps(overrides: Partial<AutoRebuildDeps> = {}): AutoRebuildDeps {
	return {
		sessionId: "test-session",
		getSessionFile: () => "/fake/session.jsonl",
		statFile: () => Promise.resolve({ mtimeMs: 1000, size: 500 }),
		getCheckpoint: () => ({ built: false }),
		rebuild: () => Promise.resolve(),
		sleep: () => Promise.resolve(),
		...overrides,
	};
}

/** Tiny deferred for deterministic async test control. */
function defer<T>() {
	let resolve!: (v: T) => void;
	let reject!: (e: Error) => void;
	const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
	return { promise, resolve, reject };
}

describe("AutoRebuildTopology", () => {
	test("rebuilds when checkpoint is stale", async () => {
		let rebuilt = 0;
		const arb = new AutoRebuildTopology(makeDeps({
			rebuild: () => { rebuilt++; return Promise.resolve(); },
		}));
		await arb.trigger();
		expect(rebuilt).toBe(1);
	});

	test("skips rebuild when checkpoint matches file stat", async () => {
		let rebuilt = 0;
		const arb = new AutoRebuildTopology(makeDeps({
			getCheckpoint: () => ({ built: true, sourceMtimeMs: 1000, sourceSizeBytes: 500 }),
			rebuild: () => { rebuilt++; return Promise.resolve(); },
		}));
		await arb.trigger();
		expect(rebuilt).toBe(0);
	});

	test("skips when sessionFile is undefined", async () => {
		let rebuilt = 0;
		const arb = new AutoRebuildTopology(makeDeps({
			getSessionFile: () => undefined,
			rebuild: () => { rebuilt++; return Promise.resolve(); },
		}));
		await arb.trigger();
		expect(rebuilt).toBe(0);
	});

	test("skips when stat throws (file not ready)", async () => {
		let rebuilt = 0;
		const arb = new AutoRebuildTopology(makeDeps({
			statFile: () => Promise.reject(new Error("ENOENT")),
			rebuild: () => { rebuilt++; return Promise.resolve(); },
		}));
		await arb.trigger();
		expect(rebuilt).toBe(0);
	});

	test("single-flight: reentrant trigger during rebuild causes exactly one catch-up", async () => {
		let rebuilt = 0;
		const firstRebuild = defer<void>();
		const rebuildEntered = defer<void>();

		const arb = new AutoRebuildTopology(makeDeps({
			rebuild: () => {
				rebuilt++;
				if (rebuilt === 1) {
					rebuildEntered.resolve();
					return firstRebuild.promise;
				}
				return Promise.resolve();
			},
		}));

		const firstPromise = arb.trigger();
		await rebuildEntered.promise; // first run has entered rebuild()
		arb.trigger();                  // reentrant — should set pending, not start a second rebuild
		expect(rebuilt).toBe(1);
		firstRebuild.resolve();         // release first rebuild — catch-up fires
		await firstPromise;
		expect(rebuilt).toBe(2);
	});

	test("honors pending trigger after stat failure", async () => {
		let rebuilt = 0;
		let statCall = 0;
		const firstStat = defer<{ mtimeMs: number; size: number }>();

		const arb = new AutoRebuildTopology(makeDeps({
			statFile: () => {
				statCall++;
				return statCall === 1 ? firstStat.promise : Promise.resolve({ mtimeMs: 2000, size: 600 });
			},
			rebuild: () => { rebuilt++; return Promise.resolve(); },
		}));

		const p1 = arb.trigger();
		arb.trigger();                  // reentrant while first stat is deferred
		firstStat.reject(new Error("ENOENT")); // release stat as failure
		await p1;

		expect(statCall).toBe(2);
		expect(rebuilt).toBe(1);
	});

	test("swallows rebuild errors without rejection", async () => {
		const arb = new AutoRebuildTopology(makeDeps({
			rebuild: () => Promise.reject(new Error("DB locked")),
		}));
		await arb.trigger();
	});

	test("maybeTrigger is fire-and-forget (returns void)", async () => {
		const rebuildEntered = defer<void>();
		const arb = new AutoRebuildTopology(makeDeps({
			rebuild: () => { rebuildEntered.resolve(); return Promise.resolve(); },
		}));
		const result = arb.maybeTrigger();
		expect(result).toBeUndefined();
		await rebuildEntered.promise;
	});
});
