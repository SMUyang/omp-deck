import { describe, test, expect, beforeAll, afterAll } from "bun:test";

const savedNavigator = globalThis.navigator;
const savedLocalStorage = globalThis.localStorage;

describe("i18n module init safety", () => {
	beforeAll(() => {
		// @ts-expect-error simulate non-browser environment
		delete globalThis.navigator;
		// @ts-expect-error simulate non-browser environment
		delete globalThis.localStorage;
	});

	afterAll(() => {
		globalThis.navigator = savedNavigator;
		globalThis.localStorage = savedLocalStorage;
	});

	test("imports without navigator or localStorage globals", async () => {
		// Must not throw — the module should fall back to defaults
		// when browser APIs are unavailable.
		const mod = await import("./index");
		expect(mod.default).toBeDefined();
		expect(mod.default.language).toBe("en");
	});
});
