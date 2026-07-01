# Image Models Design

## Decision

Implement image model support as a separate feature from CPA usage.

This feature includes two model capabilities:

1. **Vision input**: user supplies images and the model returns text.
2. **Image generation**: user supplies text and the model/API returns images.

Implementation is phased:

1. Fix vision input through the external `omp --mode rpc` backend.
2. Add model capability metadata and UI labels.
3. Add a dedicated image-generation command.

## Current state

The deck already supports much of the vision-input UI:

- `apps/web/src/components/Composer.tsx` accepts pasted/dropped image files.
- Composer sends `ImageAttachment[]` through WebSocket frames.
- `SessionHandle.prompt()` accepts `images`.
- User and queued message components render image thumbnails.
- `ModelInfo.inputModes?: Array<"text" | "image">` exists.
- Model picker displays a `vision` badge when `inputModes` includes `image`.

Observed `/api/models` already reports many image-input models, including:

- `zai/glm-4.5v`
- `zai/glm-4.6v`
- `zai/glm-5v-turbo`
- `haochi/gpt-5.5`
- `haochi/gpt-5.4`
- `opencode-go/mimo-v2.5`
- `kimi-code/kimi-k2.5`

The current RPC backend gap:

- `apps/server/src/bridge/rpc.ts` builds a `prompt` RPC command with `type`,
  `message`, and optional `streamingBehavior`, but currently drops
  `opts.images`.

Therefore image attachments are lost when using the RPC backend.

## Goals

- Vision-capable CPA/OMP models can receive user image attachments.
- Model picker distinguishes vision models from image-generation models.
- Users can invoke image generation through a clear deck entry point.
- Generated images are persisted under `/uploads/...` and render after reload.

## Non-goals

- Do not implement CPA usage or CLIProxyAPI usage collection here.
- Do not infer every image-generation model by scraping CLIProxyAPI config.
- Do not block sending images solely because metadata is incomplete.
- Do not store generated images only as transient base64.

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

- `inputModes.includes("image")`: model can read image input.
- `outputModes.includes("image")`: model/API can produce image output.

Existing clients that ignore `outputModes` remain compatible.

## Phase 1: vision input through RPC

Update `RpcSessionHandle.prompt()` to include images in the RPC command:

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

Rules:

- Include `images` only when provided and non-empty.
- Preserve existing text-only prompt behavior.
- Preserve `streamingBehavior` behavior.

Acceptance:

- A prompt with images reaches `OmpRpcTransport.send()` with `images` intact.
- Text-only prompt commands do not include `images`.
- Manual runtime test with a vision model can describe an attached image.

## Phase 2: model capability metadata

Normalize model capabilities in both bridges:

- In-process bridge: preserve existing `model.input` mapping to `inputModes`.
- RPC bridge: preserve existing `model.input` mapping to `inputModes`.
- Add `outputModes` when model metadata exposes image output.
- Use conservative known-model detection only when explicit metadata is absent.

Known-model detection should be small and maintainable:

- Prefer exact provider/model entries.
- Avoid broad substring rules that mark normal chat models as image generators.
- Keep overrides centralized.

UI:

- Model picker badge: `vision` for image input.
- Model picker badge: `image gen` for image output.
- Composer warning when images are attached and current model lacks image input.

The warning is advisory because provider metadata can be incomplete.

## Phase 3: image generation command

Add a deck-side slash command:

```text
/image <prompt>
```

Flow:

```text
Composer /image prompt
→ web deck command
→ server image-generation handler
→ selected image-generation model/provider
→ image bytes or URL result
→ persist to /uploads
→ append/render assistant image message
```

Model selection:

1. If the current model has `outputModes: ["image"]`, use it.
2. Otherwise choose the first available image-generation model for the current
   provider.
3. Otherwise return an actionable error asking the user to select an image
   generation model.

Persistence:

- Save generated images under the existing uploads root.
- Serve them through the existing `/uploads/...` static route.
- Store only the persisted `/uploads/...` URL in rendered messages when possible.

Rendering:

- Reuse existing markdown image rendering for persisted URLs.
- Reuse `GenerateImageTool` rendering if upstream emits an image tool result.
- Generated images should survive browser refresh.

## Error handling

Vision input:

- If the backend rejects image input, surface the provider error in chat.
- If current model lacks `vision` metadata, show a warning but do not block.
- If an image exceeds current composer limits, keep existing client-side reject
  behavior.

Image generation:

- If no image-generation model is available:
  `No image-generation model is available. Select a model with image gen.`
- If generation succeeds but persistence fails, show the persistence error and
  do not append a broken image link.
- If the provider returns a remote URL, download and persist it before rendering
  when possible; otherwise render the external URL with a warning.

## Tests

Phase 1:

- RPC prompt command includes `images` when supplied.
- RPC prompt command omits `images` for text-only prompts.
- RPC prompt command preserves `streamingBehavior` with images.

Phase 2:

- Model normalization maps `input: ["text", "image"]` to `inputModes`.
- Model normalization maps explicit image-output metadata to `outputModes`.
- Known override detection marks only exact configured image-generation models.
- Model picker renders `vision` and `image gen` badges.
- Composer warning appears for image attachments on non-vision model.

Phase 3:

- `/image` command routes to the image-generation flow.
- Image-generation result is persisted under `/uploads`.
- Message renderer displays the persisted image.
- Error path returns actionable text when no image-generation model exists.

## Implementation order

1. Fix RPC image forwarding.
2. Add regression tests for RPC prompt image payloads.
3. Add `outputModes` to protocol and bridge normalization.
4. Add model picker `image gen` badge.
5. Add composer warning for attached images on non-vision current model.
6. Add `/image` deck command and server image-generation handler.
7. Persist generated images through existing uploads infrastructure.
8. Add rendering tests and runtime verification with CPA models.

## Acceptance criteria

- Image attachments sent from the web composer reach the RPC backend.
- Vision model can answer about an attached image.
- Model picker clearly shows `vision` vs `image gen` capabilities.
- `/image` produces an inline image when an image-generation model is available.
- Generated image remains visible after browser refresh.
- CPA usage functionality is not changed by this feature.
