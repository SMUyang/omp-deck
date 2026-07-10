import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { resolve } from "path";

describe("Sidebar — topology chrome removal", () => {
	const src = readFileSync(resolve(import.meta.dirname!, "Sidebar.tsx"), "utf-8");

	test("TopologyMemoryPanel import is removed", () => {
		expect(src).not.toContain('import { TopologyMemoryPanel }');
		expect(src).not.toContain('import { TopologyMemoryPanel,');
		expect(src).not.toContain("import { TopologyMemoryPanel } from");
	});

	test("TopologyMemoryPanel usage is removed", () => {
		expect(src).not.toContain("<TopologyMemoryPanel");
	});
});

describe("Sidebar — plan-mode layout contract", () => {
	const src = readFileSync(resolve(import.meta.dirname!, "Sidebar.tsx"), "utf-8");

	test("title span has min-w-0 flex-1 truncate for 390px overflow safety", () => {
		// The title must shrink and truncate so the plan badge never overflows
		// the row at narrow viewports.
		expect(src).toContain('"min-w-0 flex-1 truncate"');
	});

	test("plan badge has ml-auto shrink-0 so it never wraps or clips", () => {
		expect(src).toContain('ml-auto shrink-0');
		expect(src).toContain('"ml-auto shrink-0 rounded border border-thinking/40');
	});

	test("SessionContextStatusChip is outside the session-click button (no nested buttons)", () => {
		// SessionContextStatusChip renders its own <button> for rebuild, so it
		// must be a sibling of the session <button>, not nested inside it.
		// The plan badge is intentionally inside the button (non-interactive span).
		expect(src).toContain("<SessionContextStatusChip");
		const buttonCloseIdx = src.indexOf("</button>");
		const statusChipIdx = src.indexOf("<SessionContextStatusChip");
		expect(buttonCloseIdx).toBeGreaterThan(0);
		expect(statusChipIdx).toBeGreaterThan(buttonCloseIdx);
	});
});
