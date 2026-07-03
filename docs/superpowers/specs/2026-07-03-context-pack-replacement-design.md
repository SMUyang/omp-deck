# Session Context Pack Replacement Design

## Goal

Replace verbose old transcript with compact context packs to reduce token usage. When context exceeds threshold, old conversation history is replaced by a structured pack summary, keeping only recent turns.
- **Auto**: when session context usage exceeds 15% of context window
## Architecture

### Trigger
- **Auto**: when session context usage exceeds 50% of context window
- **Manual**: user clicks button in Chat UI
- **Settings toggle**: can disable auto-replacement

### Mechanism

#### In-process bridge
Use SDK `context` extension event (`transformContext`) to modify the message array before LLM dispatch:
1. Check context usage via `getContextUsage()`
2. If over threshold, retrieve `getStoredSessionContextPack({sessionId, query, budget})`
3. Replace old messages with rendered pack text + keep last 5 turns
4. Return modified message array

#### RPC bridge
RPC has no `transformContext` hook. Use `compact` command:
1. Check context usage
2. If over threshold, call `session.compact(packText)` to replace old transcript
3. Then send user prompt normally

If `compact` doesn't accept custom content, gate RPC with "auto-replacement not supported" fallback for now.

### Pack Rendering for Replacement
New function `renderPackAsContextReplacement(pack)`:
```
## Session Context Summary
### Goals: [goal nodes]
### Constraints: [constraint nodes]  
### Key Decisions: [decision nodes]
### Artifacts Modified: [artifact nodes]
### Verified Facts: [evidence nodes]
```

- Default: 15% of context window
- Configurable via Settings

### Recent Messages Retention
- Keep last 5 turns (10 messages) of original conversation
- Everything older gets replaced by pack

### Settings UI
- Toggle: "Enable auto context replacement"
- Slider/input: "Trigger threshold (% of context window)"
- Default on, 50%

## Scope

### In scope
- `renderPackAsContextReplacement()` in session-context.ts
- In-process: `context` extension event handler in bridge
- RPC: `compact` integration in RpcSessionHandle.prompt()
- Auto-trigger check in prompt path
- Manual trigger button in Chat UI
- Settings toggle + threshold config
- TDD for all above

### Out of scope
- LLM-generated summaries (deterministic pack only)
- System prompt modification
- RPC protocol extension
- OMP SDK internal changes
