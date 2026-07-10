import { describe, expect, test } from "bun:test";
import { readFileSync, existsSync } from "fs";
import { resolve } from "path";

describe("Chat — context pack removal", () => {
	const src = readFileSync(resolve(import.meta.dirname!, "Chat.tsx"), "utf-8");

	test("ContextPackPanel import is removed from Chat", () => {
		expect(src).not.toContain('import { ContextPackPanel }');
		expect(src).not.toContain("import { ContextPackPanel } from");
	});

	test("ContextPackPanel JSX usage is removed from Chat", () => {
		expect(src).not.toContain("<ContextPackPanel");
	});

	test("ContextPackPanel component file still exists (preserved for workspace)", () => {
		expect(existsSync(resolve(import.meta.dirname!, "session", "ContextPackPanel.tsx"))).toBe(true);
	});
});
