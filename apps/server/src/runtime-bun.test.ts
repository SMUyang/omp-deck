/**
 * Tests for the Bun-executable resolution helper (issue #6).
 *
 * The helper is a thin wrapper around `process.execPath` + `Bun.which` +
 * `existsSync`. Three behaviors that matter:
 *   1. Returns process.execPath when it exists (fast path).
 *   2. Falls back to Bun.which("bun") when process.execPath is stale.
 *   3. Throws with both attempts logged when neither resolves.
 *
 * The cache behavior is implicit — we reset between tests with the
 * exported helper.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { buildOmpCommand, resetResolvedBunExecutable, resolveBunExecutable } from "./runtime-bun.ts";

afterEach(() => {
	resetResolvedBunExecutable();
});

describe("buildOmpCommand", () => {
	test("runs the global JavaScript CLI through Bun when PATH omits Bun", () => {
		const command = buildOmpCommand("/Users/hyan/.bun/install/global/node_modules/@oh-my-pi/pi-coding-agent/dist/cli.js");
		expect(command).toHaveLength(2);
		expect(command[0]).toBe(process.execPath);
		expect(command[1]).toContain("/pi-coding-agent/dist/cli.js");
	});

	test("keeps native omp commands direct", () => {
		expect(buildOmpCommand("/usr/local/bin/omp")).toEqual(["/usr/local/bin/omp"]);
	});
});

describe("resolveBunExecutable", () => {
	test("returns a path that exists on disk", async () => {
		// This is a real call against the running interpreter — it must
		// resolve to something the OS can spawn. We don't assert the exact
		// path because that varies per machine; we just verify it's
		// runnable.
		const bunPath = resolveBunExecutable();
		expect(bunPath.length).toBeGreaterThan(0);
		// File should exist.
		const { existsSync } = await import("node:fs");
		expect(existsSync(bunPath)).toBe(true);
	});

	test("memoizes — second call returns same result without re-checking", () => {
		const first = resolveBunExecutable();
		const second = resolveBunExecutable();
		expect(second).toBe(first);
	});

	test("falls back to Bun.which when process.execPath is stale", () => {
		// Simulate the issue #6 scenario: process.execPath points at a
		// path that no longer exists on disk. The helper should skip it
		// and consult Bun.which("bun") for the real binary.
		const realExecPath = process.execPath;
		const realBun = Bun.which("bun");
		// Skip the test gracefully if the test environment can't satisfy
		// the precondition (Bun.which can't find bun on PATH at all).
		if (!realBun) {
			return;
		}
		Object.defineProperty(process, "execPath", {
			value: "/definitely/does/not/exist/bun",
			configurable: true,
		});
		try {
			resetResolvedBunExecutable();
			const resolved = resolveBunExecutable();
			expect(resolved).toBe(realBun);
		} finally {
			Object.defineProperty(process, "execPath", {
				value: realExecPath,
				configurable: true,
			});
		}
	});

	test("throws a clear error when nothing resolves", () => {
		// Force both candidates to fail. We can't easily mock Bun.which
		// without monkey-patching the global Bun object, so we shadow the
		// `which` method on a spy and restore.
		const realExecPath = process.execPath;
		const realWhich = Bun.which;
		Object.defineProperty(process, "execPath", {
			value: "/nonexistent/bun",
			configurable: true,
		});
		(Bun as unknown as { which: (cmd: string) => string | null }).which = () => null;
		try {
			resetResolvedBunExecutable();
			expect(() => resolveBunExecutable()).toThrow(/could not resolve bun executable/);
		} finally {
			Object.defineProperty(process, "execPath", {
				value: realExecPath,
				configurable: true,
			});
			(Bun as unknown as { which: (cmd: string) => string | null }).which = realWhich;
		}
	});
});
