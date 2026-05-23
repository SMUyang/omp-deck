import { describe, expect, it } from "bun:test";

import { diffIsClean, lineDiff } from "./yaml-diff";

describe("lineDiff", () => {
	it("returns empty for two empty strings", () => {
		expect(lineDiff("", "")).toEqual([]);
		expect(diffIsClean(lineDiff("", ""))).toBe(true);
	});

	it("treats trailing newline as equivalent", () => {
		const d = lineDiff("a\nb\n", "a\nb");
		expect(diffIsClean(d)).toBe(true);
		expect(d.map((l) => l.kind)).toEqual(["same", "same"]);
	});

	it("flags pure additions", () => {
		const d = lineDiff("a\nb", "a\nb\nc");
		expect(d).toEqual([
			{ kind: "same", text: "a" },
			{ kind: "same", text: "b" },
			{ kind: "add", text: "c" },
		]);
		expect(diffIsClean(d)).toBe(false);
	});

	it("flags pure deletions", () => {
		const d = lineDiff("a\nb\nc", "a\nb");
		expect(d).toEqual([
			{ kind: "same", text: "a" },
			{ kind: "same", text: "b" },
			{ kind: "del", text: "c" },
		]);
	});

	it("flags a single-line replacement as del+add", () => {
		const d = lineDiff("a\nb\nc", "a\nB\nc");
		expect(d).toEqual([
			{ kind: "same", text: "a" },
			{ kind: "del", text: "b" },
			{ kind: "add", text: "B" },
			{ kind: "same", text: "c" },
		]);
	});

	it("handles a when:-gate insertion (the T-69 scenario)", () => {
		const before = [
			"steps:",
			"  - id: should_run",
			"    type: transform",
			"  - id: fetch",
			"    type: run",
			"    command: echo hi",
		].join("\n");
		const after = [
			"steps:",
			"  - id: should_run",
			"    type: transform",
			"  - id: fetch",
			"    type: run",
			"    command: echo hi",
			"    when: steps.should_run.json === true",
		].join("\n");
		const d = lineDiff(before, after);
		expect(d.filter((l) => l.kind === "add")).toEqual([
			{ kind: "add", text: "    when: steps.should_run.json === true" },
		]);
		expect(d.filter((l) => l.kind === "del").length).toBe(0);
	});

	it("emits add for empty -> non-empty", () => {
		const d = lineDiff("", "a\nb");
		expect(d).toEqual([
			{ kind: "add", text: "a" },
			{ kind: "add", text: "b" },
		]);
	});

	it("emits del for non-empty -> empty", () => {
		const d = lineDiff("a\nb", "");
		expect(d).toEqual([
			{ kind: "del", text: "a" },
			{ kind: "del", text: "b" },
		]);
	});

	it("preserves blank lines as separate units", () => {
		// A blank structural separator that moves should diff as del+add, not
		// silently collapse.
		const before = "a\n\nb";
		const after = "a\nb";
		const d = lineDiff(before, after);
		expect(d).toEqual([
			{ kind: "same", text: "a" },
			{ kind: "del", text: "" },
			{ kind: "same", text: "b" },
		]);
	});

	it("is stable on a reorder (LCS picks one consistent alignment)", () => {
		const before = "a\nb\nc";
		const after = "c\nb\na";
		const d = lineDiff(before, after);
		// The diff isn't unique; we just assert it's clean enough that adds + dels
		// account for the rearrangement and at least one line is matched.
		const adds = d.filter((l) => l.kind === "add").length;
		const dels = d.filter((l) => l.kind === "del").length;
		expect(adds).toBeGreaterThan(0);
		expect(dels).toBeGreaterThan(0);
		expect(d.filter((l) => l.kind === "same").length).toBeGreaterThan(0);
	});
});
