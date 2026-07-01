import { describe, expect, test } from "bun:test";

import {
	clampImageIndex,
	imageDataUrl,
	nextImageIndex,
	normalizePreviewImages,
	previousImageIndex,
} from "./image-preview";

describe("image preview helpers", () => {
	test("builds data URLs from MIME type and base64 payload", () => {
		expect(imageDataUrl({ data: "abc123", mimeType: "image/webp" })).toBe("data:image/webp;base64,abc123");
	});

	test("defaults missing MIME types to image/png", () => {
		expect(imageDataUrl({ data: "abc123" })).toBe("data:image/png;base64,abc123");
	});

	test("filters empty image payloads and assigns labels", () => {
		expect(
			normalizePreviewImages(
				[
					{ data: "", mimeType: "image/png" },
					{ data: "one", mimeType: "image/png" },
					{ data: "two", mimeType: "image/jpeg" },
				],
				"tool output",
			),
		).toEqual([
			{ src: "data:image/png;base64,one", alt: "tool output 1 of 2" },
			{ src: "data:image/jpeg;base64,two", alt: "tool output 2 of 2" },
		]);
	});
	test("filters whitespace-only image payloads", () => {
		expect(
			normalizePreviewImages(
				[
					{ data: "   ", mimeType: "image/png" },
					{ data: "\n\t", mimeType: "image/png" },
				],
				"pasted",
			),
		).toEqual([]);
	});


	test("uses bare prefix for single images", () => {
		const items = normalizePreviewImages([{ data: "x", mimeType: "image/png" }], "screenshot");
		expect(items).toEqual([{ src: "data:image/png;base64,x", alt: "screenshot" }]);
	});

	test("clamps indexes into valid image range", () => {
		expect(clampImageIndex(-1, 3)).toBe(0);
		expect(clampImageIndex(0, 3)).toBe(0);
		expect(clampImageIndex(2, 3)).toBe(2);
		expect(clampImageIndex(3, 3)).toBe(2);
		expect(clampImageIndex(99, 0)).toBe(0);
	});

	test("wraps previous and next indexes", () => {
		expect(previousImageIndex(0, 3)).toBe(2);
		expect(previousImageIndex(2, 3)).toBe(1);
		expect(nextImageIndex(2, 3)).toBe(0);
		expect(nextImageIndex(0, 3)).toBe(1);
		expect(previousImageIndex(0, 0)).toBe(0);
		expect(nextImageIndex(0, 0)).toBe(0);
	});
});
