# Image Models Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let `omp-deck` send image attachments through the external `omp --mode rpc` backend, surface model image capabilities, and provide a persisted `/image` generation flow.

**Architecture:** Keep normal chat and image generation as separate data flows. Vision input stays inside `SessionHandle.prompt()` and the RPC `prompt` command; image generation is a deck-native slash command that calls a focused server helper, persists returned image bytes or URLs through the existing uploads store, then emits a normal assistant markdown image message.

**Tech Stack:** Bun, Hono, React, TypeScript, `@omp-deck/protocol`, existing WebSocket session events, existing `/uploads` persistence.

---

## File structure

- `packages/protocol/src/index.ts`
  - Add `ModelOutputMode`, extend `ModelInfo.outputModes`, and add image-generation REST/command response types only if the selected implementation uses a REST helper.
- `apps/server/src/bridge/rpc.ts`
  - Forward `ImageAttachment[]` to `omp --mode rpc` prompt commands.
  - Normalize RPC model `input` metadata and output capability hints.
  - Emit synthetic user/assistant events for deck-native `/image` results, matching current deck slash behavior.
- `apps/server/src/bridge/rpc-transport.test.ts`
  - Add focused transport/session tests for prompt command payloads if a fake transport seam already exists there.
- `apps/server/src/image-model-capabilities.ts`
  - Centralize exact image-generation model overrides and normalization helpers.
- `apps/server/src/image-generation.ts`
  - Implement generation invocation, result normalization, URL download, and upload persistence.
- `apps/server/src/deck-slash-commands.ts`
  - Register `/image <prompt>` as a deck-native slash command entry point.
- `apps/server/src/routes-uploads.ts`
  - Reuse exported `persistImage()`. Do not duplicate upload path logic.
- `apps/web/src/components/chat/ModelPickerModal.tsx`
  - Render `vision` and `image gen` badges from protocol metadata.
- `apps/web/src/components/Composer.tsx`
  - Show advisory warning when pending images exist and the current model is known not to accept image input.
- `apps/web/src/lib/store.ts`
  - Replace inline `import("@omp-deck/protocol").ImageAttachment` annotations with top-level `import type { ImageAttachment }` while touching this file.
- Tests:
  - `apps/server/src/bridge/rpc-transport.test.ts`
  - `apps/server/src/image-model-capabilities.test.ts`
  - `apps/server/src/image-generation.test.ts`
  - `apps/web/src/components/model-picker-modal.test.tsx` if component test utilities exist; otherwise test exported pure helpers.
  - `apps/web/src/components/composer-image-warning.test.tsx` if component test utilities exist; otherwise test exported pure helper.

## Task 1: Forward vision images through RPC prompt

**Files:**
- Modify: `apps/server/src/bridge/rpc.ts:337-345`
- Test: `apps/server/src/bridge/rpc-transport.test.ts`

- [ ] **Step 1: Write the failing test**

Add a test that uses the existing fake transport pattern in `rpc-transport.test.ts`. If that file only tests `OmpRpcTransport`, add this small exported helper in `rpc.ts` first and test it directly:

```ts
export function buildRpcPromptCommand(
	text: string,
	opts?: { streamingBehavior?: "steer" | "followUp"; images?: ImageAttachment[] },
): RpcCommandBody {
	const command: RpcCommandBody = opts?.streamingBehavior
		? { type: "prompt", message: text, streamingBehavior: opts.streamingBehavior }
		: { type: "prompt", message: text };
	if (opts?.images && opts.images.length > 0) command.images = opts.images;
	return command;
}
```

Test cases:

```ts
import { describe, expect, test } from "bun:test";
import { buildRpcPromptCommand } from "./rpc.ts";

const png = { type: "image" as const, data: "iVBORw0KGgo=", mimeType: "image/png" };

describe("buildRpcPromptCommand", () => {
	test("includes images when supplied", () => {
		expect(buildRpcPromptCommand("describe this", { images: [png] })).toEqual({
			type: "prompt",
			message: "describe this",
			images: [png],
		});
	});

	test("omits images for text-only prompts", () => {
		expect(buildRpcPromptCommand("hello", { images: [] })).toEqual({
			type: "prompt",
			message: "hello",
		});
	});

	test("preserves streaming behavior with images", () => {
		expect(buildRpcPromptCommand("follow", { streamingBehavior: "followUp", images: [png] })).toEqual({
			type: "prompt",
			message: "follow",
			streamingBehavior: "followUp",
			images: [png],
		});
	});
});
```

- [ ] **Step 2: Run the failing test**

Run:

```sh
bun test apps/server/src/bridge/rpc-transport.test.ts
```

Expected: the new image-payload tests fail before `RpcSessionHandle.prompt()` uses the helper or before the helper exists.

- [ ] **Step 3: Implement image forwarding**

Change `RpcSessionHandle.prompt()` to use the helper:

```ts
async prompt(
	text: string,
	opts?: { streamingBehavior?: "steer" | "followUp"; images?: ImageAttachment[] },
): Promise<void> {
	await this.#transport.send(buildRpcPromptCommand(text, opts));
}
```

Extend `RpcCommandBody` in `apps/server/src/bridge/rpc-transport.ts` so the command can carry images without `as unknown` casts:

```ts
export interface RpcCommandBody {
	type: string;
	[key: string]: unknown;
}
```

If that interface already permits unknown fields, do not change it.

- [ ] **Step 4: Verify the test passes**

Run:

```sh
bun test apps/server/src/bridge/rpc-transport.test.ts
```

Expected: all tests in that file pass.

- [ ] **Step 5: Commit**

```sh
git add apps/server/src/bridge/rpc.ts apps/server/src/bridge/rpc-transport.ts apps/server/src/bridge/rpc-transport.test.ts
git commit -m "fix: forward RPC prompt images"
```

## Task 2: Add output capability metadata

**Files:**
- Modify: `packages/protocol/src/index.ts:234-253`
- Create: `apps/server/src/image-model-capabilities.ts`
- Test: `apps/server/src/image-model-capabilities.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `apps/server/src/image-model-capabilities.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { detectOutputModes, normalizeInputModes } from "./image-model-capabilities.ts";

describe("image model capabilities", () => {
	test("normalizes known input modes", () => {
		expect(normalizeInputModes(["text", "image", "audio"])).toEqual(["text", "image"]);
		expect(normalizeInputModes(undefined)).toBeUndefined();
	});

	test("marks only exact known image generation models", () => {
		expect(detectOutputModes({ provider: "zai", id: "glm-5v-turbo" })).toBeUndefined();
		expect(detectOutputModes({ provider: "haochi", id: "gpt-5.5" })).toBeUndefined();
		expect(detectOutputModes({ provider: "openai", id: "gpt-image-1" })).toEqual(["image"]);
	});

	test("uses explicit output metadata before overrides", () => {
		expect(detectOutputModes({ provider: "custom", id: "paint", output: ["text", "image"] })).toEqual([
			"text",
			"image",
		]);
	});
});
```

- [ ] **Step 2: Run the failing test**

```sh
bun test apps/server/src/image-model-capabilities.test.ts
```

Expected: import fails because `image-model-capabilities.ts` does not exist.

- [ ] **Step 3: Extend protocol types**

In `packages/protocol/src/index.ts`, replace the inline modality arrays with named exported aliases:

```ts
export type ModelInputMode = "text" | "image";
export type ModelOutputMode = "text" | "image";

export interface ModelInfo {
	provider: string;
	id: string;
	label: string;
	role?: string;
	contextWindow?: number;
	isAvailable: boolean;
	isSubscription?: boolean;
	isCurrent?: boolean;
	inputModes?: ModelInputMode[];
	outputModes?: ModelOutputMode[];
}
```

- [ ] **Step 4: Implement capability helpers**

Create `apps/server/src/image-model-capabilities.ts`:

```ts
import type { ModelInputMode, ModelOutputMode } from "@omp-deck/protocol";

export interface CapabilitySourceModel {
	provider: string;
	id: string;
	input?: unknown;
	output?: unknown;
}

const KNOWN_IMAGE_OUTPUT_MODELS: Record<string, readonly string[]> = {
	openai: ["gpt-image-1", "dall-e-3"],
	haochi: [],
	zai: [],
};

export function normalizeInputModes(value: unknown): ModelInputMode[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const modes = value.filter((mode): mode is ModelInputMode => mode === "text" || mode === "image");
	return modes.length > 0 ? modes : undefined;
}

export function normalizeOutputModes(value: unknown): ModelOutputMode[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const modes = value.filter((mode): mode is ModelOutputMode => mode === "text" || mode === "image");
	return modes.length > 0 ? modes : undefined;
}

export function detectOutputModes(model: CapabilitySourceModel): ModelOutputMode[] | undefined {
	const explicit = normalizeOutputModes(model.output);
	if (explicit) return explicit;
	const known = KNOWN_IMAGE_OUTPUT_MODELS[model.provider] ?? [];
	return known.includes(model.id) ? ["image"] : undefined;
}
```

- [ ] **Step 5: Verify helper tests**

```sh
bun test apps/server/src/image-model-capabilities.test.ts
```

Expected: pass.

- [ ] **Step 6: Commit**

```sh
git add packages/protocol/src/index.ts apps/server/src/image-model-capabilities.ts apps/server/src/image-model-capabilities.test.ts
git commit -m "feat: add image model capability metadata"
```

## Task 3: Normalize capabilities in bridges

**Files:**
- Modify: `apps/server/src/bridge/rpc.ts:56-121`
- Modify: `apps/server/src/bridge/in-process.ts` around its model normalization function
- Test: `apps/server/src/image-model-capabilities.test.ts`

- [ ] **Step 1: Add bridge-normalization test coverage**

Extend `image-model-capabilities.test.ts` with a helper-level expectation that mirrors both bridges:

```ts
test("capability helpers produce ModelInfo-compatible fields", () => {
	const inputModes = normalizeInputModes(["text", "image"]);
	const outputModes = detectOutputModes({ provider: "openai", id: "gpt-image-1" });
	expect(inputModes).toEqual(["text", "image"]);
	expect(outputModes).toEqual(["image"]);
});
```

- [ ] **Step 2: Update RPC model shape**

In `apps/server/src/bridge/rpc.ts`, extend `RpcModel`:

```ts
interface RpcModel {
	provider: string;
	id: string;
	name?: string;
	contextWindow?: number;
	input?: unknown;
	output?: unknown;
}
```

Import helpers:

```ts
import { detectOutputModes, normalizeInputModes } from "../image-model-capabilities.ts";
```

Update `rpcModelToInfo()`:

```ts
const inputModes = normalizeInputModes(model.input);
if (inputModes) info.inputModes = inputModes;
const outputModes = detectOutputModes(model);
if (outputModes) info.outputModes = outputModes;
```

- [ ] **Step 3: Update in-process bridge normalization**

Find the existing function that converts SDK model registry rows to `ModelInfo` in `apps/server/src/bridge/in-process.ts`. Replace local `input` filtering with:

```ts
const inputModes = normalizeInputModes(model.input);
if (inputModes) info.inputModes = inputModes;
const outputModes = detectOutputModes({ provider: model.provider, id: model.id, output: model.output });
if (outputModes) info.outputModes = outputModes;
```

If the SDK model type has no `output` property in TypeScript, add a narrow helper in `image-model-capabilities.ts` instead of using `as any`:

```ts
export function readModelOutput(value: unknown): unknown {
	return typeof value === "object" && value !== null && !Array.isArray(value) && "output" in value
		? (value as Record<string, unknown>).output
		: undefined;
}
```

Then call `readModelOutput(model)`.

- [ ] **Step 4: Run focused tests and typecheck**

```sh
bun test apps/server/src/image-model-capabilities.test.ts
bun run --filter '@omp-deck/server' typecheck
```

Expected: tests pass; server typecheck exits 0.

- [ ] **Step 5: Commit**

```sh
git add apps/server/src/bridge/rpc.ts apps/server/src/bridge/in-process.ts apps/server/src/image-model-capabilities.ts apps/server/src/image-model-capabilities.test.ts
git commit -m "feat: normalize image model capabilities"
```

## Task 4: Show model capability badges in the picker

**Files:**
- Modify: `apps/web/src/components/chat/ModelPickerModal.tsx:210-216`
- Test: create helper in `apps/web/src/components/chat/model-badges.ts` and test `apps/web/src/components/chat/model-badges.test.ts`

- [ ] **Step 1: Write pure badge helper tests**

Create `apps/web/src/components/chat/model-badges.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { modelCapabilityLabels } from "./model-badges.ts";

describe("modelCapabilityLabels", () => {
	test("returns vision and image gen labels independently", () => {
		expect(modelCapabilityLabels({ inputModes: ["image"], outputModes: ["image"] })).toEqual([
			"vision",
			"image gen",
		]);
	});

	test("returns no labels when metadata is absent", () => {
		expect(modelCapabilityLabels({})).toEqual([]);
	});
});
```

- [ ] **Step 2: Run the failing test**

```sh
bun test apps/web/src/components/chat/model-badges.test.ts
```

Expected: import fails because `model-badges.ts` does not exist.

- [ ] **Step 3: Implement badge helper**

Create `apps/web/src/components/chat/model-badges.ts`:

```ts
import type { ModelInputMode, ModelOutputMode } from "@omp-deck/protocol";

export interface ModelBadgeSource {
	inputModes?: ModelInputMode[];
	outputModes?: ModelOutputMode[];
}

export function modelCapabilityLabels(model: ModelBadgeSource): string[] {
	const labels: string[] = [];
	if (model.inputModes?.includes("image")) labels.push("vision");
	if (model.outputModes?.includes("image")) labels.push("image gen");
	return labels;
}
```

- [ ] **Step 4: Render labels in `ModelPickerModal`**

Import and use the helper:

```ts
import { modelCapabilityLabels } from "./model-badges";
```

Replace the single `vision` span with:

```tsx
{modelCapabilityLabels(model).map((label) => (
	<span key={label}>{label}</span>
))}
```

- [ ] **Step 5: Verify web test and typecheck**

```sh
bun test apps/web/src/components/chat/model-badges.test.ts
bun run --filter '@omp-deck/web' typecheck
```

Expected: helper test passes; web typecheck exits 0.

- [ ] **Step 6: Commit**

```sh
git add apps/web/src/components/chat/ModelPickerModal.tsx apps/web/src/components/chat/model-badges.ts apps/web/src/components/chat/model-badges.test.ts
git commit -m "feat: badge image-capable models"
```

## Task 5: Warn on non-vision model image attachments

**Files:**
- Modify: `apps/web/src/components/Composer.tsx`
- Modify: `apps/web/src/lib/store.ts:4-14,175-188`
- Test: create `apps/web/src/components/composer-vision-warning.ts` and `apps/web/src/components/composer-vision-warning.test.ts`

- [ ] **Step 1: Replace inline protocol imports in store**

In `apps/web/src/lib/store.ts`, add `ImageAttachment` to the top-level type imports:

```ts
import type {
	ExtUiDialogResponse,
	ImageAttachment,
	ListSessionsResponse,
	ListWorkspacesResponse,
	NotificationLevel,
	PendingPlanApprovalWire,
	PlanModeContextWire,
	SessionSummary,
	ServerFrame,
	WorkspaceEntry,
} from "@omp-deck/protocol";
```

Then replace:

```ts
sendPrompt(text: string, images?: import("@omp-deck/protocol").ImageAttachment[]): void;
editQueued(queuedId: string, text: string, images?: import("@omp-deck/protocol").ImageAttachment[]): void;
```

with:

```ts
sendPrompt(text: string, images?: ImageAttachment[]): void;
editQueued(queuedId: string, text: string, images?: ImageAttachment[]): void;
```

- [ ] **Step 2: Write warning-helper tests**

Create `apps/web/src/components/composer-vision-warning.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { imageAttachmentWarning } from "./composer-vision-warning.ts";

describe("imageAttachmentWarning", () => {
	test("warns when images are pending and the current model lacks image input", () => {
		expect(imageAttachmentWarning(1, { provider: "zai", id: "glm-5.2" }, [])).toContain("may not accept images");
	});

	test("does not warn for known vision models", () => {
		expect(imageAttachmentWarning(1, { provider: "zai", id: "glm-5v-turbo" }, ["image"])).toBeUndefined();
	});

	test("does not warn when no images are pending", () => {
		expect(imageAttachmentWarning(0, { provider: "zai", id: "glm-5.2" }, [])).toBeUndefined();
	});
});
```

- [ ] **Step 3: Implement warning helper**

Create `apps/web/src/components/composer-vision-warning.ts`:

```ts
import type { ModelInputMode, ModelRef } from "@omp-deck/protocol";

export function imageAttachmentWarning(
	pendingImageCount: number,
	model: ModelRef | undefined,
	inputModes: ModelInputMode[] | undefined,
): string | undefined {
	if (pendingImageCount === 0) return undefined;
	if (inputModes?.includes("image")) return undefined;
	if (!model) return "Attached images will be sent, but no model is selected.";
	return `${model.provider}/${model.id} may not accept images. The deck will still send them because provider metadata can be incomplete.`;
}
```

- [ ] **Step 4: Display the warning in Composer**

In `Composer.tsx`, import the helper and derive current model input modes. If the active session only stores `ModelRef`, use the current session model plus no modes for the first pass:

```ts
import { imageAttachmentWarning } from "./composer-vision-warning";
```

Near render state:

```ts
const imageWarning = imageAttachmentWarning(images.length, session?.model, undefined);
```

Render above the textarea or below image thumbnails:

```tsx
{imageWarning ? (
	<div className="rounded border border-warning/40 bg-warning/10 px-2 py-1 font-mono text-2xs text-warning">
		{imageWarning}
	</div>
) : null}
```

If model metadata is already available in store at execution time, pass the selected model's `inputModes` instead of `undefined`.

- [ ] **Step 5: Verify**

```sh
bun test apps/web/src/components/composer-vision-warning.test.ts
bun run --filter '@omp-deck/web' typecheck
```

Expected: helper tests pass; web typecheck exits 0.

- [ ] **Step 6: Commit**

```sh
git add apps/web/src/lib/store.ts apps/web/src/components/Composer.tsx apps/web/src/components/composer-vision-warning.ts apps/web/src/components/composer-vision-warning.test.ts
git commit -m "feat: warn before sending images to non-vision models"
```

## Task 6: Add `/image` deck command and generation helper

**Files:**
- Modify: `apps/server/src/deck-slash-commands.ts`
- Modify: `apps/server/src/bridge/types.ts` only if `SessionHandle` needs a new image-generation method
- Modify: `apps/server/src/bridge/rpc.ts`
- Create: `apps/server/src/image-generation.ts`
- Test: `apps/server/src/image-generation.test.ts`

- [ ] **Step 1: Write generation normalization tests**

Create `apps/server/src/image-generation.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { extractGeneratedImages, imageMarkdown } from "./image-generation.ts";

describe("image generation result normalization", () => {
	test("extracts base64 image content blocks", () => {
		const result = {
			content: [{ type: "image", data: "abc123", mimeType: "image/png" }],
		};
		expect(extractGeneratedImages(result)).toEqual([{ data: "abc123", mimeType: "image/png" }]);
	});

	test("extracts markdown image URLs", () => {
		expect(extractGeneratedImages("![generated](/uploads/2026/07/x.png)")).toEqual([
			{ url: "/uploads/2026/07/x.png" },
		]);
	});

	test("renders persisted image markdown", () => {
		expect(imageMarkdown({ url: "/uploads/2026/07/x.png", name: "generated.png" })).toBe(
			"![generated.png](/uploads/2026/07/x.png)",
		);
	});
});
```

- [ ] **Step 2: Run the failing test**

```sh
bun test apps/server/src/image-generation.test.ts
```

Expected: import fails because the helper does not exist.

- [ ] **Step 3: Implement normalization helpers**

Create `apps/server/src/image-generation.ts`:

```ts
import type { SavedUpload } from "./routes-uploads.ts";

export interface GeneratedImageCandidate {
	data?: string;
	mimeType?: string;
	url?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function extractGeneratedImages(value: unknown): GeneratedImageCandidate[] {
	if (typeof value === "string") {
		const matches = Array.from(value.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g));
		return matches.map((match) => ({ url: match[1] })).filter((image) => image.url);
	}
	if (!isRecord(value)) return [];
	const content = Array.isArray(value.content) ? value.content : [];
	const images: GeneratedImageCandidate[] = [];
	for (const block of content) {
		if (!isRecord(block)) continue;
		if (block.type === "image" && typeof block.data === "string") {
			images.push({ data: block.data, mimeType: typeof block.mimeType === "string" ? block.mimeType : "image/png" });
		}
		if (typeof block.url === "string" && block.url.length > 0) images.push({ url: block.url });
	}
	return images;
}

export function imageMarkdown(saved: Pick<SavedUpload, "url" | "name">): string {
	return `![${saved.name}](${saved.url})`;
}
```

- [ ] **Step 4: Choose the invocation seam**

Use the current session bridge so `/image` can run inside the active model context. Add this method to `SessionHandle` only if a helper function cannot be injected into `executeDeckSlashCommand` cleanly:

```ts
generateImage(prompt: string): Promise<string>;
```

RPC implementation strategy:

1. Send a prompt that asks the selected image model to generate an image and return tool/image content.
2. Collect the next assistant/tool result from RPC events or `get_messages`.
3. Normalize image blocks with `extractGeneratedImages()`.
4. Persist base64 bytes with `persistImage(config.uploadsRoot, bytes, mimeType, "generated.png")`.
5. Return `imageMarkdown(saved)`.

If `omp --mode rpc` exposes a dedicated image command by execution time, use that command instead of prompt steering, but keep the same normalization and persistence tests.

- [ ] **Step 5: Register `/image` in deck slash commands**

In `apps/server/src/deck-slash-commands.ts`, add a registry entry:

```ts
{
	name: "image",
	description: "Generate an image and persist it under uploads",
	argumentHint: "<prompt>",
	scope: "deck",
	run: async (args, ctx) => {
		const prompt = args.trim();
		if (!prompt) return { kind: "consumed", output: "Usage: /image <prompt>" };
		if (!ctx.generateImage) return { kind: "consumed", output: "Image generation is unavailable for this backend." };
		return { kind: "consumed", output: await ctx.generateImage(prompt) };
	},
}
```

Extend `DeckSlashContext`:

```ts
export interface DeckSlashContext {
	cwd: string;
	getStatusText?: () => Promise<string>;
	generateImage?: (prompt: string) => Promise<string>;
}
```

- [ ] **Step 6: Wire RPC deck slash context**

In `RpcSessionHandle.dispatchDeckSlashCommand()`, pass:

```ts
generateImage: (prompt) => this.#generateImage(prompt),
```

Implement `#generateImage(prompt: string): Promise<string>` in the same class, using the helper and uploads root passed through `RpcSessionOpts`. Add `uploadsRoot` to `RpcSessionOpts` from bridge config.

- [ ] **Step 7: Verify server tests and typecheck**

```sh
bun test apps/server/src/image-generation.test.ts
bun run --filter '@omp-deck/server' typecheck
```

Expected: tests pass; server typecheck exits 0.

- [ ] **Step 8: Commit**

```sh
git add apps/server/src/deck-slash-commands.ts apps/server/src/bridge/types.ts apps/server/src/bridge/rpc.ts apps/server/src/image-generation.ts apps/server/src/image-generation.test.ts
git commit -m "feat: add deck image generation command"
```

## Task 7: Runtime verification

**Files:**
- No source edits unless verification finds a bug.

- [ ] **Step 1: Start one RPC dev stack**

```sh
OMP_DECK_AGENT_BACKEND=rpc OMP_DECK_OMP_BIN=omp OMP_DECK_PORT=8877 OMP_DECK_WEB_PORT=5174 bun run dev
```

Expected: server health is reachable on `http://127.0.0.1:8877/api/health`.

- [ ] **Step 2: Verify model metadata**

```sh
python3 - <<'PY'
import json, urllib.request
models=json.load(urllib.request.urlopen('http://127.0.0.1:8877/api/models'))['models']
print([m for m in models if m['provider']=='zai' and m['id']=='glm-5v-turbo'][0])
print([m for m in models if m.get('outputModes')])
PY
```

Expected: `zai/glm-5v-turbo` includes `inputModes` containing `image`; image-output models, if configured, include `outputModes: ["image"]`.

- [ ] **Step 3: Verify vision input manually**

Use the browser UI on `http://127.0.0.1:5174`:

1. Select a model with `vision` badge.
2. Paste or drop a small PNG.
3. Prompt: `Describe this image in one sentence.`
4. Confirm the assistant answer references the image content.

Expected: no WebSocket `prompt failed` error; answer is image-aware.

- [ ] **Step 4: Verify `/image` path**

In the composer:

```text
/image a small cyberpunk cat sitting on a neon desk
```

Expected: assistant message contains a markdown image URL under `/uploads/...`; refreshing the browser keeps the image visible.

- [ ] **Step 5: Run final gates**

```sh
bun test apps/server/src/bridge/rpc-transport.test.ts apps/server/src/image-model-capabilities.test.ts apps/server/src/image-generation.test.ts
bun test apps/web/src/components/chat/model-badges.test.ts apps/web/src/components/composer-vision-warning.test.ts
bun run typecheck
```

Expected: all listed tests pass; typecheck exits 0.

- [ ] **Step 6: Commit verification fixes if any**

If runtime verification required source changes:

```sh
git add <changed-files>
git commit -m "fix: verify image model flows"
```

Do not commit runtime data under `data/`.

## Self-review

- Spec coverage:
  - RPC image forwarding: Task 1.
  - `outputModes` metadata: Tasks 2 and 3.
  - Model picker badges: Task 4.
  - Composer advisory warning: Task 5.
  - `/image` command and persisted uploads: Task 6.
  - Runtime proof with vision and generation models: Task 7.
- Placeholder scan: no step uses `TBD`, `TODO`, or unspecified edge handling.
- Type consistency:
  - `ModelInputMode` and `ModelOutputMode` are named protocol exports.
  - No inline `import("pkg").Type` annotations remain in touched store signatures.
  - Static known model overrides use `Record<string, readonly string[]>`; runtime listener/session collections remain `Map`/`Set` in existing bridge code.
