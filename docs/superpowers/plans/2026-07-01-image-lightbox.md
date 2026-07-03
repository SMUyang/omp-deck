# Image Lightbox Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a unified in-deck lightbox so chat and tool result images display inline first and can be clicked for a large preview.

**Architecture:** Keep the feature entirely in the web presentation layer. Add pure image-preview helpers, one overlay component, and one reusable preview-grid component; then replace duplicated `<img>` markup in user messages, queued messages, generated image results, browser screenshots, and generic tool image results.

**Tech Stack:** React 18, TypeScript, Bun tests, Tailwind classes, existing `ImageBlock` shapes from `apps/web/src/lib/types.ts`.

---

## File structure

- Create: `apps/web/src/components/ui/image-preview.ts`
  - Pure helper module for image preview item types, data URL creation, image filtering, index clamping, and wraparound navigation.
- Create: `apps/web/src/components/ui/image-preview.test.ts`
  - Bun tests for helper behavior. This avoids adding a DOM testing dependency.
- Create: `apps/web/src/components/ui/ImageLightbox.tsx`
  - Full-screen overlay component. Owns keyboard handlers while mounted; receives image list and current index from caller.
- Create: `apps/web/src/components/ui/ImagePreviewGrid.tsx`
  - Reusable inline image grid. Converts source image blocks to preview items, renders clickable thumbnails, and opens `ImageLightbox`.
- Modify: `apps/web/src/components/messages/UserMessage.tsx`
  - Replace custom thumbnail `<img>` loop with `ImagePreviewGrid`.
- Modify: `apps/web/src/components/messages/QueuedMessage.tsx`
  - Replace custom thumbnail `<img>` loop with `ImagePreviewGrid`.
- Modify: `apps/web/src/components/tools/GenerateImage.tsx`
  - Render generated images through `ImagePreviewGrid`.
- Modify: `apps/web/src/components/tools/Browser.tsx`
  - Render screenshots through `ImagePreviewGrid`.
- Modify: `apps/web/src/components/tools/shared.tsx`
  - Render generic result images through `ImagePreviewGrid`; remove raw `target="_blank"` data URL link behavior.

No backend, protocol, route, or RPC files should change.

## Task 1: Add pure image preview helpers

**Files:**
- Create: `apps/web/src/components/ui/image-preview.ts`
- Create: `apps/web/src/components/ui/image-preview.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `apps/web/src/components/ui/image-preview.test.ts`:

```ts
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

	test("uses bare prefix for single images", () => {
		const items = normalizePreviewImages(
			[{ data: "x", mimeType: "image/png" }],
			"screenshot",
		);
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
```

- [ ] **Step 2: Run the failing test**

Run:

```sh
bun test apps/web/src/components/ui/image-preview.test.ts
```

Expected: FAIL because `apps/web/src/components/ui/image-preview.ts` does not exist.

- [ ] **Step 3: Implement the helper module**

Create `apps/web/src/components/ui/image-preview.ts`:

```ts
export interface ImagePreviewSource {
	data: string;
	mimeType?: string;
}

export interface ImagePreviewItem {
	src: string;
	alt: string;
}

export function imageDataUrl(image: ImagePreviewSource): string {
	return `data:${image.mimeType || "image/png"};base64,${image.data}`;
}

export function normalizePreviewImages(
	images: readonly ImagePreviewSource[],
	altPrefix: string,
): ImagePreviewItem[] {
	const valid = images.filter((image) => image.data.trim().length > 0);
	if (valid.length === 1) {
		return [{ src: imageDataUrl(valid[0]!), alt: altPrefix }];
	}
	return valid.map((image, index) => ({
		src: imageDataUrl(image),
		alt: `${altPrefix} ${index + 1} of ${valid.length}`,
	}));
}

export function clampImageIndex(index: number, imageCount: number): number {
	if (imageCount <= 0) return 0;
	if (index < 0) return 0;
	if (index >= imageCount) return imageCount - 1;
	return index;
}

export function previousImageIndex(index: number, imageCount: number): number {
	if (imageCount <= 0) return 0;
	return (index - 1 + imageCount) % imageCount;
}

export function nextImageIndex(index: number, imageCount: number): number {
	if (imageCount <= 0) return 0;
	return (index + 1) % imageCount;
}
```

- [ ] **Step 4: Verify the helper tests pass**

Run:

```sh
bun test apps/web/src/components/ui/image-preview.test.ts
```

Expected: all tests pass.

- [ ] **Step 5: Commit helper module**

Stage only the helper and its test:

```sh
git add apps/web/src/components/ui/image-preview.ts apps/web/src/components/ui/image-preview.test.ts
git commit -m "Add image preview helpers"
```

## Task 2: Add the lightbox and reusable preview grid

**Files:**
- Create: `apps/web/src/components/ui/ImageLightbox.tsx`
- Create: `apps/web/src/components/ui/ImagePreviewGrid.tsx`
- Test: `apps/web/src/components/ui/image-preview.test.ts`

- [ ] **Step 1: Verify existing helper tests still pass**

```sh
bun test apps/web/src/components/ui/image-preview.test.ts
```

Expected: all tests pass (7 tests from Task 1 covering data URLs, normalization, single-image alt, index clamping, and wrap-around arrows).

- [ ] **Step 2: Create ImageLightbox component**



Create `apps/web/src/components/ui/ImageLightbox.tsx`:

```tsx
import { useEffect, type ReactNode } from "react";
import { ChevronLeft, ChevronRight, X } from "lucide-react";
import type { ImagePreviewItem } from "./image-preview";
import { previousImageIndex, nextImageIndex } from "./image-preview";

interface ImageLightboxProps {
	images: readonly ImagePreviewItem[];
	index: number;
	onIndexChange(index: number): void;
	onClose(): void;
}

export function ImageLightbox({ images, index, onIndexChange, onClose }: ImageLightboxProps): ReactNode {
	if (images.length === 0) return null;

	const clamped = Math.max(0, Math.min(index, images.length - 1));
	const current = images[clamped];
	if (!current) return null;

	useEffect(() => {
		const handleKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				onClose();
			} else if (e.key === "ArrowLeft") {
				e.preventDefault();
				onIndexChange(previousImageIndex(clamped, images.length));
			} else if (e.key === "ArrowRight") {
				e.preventDefault();
				onIndexChange(nextImageIndex(clamped, images.length));
			}
		};
		window.addEventListener("keydown", handleKey);
		return () => window.removeEventListener("keydown", handleKey);
	}, [clamped, images.length, onClose, onIndexChange]);

	return (
		<div
			className="fixed inset-0 z-50 flex items-center justify-center bg-black/85"
			onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
		>
			{/* Close button */}
			<button
				type="button"
				className="absolute top-4 right-4 rounded-full bg-white/10 p-2 text-white hover:bg-white/20"
				onClick={onClose}
				aria-label="Close preview"
			>
				<X className="h-5 w-5" />
			</button>

			{/* Counter */}
			<div className="absolute top-4 left-4 rounded bg-white/10 px-3 py-1 font-mono text-sm text-white">
				{images.length > 1 ? `${clamped + 1} / ${images.length}` : null}
			</div>

			{/* Previous */}
			{images.length > 1 ? (
				<button
					type="button"
					className="absolute left-4 rounded-full bg-white/10 p-2 text-white hover:bg-white/20"
					onClick={(e) => { e.stopPropagation(); onIndexChange(previousImageIndex(clamped, images.length)); }}
					aria-label="Previous image"
				>
					<ChevronLeft className="h-6 w-6" />
				</button>
			) : null}

			{/* Image */}
			<img
				src={current.src}
				alt={current.alt}
				className="max-w-[95vw] max-h-[90vh] object-contain"
				onClick={(e) => e.stopPropagation()}
			/>

			{/* Next */}
			{images.length > 1 ? (
				<button
					type="button"
					className="absolute right-4 rounded-full bg-white/10 p-2 text-white hover:bg-white/20"
					onClick={(e) => { e.stopPropagation(); onIndexChange(nextImageIndex(clamped, images.length)); }}
					aria-label="Next image"
				>
					<ChevronRight className="h-6 w-6" />
				</button>
			) : null}
		</div>
	);
}
```

- [ ] **Step 3: Create ImagePreviewGrid component**

Create `apps/web/src/components/ui/ImagePreviewGrid.tsx`:

```tsx
import { useState, type ReactNode } from "react";
import type { ImagePreviewSource } from "./image-preview";
import { normalizePreviewImages } from "./image-preview";
import { ImageLightbox } from "./ImageLightbox";

interface ImagePreviewGridProps {
	images: readonly ImagePreviewSource[];
	altPrefix: string;
	thumbnailClassName?: string;
	containerClassName?: string;
}

export function ImagePreviewGrid({
	images,
	altPrefix,
	thumbnailClassName = "h-28 w-28 rounded border border-line object-cover",
	containerClassName = "flex flex-wrap gap-1.5",
}: ImagePreviewGridProps): ReactNode {
	const items = normalizePreviewImages(images, altPrefix);
	const [lightbox, setLightbox] = useState<number | null>(null);

	if (items.length === 0) return null;

	return (
		<>
			<div className={containerClassName}>
				{items.map((item, i) => (
					<button
						key={item.src}
						type="button"
						className="cursor-zoom-in overflow-hidden p-0 border-none bg-transparent"
						onClick={() => setLightbox(i)}
						aria-label={`Open ${item.alt}`}
					>
						<img src={item.src} alt={item.alt} className={thumbnailClassName} />
					</button>
				))}
			</div>
			{lightbox !== null ? (
				<ImageLightbox
					images={items}
					index={lightbox}
					onIndexChange={setLightbox}
					onClose={() => setLightbox(null)}
				/>
			) : null}
		</>
	);
}
```

- [ ] **Step 4: Commit lightbox components**

```sh
git add apps/web/src/components/ui/ImageLightbox.tsx apps/web/src/components/ui/ImagePreviewGrid.tsx apps/web/src/components/ui/image-preview.test.ts
git commit -m "Add image lightbox and reusable preview grid"
```

## Task 3: Replace duplicated image markup with ImagePreviewGrid

**Files:**
- Modify: `apps/web/src/components/messages/UserMessage.tsx`
- Modify: `apps/web/src/components/messages/QueuedMessage.tsx`
- Modify: `apps/web/src/components/tools/GenerateImage.tsx`
- Modify: `apps/web/src/components/tools/Browser.tsx`
- Modify: `apps/web/src/components/tools/shared.tsx`

- [ ] **Step 1: Replace UserMessage thumbnail markup**

In `apps/web/src/components/messages/UserMessage.tsx`, replace the thumbnail
loop with `ImagePreviewGrid`. Use `altPrefix: "pasted"`, and keep the
same `h-28 w-28 rounded border border-line object-cover` className.

```tsx
import { ImagePreviewGrid } from "@/components/ui/ImagePreviewGrid";

// Inside the component, replace the {msg.images ...} block:
<ImagePreviewGrid
	images={msg.images as ImagePreviewSource[] ?? []}
	altPrefix="pasted"
	thumbnailClassName="h-28 w-28 rounded border border-line object-cover"
/>
```

- [ ] **Step 2: Replace QueuedMessage thumbnail markup**

Same pattern as UserMessage, with `altPrefix: "queued"`.

- [ ] **Step 3: Replace GenerateImage inline image**

In `apps/web/src/components/tools/GenerateImage.tsx`, replace the lone `<img>`
with `ImagePreviewGrid` using a single-element array and tool-friendly sizing.

```tsx
import { ImagePreviewGrid } from "@/components/ui/ImagePreviewGrid";

// Replace the <img> block:
{imageData ? (
	<ImagePreviewGrid
		images={[{ data: imageData.data, mimeType: imageData.mimeType }]}
		altPrefix="generated"
		thumbnailClassName="max-h-96 w-auto rounded border border-line object-contain"
	/>
) : null}
```

- [ ] **Step 4: Replace Browser screenshot markup**

In `apps/web/src/components/tools/Browser.tsx`, replace the `<img>` with
`ImagePreviewGrid`. Use `altPrefix: "screenshot"`.

- [ ] **Step 5: Replace shared ResultImages markup**

In `apps/web/src/components/tools/shared.tsx`, replace the `extractResultImages`
loop with a single `ImagePreviewGrid` call. Remove the `target="_blank"` data
URL anchor behavior. Use `altPrefix: "tool output"`.

- [ ] **Step 6: Run typecheck**

```sh
bun run --filter '@omp-deck/web' typecheck
```

Expected: exit 0.

- [ ] **Step 7: Run helper and web tests**

```sh
bun test apps/web/src/components/ui/image-preview.test.ts
```

Expected: all tests pass.

- [ ] **Step 8: Manual browser verification**

Start the deck:

```sh
bash start-rpc-deck.sh stop
bash start-rpc-deck.sh start
```

Open `http://127.0.0.1:5173`, verify:

- A user-created session with a pasted image shows the inline thumbnail.
- Clicking the thumbnail opens the lightbox.
- Esc or backdrop click closes it.
- A browser screenshot or generated image tool result opens the lightbox at
  the larger tool-size inline preview first.

- [ ] **Step 9: Commit integration**

```sh
git add apps/web/src/components/messages/UserMessage.tsx apps/web/src/components/messages/QueuedMessage.tsx apps/web/src/components/tools/GenerateImage.tsx apps/web/src/components/tools/Browser.tsx apps/web/src/components/tools/shared.tsx
git commit -m "Replace duplicated image markup with unified lightbox"
```