import { describe, expect, test } from "bun:test";

import { getInitialStatusPanelOpen, STATUS_PANEL_STORAGE_KEY } from "./store";

describe("status panel chrome state", () => {
	test("defaults the status panel open on desktop with its own storage key", () => {
		const values = new Map<string, string>();
		const storage = { getItem: (key: string) => values.get(key) ?? null };

		expect(getInitialStatusPanelOpen(storage, true)).toBe(true);
		expect(STATUS_PANEL_STORAGE_KEY).toBe("omp-deck:status-panel-open");
	});

	test("honors persisted closed status panel preference on desktop", () => {
		const storage = { getItem: (key: string) => (key === STATUS_PANEL_STORAGE_KEY ? "0" : null) };

		expect(getInitialStatusPanelOpen(storage, true)).toBe(false);
	});

	test("keeps status panel closed by default on mobile", () => {
		const storage = { getItem: () => null };

		expect(getInitialStatusPanelOpen(storage, false)).toBe(false);
	});
});
