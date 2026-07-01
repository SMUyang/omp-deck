# CPA Vision Input and Image Generation Design

> **Superseded.** This combined spec was split after review into:
>
> - `2026-07-01-cpa-usage-design.md`
> - `2026-07-01-image-models-design.md`
>
> Use those two specs for implementation planning.

## Decision

Implement **both** visual understanding and image generation for `omp-deck`,
but in separate phases:

1. First fix vision input through the RPC backend.
2. Then add explicit model capability metadata.
3. Then add a dedicated image-generation flow.

This keeps two different data flows separate:

- **Vision input**: user provides images, model returns text.
- **Image generation**: user provides text, model/API returns images.

## Current state

The existing code already has most of the vision-input surface:

- `apps/web/src/components/Composer.tsx` accepts pasted/dropped images.
- WebSocket frames support `images?: ImageAttachment[]`.
- `SessionHandle.prompt()` accepts `images`.
- User and queued message components render image thumbnails.
- `ModelInfo.inputModes?: Array<"text" | "image">` exists.
- Model picker displays a `vision` badge when `inputModes` includes `image`.

The current gap is in the RPC bridge:

- `apps/server/src/bridge/rpc.ts` currently builds a `prompt` command with
  `type`, `message`, and optional `streamingBehavior`, but does not include
  `images`.

Therefore images attached in the web UI are lost when using the external
`omp --mode rpc` backend.

## Goals

### Vision input

Users can select a vision-capable CPA/OMP model and send images from the deck
composer. The RPC backend forwards the image payload to `omp --mode rpc`.

Example models observed in `/api/models` with image input include:

- `zai/glm-4.5v`
- `zai/glm-4.6v`
- `zai/glm-5v-turbo`
- `haochi/gpt-5.5`
- `haochi/gpt-5.4`
- `opencode-go/mimo-v2.5`
- `kimi-code/kimi-k2.5`

### Image generation

Users can invoke image generation through a clear deck entry point instead of
hiding it inside normal chat prompt behavior.

The initial entry point is a deck slash command:

```text
/image <prompt>
```

The result is saved under `/uploads/...` and displayed inline in the message
stream.

## Non-goals

- Do not implement a CLIProxyAPI usage collector in this feature.
- Do not scrape or edit CLIProxyAPI config to infer every image-generation
  model.
- Do not merge quota usage and request-level usage into one unlabeled panel.
- Do not block sending images to a model that lacks `vision` metadata in the
  first phase; warn instead.

## Protocol changes

Extend `ModelInfo` with output capability hints:

```ts
export interface ModelInfo {
  provider: string;
  id: string;
  label: string;
  inputModes?: Array<"text" | "image">;
  outputModes?: Array<"text" | "image">;
}
```

Semantics:

- `inputModes.includes("image")`: model can read images.
- `outputModes.includes("image")`: model/API can produce images.

Existing clients that ignore `outputModes` remain compatible.

## Phase 1: vision input through RPC

Update `RpcSessionHandle.prompt()` so it sends images in the RPC command:

```ts
{
  type: "prompt",
  message: text,
  streamingBehavior: "followUp",
  images: [
    { type: "image", data: base64, mimeType: "image/png" }
  ]
}
```

Acceptance:

- A prompt with images reaches `OmpRpcTransport.send()` with `images` intact.
- Existing text-only prompts are unchanged.
- Manual runtime test with a vision model can describe the attached image.

## Phase 2: model capability metadata

Normalize model capabilities in both bridges:

- In-process bridge: preserve existing `model.input` mapping to `inputModes`.
- RPC bridge: preserve existing `model.input` mapping to `inputModes`.
- Add `outputModes` when model metadata exposes it.
- Add conservative detection for known image-generation model IDs only when no
  explicit metadata exists.

UI:

- Model picker displays `vision` for image input.
- Model picker displays `image gen` for image output.
- Composer warns when images are attached and current model lacks image input.

The warning is advisory in phase 2 because provider metadata can be incomplete.

## Phase 3: image generation command

Add a deck-side `/image` command.

Flow:

```text
Composer /image prompt
→ web virtual/deck command
→ server image-generation handler
→ selected image-generation model/provider
→ image bytes or URL result
→ persist to /uploads
→ append/render assistant image message
```

Model selection:

1. If the current model has `outputModes: ["image"]`, use it.
2. Otherwise choose the first available image-generation model for the active
   provider, if one exists.
3. Otherwise return an actionable error asking the user to select an image
   generation model.

Persistence:

- Store generated images via the existing upload root and `/uploads/...` serving
  path.
- Do not keep generated images only as transient base64 in the UI.

Rendering:

- Reuse existing markdown image rendering where possible.
- Reuse the existing generated-image tool renderer if the upstream event already
  arrives as a tool result.

## Error handling

Vision input:

- If the backend rejects image input, surface the provider error in the chat.
- If current model lacks `vision` metadata, show a warning but do not block.

Image generation:

- If no image-generation model is available, return a clear message:
  `No image-generation model is available. Select a model with image gen.`
- If generation succeeds but persistence fails, show the raw provider error and
  do not append a broken image link.
- If the provider returns a remote URL, download and persist it before rendering
  when possible; otherwise render the URL with a warning that it is external.

## Tests

Phase 1:

- RPC prompt command includes `images` when images are supplied.
- RPC prompt command omits `images` for text-only prompts.

Phase 2:

- Model normalization maps `input: ["text", "image"]` to `inputModes`.
- Model picker view model exposes `vision` and `image gen` badges.
- Composer warning appears when images are attached to a non-vision model.

Phase 3:

- `/image` command routes to the image-generation flow.
- Generated image is persisted under `/uploads`.
- Message renderer displays the persisted image.
- Error path returns actionable text when no image-generation model exists.

## Implementation order

1. Fix RPC image forwarding.
2. Add regression tests for RPC prompt image payloads.
3. Add `outputModes` to protocol and bridge normalization.
4. Add UI badges and composer warning.
5. Add `/image` command and server generation flow.
6. Add image persistence and rendering tests.
7. Run targeted tests and typechecks.

## Open questions resolved

- Scope includes both vision input and image generation.
- Implementation is phased: vision input first, image generation second.
- CLIProxyAPI usage collection is explicitly out of scope for this feature.
