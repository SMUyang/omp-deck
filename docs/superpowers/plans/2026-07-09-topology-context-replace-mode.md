# Topology Context Replace Mode

> **For agentic workers:** Execute with TDD. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Make the `topology-context` extension replace old context with topology focus + recent turns, instead of appending focus on top of all old messages.

**Architecture:** Add `replaceTopologyContext()` alongside existing `appendTopologyContextMessage()`. Keep the same `pi.on("context")` hook — only the return changes. `KEEP_RECENT_TURNS` env (default 3) controls how many recent user→assistant turns are preserved after the focus message.

**Tech Stack:** TypeScript, Bun test, OMP Extension API

**Files:**
- Modify: `starter-extensions/topology-context/index.ts`
- Modify: `starter-extensions/topology-context/index.test.ts`

---

### Task 1: Add `replaceTopologyContext` and update hook

**Files:**
- Modify: `starter-extensions/topology-context/index.ts`

- [ ] **Step 1: Write failing test for `replaceTopologyContext`**

Add to `starter-extensions/topology-context/index.test.ts`:

```typescript
// Add to imports:
import {
	// ...existing imports...
	replaceTopologyContext,
} from "./index.ts";

// Add tool helper after existing user/assistant helpers:
const tool = (text: string) => ({ role: "tool" as const, content: [{ type: "text" as const, text }] });

test("replaceTopologyContext keeps last N user turns and replaces earlier messages", () => {
	const msgs = [
		user("old 1"), assistant("old reply 1"),
		user("old 2"), assistant("old reply 2"),
		user("recent 1"), assistant("recent reply 1"),
		tool("tool result"),
		user("recent 2"), assistant("recent reply 2"),
	];
	const result = replaceTopologyContext(msgs, "focus text", 3);
	expect(result[0]).toMatchObject({ role: "custom", customType: "deck-session-topology-context", content: "focus text" });
	expect(result[1]).toMatchObject({ role: "user" });
	expect(result[1]).toHaveProperty("content", [{ type: "text", text: "old 2" }]);
	expect(result[2]).toMatchObject({ role: "assistant" });
	expect(result[3]).toMatchObject({ role: "user" });
	expect(result[3]).toHaveProperty("content", [{ type: "text", text: "recent 1" }]);
	expect(result[4]).toMatchObject({ role: "assistant" });
	expect(result[5]).toMatchObject({ role: "tool" });
	expect(result[6]).toMatchObject({ role: "user" });
	expect(result[6]).toHaveProperty("content", [{ type: "text", text: "recent 2" }]);
	expect(result[7]).toMatchObject({ role: "assistant" });
	expect(result).toHaveLength(8);
});

test("replaceTopologyContext keeps only N recent user turns", () => {
	const msgs = [
		user("q1"), assistant("a1"),
		user("q2"), assistant("a2"),
		user("q3"), assistant("a3"),
		user("q4"), assistant("a4"),
	];
	const result = replaceTopologyContext(msgs, "focus", 2);
	expect(result).toHaveLength(5);
	expect(result[0]).toMatchObject({ role: "custom" });
	expect(result[1]).toHaveProperty("content", [{ type: "text", text: "q3" }]);
});

test("replaceTopologyContext returns only focus when no messages", () => {
	const result = replaceTopologyContext([], "focus", 3);
	expect(result).toHaveLength(1);
	expect(result[0]).toMatchObject({ role: "custom", content: "focus" });
});

test("replaceTopologyContext does not mutate input", () => {
	const original = [user("hello")];
	const frozen = [...original];
	replaceTopologyContext(original, "focus", 3);
	expect(original).toEqual(frozen);
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd starter-extensions/topology-context && bun test index.test.ts --test-name-pattern replaceTopologyContext
```
Expected: FAIL — `replaceTopologyContext is not exported`

- [ ] **Step 3: Implement function and update hook**

In `index.ts`, add after `appendTopologyContextMessage`:

```typescript
export function replaceTopologyContext<T>(messages: readonly T[], focus: string, keepRecentUserTurns: number): Array<T | TopologyContextMessage> {
	const kept: T[] = [];
	let userCount = 0;
	for (let i = messages.length - 1; i >= 0; i--) {
		kept.unshift(messages[i]!);
		const role = (messages[i] as Record<string, unknown>).role;
		if (role === "user") {
			userCount++;
			if (userCount >= keepRecentUserTurns) break;
		}
	}
	return [
		{
			role: "custom",
			customType: CUSTOM_TYPE,
			content: focus,
			display: false,
			attribution: "agent",
			timestamp: Date.now(),
		},
		...kept,
	];
}
```

In the `default export` function, change line 140:
```typescript
// Before:
return { messages: appendTopologyContextMessage(event.messages, bounded) };

// After:
const keepTurns = readBoundedEnvInt("OMP_DECK_TOPOLOGY_CONTEXT_KEEP_TURNS", 3, 1, 20);
return { messages: replaceTopologyContext(event.messages, bounded, keepTurns) };
```

- [ ] **Step 4: Run all extension tests**

```bash
bun test starter-extensions/topology-context/index.test.ts
```
Expected: PASS (all existing + new tests green)

---

### Task 2: Add `KEEP_TURNS` env to deck env schema

**Files:**
- Modify: `apps/server/src/env-schema.ts`

- [ ] **Step 1: Add env entry**

After the `OMP_DECK_TOPOLOGY_CONTEXT_MAX_FOCUS_CHARS` entry, add:

```typescript
{
	key: "OMP_DECK_TOPOLOGY_CONTEXT_KEEP_TURNS",
	defaultValue: "3",
	valueType: "int",
	sensitive: false,
	restartRequired: false,
	hotApply: true,
	description: "Number of recent user turns to preserve after topology context injection. Older messages are replaced by the topology focus.",
},
```

- [ ] **Step 2: Typecheck server**

```bash
bun run --filter '@omp-deck/server' typecheck
```
Expected: exits 0
