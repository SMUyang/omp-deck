# Image Lightbox Design

## Decision

Add a unified in-deck image preview/lightbox for chat and tool result images.

The web UI already renders image data in several places, but each renderer owns
its own `<img>` markup and either caps the image size or links out to a raw data
URL. The new behavior should match the TUI expectation more closely: image
results are visible inline first, then users can click to inspect them at a much
larger size without leaving the deck.

## Current state

Existing image renderers:

- `apps/web/src/components/messages/UserMessage.tsx` renders pasted/uploaded
  user images as `h-28 w-28` thumbnails.
- `apps/web/src/components/messages/QueuedMessage.tsx` renders queued prompt
  images as `h-28 w-28` thumbnails.
- `apps/web/src/components/tools/GenerateImage.tsx` renders a generated image
  with `max-h-96`.
- `apps/web/src/components/tools/Browser.tsx` renders browser screenshots with
  `max-h-96`.
- `apps/web/src/components/tools/shared.tsx` renders generic tool result images
  first, but wraps them in `target="_blank"` data-URL links.

All of these already have image data in the form `{ data, mimeType }`, so this
feature is presentation-only. No protocol or backend change is required.

## Goals

- Keep images visible inline in chat/tool cards.
- Let users click any inline image to open a larger preview inside the deck.
- Support multi-image groups with previous/next navigation.
- Support Esc-to-close and backdrop-click close.
- Reuse one implementation across user messages, queued messages, generated
  images, browser screenshots, and generic tool result images.
- Preserve current thumbnail sizing enough that large screenshots do not push the
  rest of the conversation away.

## Non-goals

- Do not change image upload, storage, RPC protocol, or tool result schemas.
- Do not add pan/zoom controls in the first version.
- Do not include Markdown-rendered images in the first version.
- Do not add downloading/copying controls in the first version.
- Do not persist lightbox UI state across refresh.

## UX

Inline rendering:

- User and queued prompt images stay compact thumbnail grids.
- Tool result images stay larger inline previews, capped by height.
- Every image preview is a button with a clear accessible label such as
  `Open image 1 of 3`.

Lightbox overlay:

- Full-screen fixed overlay above chat content.
- Dark translucent backdrop.
- Centered image uses `max-w-[95vw] max-h-[90vh] object-contain` so it is never
  cropped.
- Close button in the top-right.
- Counter in the top-left when there is at least one image, e.g. `2 / 4`.
- Previous/next buttons appear only for multi-image groups.
- Keyboard:
  - `Escape`: close.
  - `ArrowLeft`: previous image when multiple images exist.
  - `ArrowRight`: next image when multiple images exist.

## Components

### `apps/web/src/components/ui/image-preview.ts`

Pure helper module.

Responsibilities:

- Define preview item types.
- Convert `{ data, mimeType }` image blocks to data URLs.
- Clamp the initial image index.
- Compute previous/next image indexes.

### `apps/web/src/components/ui/ImageLightbox.tsx`

Overlay component.

Props:

```ts
interface ImageLightboxProps {
  images: readonly ImagePreviewItem[];
  index: number;
  onIndexChange(index: number): void;
  onClose(): void;
}
```

Responsibilities:

- Render nothing when `images.length === 0`.
- Render the current image at large size.
- Handle Escape / ArrowLeft / ArrowRight while mounted.
- Avoid closing when the user clicks the image itself.
- Keep all state owned by the caller so preview grids can decide initial index.

### `apps/web/src/components/ui/ImagePreviewGrid.tsx`

Reusable inline preview grid.

Props:

```ts
interface ImagePreviewGridProps {
  images: readonly ImagePreviewSource[];
  altPrefix: string;
  thumbnailClassName?: string;
  containerClassName?: string;
}
```

Responsibilities:

- Convert image blocks to preview items.
- Render each image as a button containing an `<img>`.
- Open `ImageLightbox` at the clicked index.
- Preserve caller-controlled thumbnail sizing via `thumbnailClassName`.

## Integration points

Replace duplicated image markup in:

- `apps/web/src/components/messages/UserMessage.tsx`
- `apps/web/src/components/messages/QueuedMessage.tsx`
- `apps/web/src/components/tools/GenerateImage.tsx`
- `apps/web/src/components/tools/Browser.tsx`
- `apps/web/src/components/tools/shared.tsx`

Expected sizing:

- User/queued messages: `h-28 w-28 rounded border border-line object-cover`.
- Generate/browser/generic tool images:
  `max-h-96 w-auto rounded border border-line object-contain`.

## Error handling

- If an image has empty `data`, skip it rather than rendering a broken preview.
- If `mimeType` is missing at a call site, default to `image/png` before passing
  into the shared preview helper.
- If the current lightbox index becomes out of range, clamp it to a valid index.

## Tests

Add pure tests for helper behavior:

- Data URL generation includes MIME type and base64 payload.
- Empty image payloads are filtered out.
- Initial index is clamped into range.
- Previous/next index navigation wraps around.

Add a component smoke test only if the local test environment has a DOM. If not,
manual browser verification is sufficient for overlay interactions because the
project currently has no React Testing Library dependency and existing web tests
mostly exercise pure helpers.

Manual verification:

1. Start the deck locally.
2. Send or inspect a message containing a user image.
3. Click the thumbnail; the lightbox opens.
4. Press Esc; it closes.
5. Inspect a browser screenshot or generated image tool result.
6. Click it; the lightbox opens with a large preview.
7. For a multi-image group, verify previous/next buttons and arrow keys.

## Acceptance criteria

- User images, queued images, generated images, browser screenshots, and generic
  tool result images all open in the same lightbox.
- Inline previews remain visible before opening the lightbox.
- No backend/protocol files are modified.
- Web typecheck and relevant tests pass.
