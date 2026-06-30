/**
 * Tests for the V1 routine template engine + sandbox. Covers the T-45
 * acceptance criteria plus additional edge cases that the daily-briefing and
 * inbox-triager routines will exercise at runtime.
 */

import { describe, expect, test } from "bun:test";

import { evaluate } from "./sandbox.ts";
import { render, renderString } from "./template.ts";
import { buildRoutineEnv } from "./v1-runner.ts";

const sampleContext = {
	run: {
		id: "run_abc123",
		date: "2026-05-21",
		iso_started: "2026-05-21T07:00:00.000Z",
		started: "2026-05-21T07:00:00.000Z",
	},
	trigger: { kind: "cron" },
	steps: {
		fetch: {
			status: "success",
			json: {
				messages: [
					{ id: "m1", subject: "A" },
					{ id: "m2", subject: "B" },
				],
				history_id: "12345",
			},
		},
		should_run: { json: true },
	},
	env: { TZ: "America/Chicago" },
	secrets: { MY_KEY: "sk-do-not-leak-abc", OTHER: "shh" },
	state: { last_briefing_date: "2026-05-20" },
};

describe("routine env", () => {
	test("derives OMP_DECK_API_BASE from host and port when unset", () => {
		const env = buildRoutineEnv({ OMP_DECK_HOST: "127.0.0.1", OMP_DECK_PORT: "8902" });
		expect(env.OMP_DECK_API_BASE).toBe("http://127.0.0.1:8902/api");
	});

	test("keeps explicit OMP_DECK_API_BASE", () => {
		const env = buildRoutineEnv({ OMP_DECK_API_BASE: "http://deck.local/api", OMP_DECK_PORT: "8902" });
		expect(env.OMP_DECK_API_BASE).toBe("http://deck.local/api");
	});
});

// ─── template.render — value-mode (whole-value substitution) ───────────────

describe("template.render — value mode (single bare expression)", () => {
	test("'{{ run.id }}' returns the string", () => {
		expect(render("{{ run.id }}", sampleContext)).toBe("run_abc123");
	});

	test("'{{ steps.fetch.json }}' returns the underlying object (not '[object Object]')", () => {
		const out = render("{{ steps.fetch.json }}", sampleContext);
		expect(typeof out).toBe("object");
		expect(out).toEqual(sampleContext.steps.fetch.json);
	});

	test("'{{ steps.fetch.json.messages }}' returns the array", () => {
		const out = render("{{ steps.fetch.json.messages }}", sampleContext);
		expect(Array.isArray(out)).toBe(true);
		expect((out as unknown[]).length).toBe(2);
	});

	test("'{{ steps.fetch.json.messages.length }}' returns the number (array.length property access)", () => {
		expect(render("{{ steps.fetch.json.messages.length }}", sampleContext)).toBe(2);
	});

	test("missing path returns undefined (not throws)", () => {
		expect(render("{{ steps.nope.json }}", sampleContext)).toBe(undefined);
	});

	test("'  {{ run.id }}  ' (with whitespace) still triggers value mode", () => {
		expect(render("  {{ run.id }}  ", sampleContext)).toBe("run_abc123");
	});
});

// ─── template.render — string-mode (interpolation) ─────────────────────────

describe("template.render — string mode (embedded expressions)", () => {
	test("'Hi {{ run.id }}' stringifies and concatenates", () => {
		expect(render("Hi {{ run.id }}", sampleContext)).toBe("Hi run_abc123");
	});

	test("multiple expressions in one template", () => {
		expect(render("{{ run.id }} @ {{ run.date }}", sampleContext)).toBe(
			"run_abc123 @ 2026-05-21",
		);
	});

	test("object value embedded in string becomes JSON, not '[object Object]'", () => {
		const out = render("messages: {{ steps.fetch.json.messages }}", sampleContext);
		expect(typeof out).toBe("string");
		expect(out as string).toContain('"id":"m1"');
		expect(out as string).not.toContain("[object Object]");
	});

	test("number value in string", () => {
		expect(render("count: {{ steps.fetch.json.messages.length }}", sampleContext)).toBe(
			"count: 2",
		);
	});

	test("undefined path renders as empty string", () => {
		expect(render("[{{ steps.nope.json }}]", sampleContext)).toBe("[]");
	});
});

// ─── template helpers ──────────────────────────────────────────────────────

describe("template helpers", () => {
	test("`json` helper stringifies", () => {
		const out = render("{{ steps.fetch.json | json }}", sampleContext);
		expect(typeof out).toBe("string");
		expect(out as string).toContain('"messages"');
	});

	test("`length` helper on array", () => {
		expect(render("{{ steps.fetch.json.messages | length }}", sampleContext)).toBe(2);
	});

	test("`length` helper on string", () => {
		expect(render("{{ run.id | length }}", sampleContext)).toBe("run_abc123".length);
	});

	test("`length` helper on object", () => {
		expect(render("{{ steps.fetch.json | length }}", sampleContext)).toBe(2);
	});

	test("unknown helper throws with helpful message", () => {
		expect(() => render("{{ run.id | nope }}", sampleContext)).toThrow(/unknown helper/);
	});
});

// ─── renderString — always-string convenience wrapper ──────────────────────

describe("renderString", () => {
	test("forces value-mode result to string", () => {
		expect(renderString("{{ steps.fetch.json.messages.length }}", sampleContext)).toBe("2");
	});

	test("object becomes JSON via renderString", () => {
		const out = renderString("{{ steps.fetch.json }}", sampleContext);
		expect(typeof out).toBe("string");
		expect(out).toContain('"messages"');
	});
});

// ─── sandbox.evaluate — acceptance criteria from T-45 task spec ────────────

describe("sandbox.evaluate — T-45 acceptance", () => {
	test("'1 + 1' returns 2", async () => {
		expect(await evaluate("1 + 1", sampleContext)).toBe(2);
	});

	test("'context.steps.fetch.json.messages.length > 0' returns true", async () => {
		expect(
			await evaluate("context.steps.fetch.json.messages.length > 0", sampleContext),
		).toBe(true);
	});

	test("'context.state.last_briefing_date' returns the value", async () => {
		expect(await evaluate("context.state.last_briefing_date", sampleContext)).toBe(
			"2026-05-20",
		);
	});

	test("'require(\"fs\")' throws (no Node API surface)", async () => {
		await expect(evaluate('require("fs")', sampleContext)).rejects.toThrow();
	});

	test("'process.env.PATH' throws (no Node API surface)", async () => {
		await expect(evaluate("process.env.PATH", sampleContext)).rejects.toThrow();
	});

	test("'fetch(\"https://example.com\")' throws (no network)", async () => {
		await expect(evaluate('fetch("https://example.com")', sampleContext)).rejects.toThrow();
	});

	test("'while(true){}' aborts within ~150ms with timeout error", async () => {
		const t0 = Date.now();
		await expect(evaluate("while(true){}", sampleContext)).rejects.toThrow();
		const elapsed = Date.now() - t0;
		// 100ms timeout + WASM overhead + bun:test scheduling slop
		expect(elapsed).toBeLessThan(500);
	});

	test("'context.secrets.MY_KEY' returns the redacted marker, NOT the value", async () => {
		const out = await evaluate("context.secrets.MY_KEY", sampleContext);
		expect(out).toBe("[REDACTED]");
		expect(out).not.toBe("sk-do-not-leak-abc");
	});

	test("redaction applies to every secret, not just one", async () => {
		const out = await evaluate("context.secrets.OTHER", sampleContext);
		expect(out).toBe("[REDACTED]");
	});

	test("statement-form expression with `return` works (used by daily-briefing should_run)", async () => {
		const expr =
			"const today = '2026-05-21'; return context.state.last_briefing_date !== today;";
		expect(await evaluate(expr, sampleContext)).toBe(true);
	});
});
