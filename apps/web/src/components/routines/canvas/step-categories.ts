/**
 * Grouping for the canvas add-step palette (T-65).
 *
 * `STEP_TYPE_DESCRIPTIONS` is a flat list — fine for a tiny picker, awful for
 * a 16-item visual palette. This module reorganizes it into categories that
 * reflect what each step actually does:
 *
 *   compute      | agent, transform, run
 *   io           | http, mcp
 *   deck.read    | list/get tasks + inbox
 *   deck.write   | create/move/promote
 *   file         | write
 *   control      | wait, set_state
 *
 * Categories are referenced by stable `key` strings so the rendering layer
 * doesn't have to match on display labels. Order is fixed and meaningful:
 * compute/IO go first because they're the most common starting points;
 * control sinks to the bottom because most routines end with a state write.
 *
 * INVARIANT: every entry in `STEP_TYPE_DESCRIPTIONS` MUST appear in exactly
 * one category. The test `step-categories.test.ts` enforces this — when a
 * new step type lands, the test fails until the author classifies it here.
 */

import type { StepTemplateDescriptor } from "../spec-yaml";
import { STEP_TYPE_DESCRIPTIONS } from "../spec-yaml";

export interface StepCategory {
	/** Stable lookup key (also used as React list key). */
	readonly key: string;
	/** Display label for the category header. */
	readonly label: string;
	/** Short helper text shown under the category label. */
	readonly tagline: string;
	/** Descriptor entries that belong to this category, in display order. */
	readonly entries: ReadonlyArray<StepTemplateDescriptor>;
}

function pick(...keys: string[]): StepTemplateDescriptor[] {
	const byKey = new Map(STEP_TYPE_DESCRIPTIONS.map((d) => [d.key, d]));
	return keys.map((k) => {
		const found = byKey.get(k);
		if (!found) {
			throw new Error(
				`step-categories: descriptor "${k}" is missing from STEP_TYPE_DESCRIPTIONS`,
			);
		}
		return found;
	});
}

export const STEP_CATEGORIES: ReadonlyArray<StepCategory> = [
	{
		key: "compute",
		label: "Compute",
		tagline: "Run code or call a model.",
		entries: pick("agent", "transform", "run"),
	},
	{
		key: "io",
		label: "I/O",
		tagline: "Reach an external surface.",
		entries: pick("http", "mcp"),
	},
	{
		key: "deck-read",
		label: "Deck · Read",
		tagline: "Read tasks and inbox.",
		entries: pick("list_tasks", "list_inbox", "get_task", "get_inbox_item"),
	},
	{
		key: "deck-write",
		label: "Deck · Write",
		tagline: "Mutate tasks and inbox.",
		entries: pick(
			"create_inbox_item",
			"create_task",
			"move_task",
			"promote_inbox_item_to_task",
		),
	},
	{
		key: "file",
		label: "File",
		tagline: "Write to disk.",
		entries: pick("write"),
	},
	{
		key: "control",
		label: "Control",
		tagline: "Branch, sleep, or persist state.",
		entries: pick("if", "wait", "set_state"),
	},
];
