# Post-0.7 Roadmap Plan

**Scope:** This plan captures the next requested work after the CPA usage Status panel release. It is planning only; no implementation is included in the 0.7.0 release commit.

## Ordered backlog

### 1. Subagent invocation visibility

Goal: make subagent work observable at session start and during execution.

Requirements to design:
- Inject a concise guide at session start describing when to use subagents and which tasks fit them.
- Surface subagent identity in the conversation: task id, role, and purpose.
- Show runtime/duration for each subagent call.
- Avoid transcript noise: compact display by default, expanded details on demand.

Open design questions:
- Should this be a deck UI-only enhancement, an OMP prompt/session-start injection, or both?
- Should durations come from deck task orchestration, Pi subagent metadata, or parsed transcript events?

### 2. Session-level topology memory and automatic compact

Goal: reduce token use by converting repeated conversation/subagent context into session-level topology memory nodes.

Requirements to design:
- Keep OMP compatible with upstream official updates by packaging the feature as plugin-like extension logic where possible.
- Add session-local topology memory nodes that summarize conversation state and subagent outputs.
- Trigger summarization automatically by either:
  - every 3 subagent conversations, or
  - context usage threshold, starting at 10%.
- Integrate with automatic compact so compacted context can reference topology nodes instead of replaying full text.
- Keep durable memory mutation in OMP/Mnemopi flows; deck should orchestrate and display, not silently mutate global memory without a clear path.

Open design questions:
- Should session topology memory live in JSONL sidecar, Mnemopi working memory, or deck DB?
- What exact node/edge schema should represent session, subagent, task, decision, artifact, and compact event?

### 3. Workspace creation and session deletion

Goal: make deck able to create workspaces and delete sessions from the UI.

Requirements to design:
- Workspace creation from the UI with path validation and clear error messages.
- Session deletion/dispose UX with confirmation.
- Distinguish active-session disposal from historical-session deletion.
- Preserve safety: no destructive filesystem deletion unless explicitly requested and confirmed.

Open design questions:
- Is a workspace just a registered path, or should deck scaffold directories/repos?
- Should deleted session JSONL files move to trash/archive or be permanently deleted?

### 4. Image rendering bug diagnosis

Goal: fix cases where the UI says it read an image but does not render the image.

Requirements to diagnose:
- Reproduce with a session/tool result that currently shows "read image" but no visible image.
- Determine whether the payload is base64, blob reference, upload URL, or local file reference.
- Decide whether to fix at data conversion, upload serving, or `ImagePreviewGrid` source normalization.
- Preserve the lightbox behavior added in `9af0adf`.

Open design questions:
- Are blob references like `blob:sha256:...` resolvable through OMP artifact storage or deck uploads?
- Should the server translate blob references to `/uploads` URLs before they reach React?

### 5. Versioning and release hygiene

Goal: keep release metadata aligned with shipped functionality.

Requirements:
- Version bump to 0.7.0 for the CPA usage release.
- Future feature releases should update root package, workspace packages, lockfile, README status, Chinese guide, and changelog.
- Deployment verification must include `/api/health` buildSha and feature-specific endpoint smoke.

## Recommended execution order

1. Diagnose image rendering bug first if it is user-visible in current daily use.
2. Then design subagent invocation visibility because it improves observability for all later work.
3. Then design session topology memory/auto compact; this is architectural and should not be mixed with UI fixes.
4. Then workspace creation/session deletion.

## Current 0.7.0 release contents

- CPA actual request usage endpoint: `/api/status/cpa-usage`.
- Status panel section: `CPA usage` with `CLIProxyAPI request usage, not remaining quota.`
- External collector source: `https://api.hyanapi.xyz/collector` via server-side Basic Auth env.
- Existing image lightbox feature from `9af0adf` remains included.
