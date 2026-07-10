import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
Object.defineProperty(globalThis, "navigator", {
	value: { language: "en" },
	configurable: true,
});

const { Layout } = await import("./Layout");

describe("Layout", () => {
	test("renders with sidebar and inspector as null (no drawers, no toggles)", () => {
		const html = renderToString(
			createElement(MemoryRouter, { initialEntries: ["/"] },
				createElement(Layout, {
					sidebar: null,
					main: createElement("div", null, "main content"),
					inspector: null,
				}),
			),
		);
		// When both capabilities are absent, no panel toggles should render.
		expect(html).not.toContain('aria-label="sessions"');
		expect(html).not.toContain('aria-label="status"');
		// Main content must still render.
		expect(html).toContain("main content");
	});

	test("uses labels as the default accessible toggle names", () => {
		const html = renderToString(
			createElement(MemoryRouter, { initialEntries: ["/"] },
				createElement(Layout, {
					sidebar: { content: createElement("div", null, "sessions"), label: "sessions" },
					main: createElement("div", null, "main content"),
					inspector: { content: createElement("div", null, "status"), label: "status" },
				}),
			),
		);
		expect(html).toContain('aria-label="sessions"');
		expect(html).toContain('aria-label="status"');
	});

	test("uses explicit toggle titles when provided", () => {
		const html = renderToString(
			createElement(MemoryRouter, { initialEntries: ["/"] },
				createElement(Layout, {
					sidebar: {
						content: createElement("div", null, "sessions"),
						label: "sessions",
						toggleTitle: "Toggle sessions",
					},
					main: createElement("div", null, "main content"),
					inspector: {
						content: createElement("div", null, "status"),
						label: "status",
						toggleTitle: "Toggle status panel",
					},
				}),
			),
		);
		expect(html).toContain('aria-label="Toggle sessions"');
		expect(html).toContain('aria-label="Toggle status panel"');
	});

	test("uses capability labels in mobile panel chrome", () => {
		const html = renderToString(
			createElement(MemoryRouter, { initialEntries: ["/"] },
				createElement(Layout, {
					sidebar: {
						content: createElement("div", null, "sidebar content"),
						label: "Knowledge files",
					},
					main: createElement("div", null, "main content"),
					inspector: {
						content: createElement("div", null, "inspector content"),
						label: "Knowledge details",
					},
				}),
			),
		);
		expect(html).toContain('aria-label="Close Knowledge files"');
		expect(html).toContain('aria-label="Close Knowledge details"');
		expect(html).toContain(">Knowledge files<");
		expect(html).toContain(">Knowledge details<");
	});

	test("toolCardsToggle hides the toggle button when false or absent", () => {
		const htmlDefault = renderToString(
			createElement(MemoryRouter, { initialEntries: ["/"] },
				createElement(Layout, {
					sidebar: null,
					main: createElement("div", null, "main"),
					inspector: null,
				}),
			),
		);
		// Without toolCardsToggle=true, the ToolCardsToggle button must not render.
		expect(htmlDefault).not.toContain('aria-label="Collapse all tool cards"');
		expect(htmlDefault).not.toContain('aria-label="Expand all tool cards"');

		const htmlEnabled = renderToString(
			createElement(MemoryRouter, { initialEntries: ["/"] },
				createElement(Layout, {
					sidebar: null,
					main: createElement("div", null, "main"),
					inspector: null,
					toolCardsToggle: true,
				}),
			),
		);
		expect(htmlEnabled).toMatch(/aria-label="(?:Collapse|Expand) all tool cards"/);
	});
});
