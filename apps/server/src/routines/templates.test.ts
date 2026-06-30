/**
 * Smoke tests for routine templates. Every `.yaml` file under
 * `apps/server/src/templates/` is parsed + validated against the V1 routine
 * spec schema. Adding a new template here is the cheap way to catch typos
 * (unknown step type, missing required field, regex-failing id) before they
 * 500 the install endpoint at runtime.
 *
 * The test is dynamic: it iterates whatever templates are present on disk
 * rather than hardcoding a slug list. That way local-only templates (e.g.
 * user-specific paper-trading sleeves gitignored away from the public repo)
 * still get validated in dev, but CI doesn't fail when they're absent.
 */

import { describe, expect, test } from "bun:test";

import { validateRoutineSpec } from "@omp-deck/protocol";

import { listTemplates, loadTemplate } from "./templates.ts";

/** Templates that MUST ship in the public repo. Anything else is best-effort. */
const REQUIRED_SHIPPED = ["daily-briefing", "memory-graph-maintainer"] as const;

describe("routine templates", () => {
	test("every required shipped template is in the listing", () => {
		const slugs = new Set(listTemplates().map((t) => t.slug));
		for (const required of REQUIRED_SHIPPED) {
			expect(slugs.has(required)).toBe(true);
		}
	});

	const templates = listTemplates();
	for (const summary of templates) {
		test(`${summary.slug}: loads + passes schema validation`, () => {
			const loaded = loadTemplate(summary.slug);
			expect(loaded).not.toBeNull();
			if (!loaded) return;
			const result = validateRoutineSpec(loaded.spec);
			if (!result.valid) {
				const reasons = (result.errors ?? []).map((e) => `  ${e.path}: ${e.message}`).join("\n");
				throw new Error(`${summary.slug} failed validation:\n${reasons}`);
			}
		});
	}

	test("memory-graph-maintainer uses runtime deck port instead of hard-coded default port", () => {
		const loaded = loadTemplate("memory-graph-maintainer");
		expect(loaded).not.toBeNull();
		if (!loaded) return;
		const httpUrls = loaded.spec.steps
			.filter((step) => step.type === "http")
			.map((step) => step.url);
		expect(httpUrls.length).toBeGreaterThan(0);
		for (const url of httpUrls) {
			expect(url).toContain("{{ env.OMP_DECK_PORT }}");
			expect(url).not.toContain("127.0.0.1:8787");
		}
	});
});
