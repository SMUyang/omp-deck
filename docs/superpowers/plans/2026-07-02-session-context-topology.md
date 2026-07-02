# Session Context Topology Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a deck-owned session context graph and compact context-pack API so long session transcripts can be replaced by bounded, query-scoped context data.

**Architecture:** Add protocol types, deck SQLite tables, a deterministic JSONL extractor, a context store/service, session-scoped REST routes, web API methods, and a minimal debug panel. The first slice is rebuild-first and source-referenced; live incremental updates and automatic prompt replacement stay deferred.

**Tech Stack:** Bun, TypeScript, Hono, Bun SQLite, React, existing `@omp-deck/protocol` package, existing deck DB migration pattern.

---

## Scope

Implement the approved spec:

- `docs/superpowers/specs/2026-07-02-session-context-topology-design.md`

First slice deliverables:

- Deck DB tables: `session_context_nodes`, `session_context_edges`, `session_context_artifacts`, `session_context_checkpoints`.
- Protocol types for context nodes, edges, graph, rebuild response, and context pack.
- JSONL extractor that produces deterministic nodes/edges from session files.
- Store/service that rebuilds and retrieves context packs.
- Routes:
  - `POST /api/sessions/:id/context/rebuild`
  - `GET /api/sessions/:id/context-pack?q=&budget=`
  - `GET /api/sessions/:id/context-graph?limit=`
- Web API client methods.
- Minimal current-session debug panel showing context pack sections and raw refs.

Non-deliverables in this plan:

- No Mnemopi writes.
- No graph visualization library.
- No automatic replacement of the live model prompt.
- No embedding-based retrieval.

## File structure

Create:

- `apps/server/src/db/migrations/005-session-context.sql`
  - Defines context tables and indexes.
- `apps/server/src/db/session-context.ts`
  - Low-level CRUD for context rows using `getDb()`, `id()`, `nowIso()`.
- `apps/server/src/db/session-context.test.ts`
  - DB migration/store tests with temp DB.
- `apps/server/src/session-context.ts`
  - JSONL parsing, extraction, ranking, pack rendering, rebuild orchestration.
- `apps/server/src/session-context.test.ts`
  - Pure service/extractor tests with synthetic JSONL.
- `apps/server/src/routes-session-context.ts`
  - Hono routes for rebuild, pack, graph.
- `apps/server/src/routes-session-context.test.ts`
  - Route tests for active-session 404, rebuild success, pack success, and limit parsing using a stub bridge.
- `apps/web/src/components/session/ContextPackPanel.tsx`
  - Minimal debug panel for current session context pack.

Modify:

- `packages/protocol/src/index.ts`
  - Add Session Context protocol section near Memory Cockpit types.
- `apps/server/src/routes.ts`
  - Import and mount `buildSessionContextRouter(bridge)`.
- `apps/web/src/lib/api.ts`
  - Add typed methods for rebuild, pack, graph.
- `apps/web/src/components/Chat.tsx`
  - Import `ContextPackPanel` and render it at the bottom of the chat scroll area for the active session.
- `apps/web/src/i18n/index.ts`
  - Add `sessionContext.*` strings in `en` and `zh-CN`; the panel uses these visible labels.

---

## Task 1: Protocol types

**Files:**

- Modify: `packages/protocol/src/index.ts`

- [ ] **Step 1: Add failing type-consumer test by compiling a tiny usage site**

Create a temporary local snippet only during this step or add type usage in the server test in Task 2. The expected initial failure is missing exports:

```ts
import type {
  SessionContextPackResponse,
  SessionContextGraphResponse,
  SessionContextRebuildResponse,
} from "@omp-deck/protocol";
```

Run:

```sh
bun run --filter '@omp-deck/server' typecheck
```

Expected: FAIL with missing exported members once Task 2 imports them.

- [ ] **Step 2: Add protocol types**

In `packages/protocol/src/index.ts`, insert a new section before `// Memory Cockpit` or directly before it:

```ts
// ─────────────────────────────────────────────────────────────────────────────
// Session Context Topology (deck-owned context replacement layer)
// ─────────────────────────────────────────────────────────────────────────────

export type SessionContextNodeKind =
	| "goal"
	| "user_intent"
	| "constraint"
	| "decision"
	| "action"
	| "artifact"
	| "issue"
	| "resolution"
	| "evidence"
	| "todo_state"
	| "handoff_summary";

export type SessionContextEdgeRelation =
	| "caused_by"
	| "fixed_by"
	| "verified_by"
	| "depends_on"
	| "supersedes"
	| "references_file"
	| "continues"
	| "contradicts"
	| "blocks"
	| "summarizes";

export interface SessionContextNode {
	id: string;
	sessionId: string;
	kind: SessionContextNodeKind;
	title: string;
	body: string;
	compressedBody: string;
	importance: number;
	createdAt: string;
	sourceMessageId?: string;
	sourceTurnIndex?: number;
	metadata: Record<string, unknown>;
}

export interface SessionContextEdge {
	id: string;
	sessionId: string;
	sourceNodeId: string;
	targetNodeId: string;
	relation: SessionContextEdgeRelation;
	weight: number;
	evidenceMessageId?: string;
	metadata: Record<string, unknown>;
}

export type SessionContextArtifactKind = "file" | "commit" | "url" | "test" | "command" | "api" | "log" | "image" | "other";

export interface SessionContextArtifact {
	id: string;
	sessionId: string;
	nodeId?: string;
	kind: SessionContextArtifactKind;
	ref: string;
	label: string;
	metadata: Record<string, unknown>;
}

export interface SessionContextRawRef {
	messageId?: string;
	turnIndex?: number;
	artifactId?: string;
	label: string;
}

export interface SessionContextRebuildResponse {
	sessionId: string;
	nodeCount: number;
	edgeCount: number;
	sourcePath: string;
	rebuiltAt: string;
}

export interface SessionContextPackResponse {
	sessionId: string;
	query: string;
	budget: number;
	summary: string;
	goals: SessionContextNode[];
	constraints: SessionContextNode[];
	decisions: SessionContextNode[];
	issues: SessionContextNode[];
	resolutions: SessionContextNode[];
	artifacts: SessionContextArtifact[];
	evidence: SessionContextNode[];
	openTodos: SessionContextNode[];
	rawRefs: SessionContextRawRef[];
	omitted: {
		nodeCount: number;
		edgeCount: number;
		reason: string;
	};
}

export interface SessionContextGraphResponse {
	sessionId: string;
	nodes: SessionContextNode[];
	edges: SessionContextEdge[];
	artifacts: SessionContextArtifact[];
	totalNodes: number;
	truncated: boolean;
}
```

- [ ] **Step 3: Typecheck protocol consumers**

Run:

```sh
bun run --filter '@omp-deck/server' typecheck
```
Expected: PASS.

- [ ] **Step 4: Commit**

```sh
git add packages/protocol/src/index.ts
git commit -m "Add session context protocol types"
```

---

## Task 2: DB migration and store

**Files:**

- Create: `apps/server/src/db/migrations/005-session-context.sql`
- Create: `apps/server/src/db/session-context.ts`
- Create: `apps/server/src/db/session-context.test.ts`

- [ ] **Step 1: Write failing DB store tests**

Create `apps/server/src/db/session-context.test.ts`:

```ts
import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { SessionContextNode } from "@omp-deck/protocol";
import { closeDb, openDb } from "./index.ts";
import {
	getSessionContextGraph,
	replaceSessionContext,
	upsertSessionContextCheckpoint,
} from "./session-context.ts";

const tempDirs: string[] = [];

function openTempDeckDb(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "session-context-db-"));
	tempDirs.push(dir);
	const dbPath = path.join(dir, "deck.db");
	openDb({ path: dbPath });
	return dbPath;
}

afterEach(() => {
	closeDb();
	for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function node(id: string, kind: SessionContextNode["kind"], title: string): SessionContextNode {
	return {
		id,
		sessionId: "s1",
		kind,
		title,
		body: title,
		compressedBody: title,
		importance: 0.7,
		createdAt: "2026-07-02T00:00:00.000Z",
		metadata: { source: "test" },
	};
}

describe("session context store", () => {
	test("replaces nodes edges and artifacts for a session", () => {
		openTempDeckDb();

		replaceSessionContext({
			sessionId: "s1",
			nodes: [node("n1", "goal", "build context pack"), node("n2", "evidence", "tests pass")],
			edges: [{
				id: "e1",
				sessionId: "s1",
				sourceNodeId: "n1",
				targetNodeId: "n2",
				relation: "verified_by",
				weight: 1,
				metadata: {},
			}],
			artifacts: [{
				id: "a1",
				sessionId: "s1",
				nodeId: "n2",
				kind: "test",
				ref: "bun test apps/server/src/session-context.test.ts",
				label: "session context tests",
				metadata: {},
			}],
		});

		let graph = getSessionContextGraph("s1", 50);
		expect(graph.nodes.map((n) => n.id)).toEqual(["n1", "n2"]);
		expect(graph.edges).toHaveLength(1);
		expect(graph.artifacts).toHaveLength(1);

		replaceSessionContext({ sessionId: "s1", nodes: [node("n3", "issue", "old graph removed")], edges: [], artifacts: [] });
		graph = getSessionContextGraph("s1", 50);
		expect(graph.nodes.map((n) => n.id)).toEqual(["n3"]);
		expect(graph.edges).toHaveLength(0);
		expect(graph.artifacts).toHaveLength(0);
	});

	test("records rebuild checkpoint metadata", () => {
		openTempDeckDb();

		upsertSessionContextCheckpoint({
			sessionId: "s1",
			sourcePath: "/tmp/session.jsonl",
			sourceMtimeMs: 123,
			sourceSizeBytes: 456,
			nodeCount: 2,
			edgeCount: 1,
			rebuiltAt: "2026-07-02T00:00:00.000Z",
		});

		const graph = getSessionContextGraph("s1", 50);
		expect(graph.totalNodes).toBe(0);
	});
});
```

Run:

```sh
bun test apps/server/src/db/session-context.test.ts
```

Expected: FAIL because migration/store file does not exist.

- [ ] **Step 2: Add migration**

Create `apps/server/src/db/migrations/005-session-context.sql`:

```sql
-- 005-session-context.sql
-- Deck-owned derived session context graph. This stores compressed, source-
-- referenced context for a session so future continuations can retrieve a
-- compact context pack instead of replaying raw transcript.

CREATE TABLE IF NOT EXISTS session_context_nodes (
    id                  TEXT PRIMARY KEY,
    session_id          TEXT NOT NULL,
    kind                TEXT NOT NULL CHECK (kind IN (
        'goal','user_intent','constraint','decision','action','artifact',
        'issue','resolution','evidence','todo_state','handoff_summary'
    )),
    title               TEXT NOT NULL,
    body                TEXT NOT NULL,
    compressed_body     TEXT NOT NULL,
    source_message_id   TEXT,
    source_turn_index   INTEGER,
    importance          REAL NOT NULL DEFAULT 0.5,
    created_at          TEXT NOT NULL,
    metadata_json       TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_session_context_nodes_session_kind
    ON session_context_nodes(session_id, kind, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_session_context_nodes_source
    ON session_context_nodes(session_id, source_message_id);

CREATE TABLE IF NOT EXISTS session_context_edges (
    id                  TEXT PRIMARY KEY,
    session_id          TEXT NOT NULL,
    source_node_id      TEXT NOT NULL,
    target_node_id      TEXT NOT NULL,
    relation            TEXT NOT NULL CHECK (relation IN (
        'caused_by','fixed_by','verified_by','depends_on','supersedes',
        'references_file','continues','contradicts','blocks','summarizes'
    )),
    weight              REAL NOT NULL DEFAULT 1.0,
    evidence_message_id TEXT,
    metadata_json       TEXT NOT NULL DEFAULT '{}',
    FOREIGN KEY(source_node_id) REFERENCES session_context_nodes(id) ON DELETE CASCADE,
    FOREIGN KEY(target_node_id) REFERENCES session_context_nodes(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_session_context_edges_session
    ON session_context_edges(session_id, relation);
CREATE INDEX IF NOT EXISTS idx_session_context_edges_source
    ON session_context_edges(source_node_id);
CREATE INDEX IF NOT EXISTS idx_session_context_edges_target
    ON session_context_edges(target_node_id);

CREATE TABLE IF NOT EXISTS session_context_artifacts (
    id              TEXT PRIMARY KEY,
    session_id      TEXT NOT NULL,
    node_id         TEXT,
    kind            TEXT NOT NULL CHECK (kind IN ('file','commit','url','test','command','api','log','image','other')),
    ref             TEXT NOT NULL,
    label           TEXT NOT NULL,
    metadata_json   TEXT NOT NULL DEFAULT '{}',
    FOREIGN KEY(node_id) REFERENCES session_context_nodes(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_session_context_artifacts_session
    ON session_context_artifacts(session_id, kind);
CREATE INDEX IF NOT EXISTS idx_session_context_artifacts_node
    ON session_context_artifacts(node_id);

CREATE TABLE IF NOT EXISTS session_context_checkpoints (
    session_id          TEXT PRIMARY KEY,
    source_path         TEXT NOT NULL,
    source_mtime_ms     INTEGER NOT NULL,
    source_size_bytes   INTEGER NOT NULL,
    node_count          INTEGER NOT NULL,
    edge_count          INTEGER NOT NULL,
    rebuilt_at          TEXT NOT NULL
);
```

- [ ] **Step 3: Implement DB store**

Create `apps/server/src/db/session-context.ts`:

```ts
import type {
	SessionContextArtifact,
	SessionContextEdge,
	SessionContextGraphResponse,
	SessionContextNode,
} from "@omp-deck/protocol";

import { getDb } from "./index.ts";

interface NodeRow {
	id: string;
	session_id: string;
	kind: SessionContextNode["kind"];
	title: string;
	body: string;
	compressed_body: string;
	source_message_id: string | null;
	source_turn_index: number | null;
	importance: number;
	created_at: string;
	metadata_json: string;
}

interface EdgeRow {
	id: string;
	session_id: string;
	source_node_id: string;
	target_node_id: string;
	relation: SessionContextEdge["relation"];
	weight: number;
	evidence_message_id: string | null;
	metadata_json: string;
}

interface ArtifactRow {
	id: string;
	session_id: string;
	node_id: string | null;
	kind: SessionContextArtifact["kind"];
	ref: string;
	label: string;
	metadata_json: string;
}

export interface ReplaceSessionContextInput {
	sessionId: string;
	nodes: SessionContextNode[];
	edges: SessionContextEdge[];
	artifacts: SessionContextArtifact[];
}

export interface SessionContextCheckpointInput {
	sessionId: string;
	sourcePath: string;
	sourceMtimeMs: number;
	sourceSizeBytes: number;
	nodeCount: number;
	edgeCount: number;
	rebuiltAt: string;
}

function parseMetadata(value: string): Record<string, unknown> {
	try {
		const parsed = JSON.parse(value) as unknown;
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
	} catch {
		return {};
	}
}

function nodeFromRow(row: NodeRow): SessionContextNode {
	return {
		id: row.id,
		sessionId: row.session_id,
		kind: row.kind,
		title: row.title,
		body: row.body,
		compressedBody: row.compressed_body,
		importance: row.importance,
		createdAt: row.created_at,
		...(row.source_message_id ? { sourceMessageId: row.source_message_id } : {}),
		...(typeof row.source_turn_index === "number" ? { sourceTurnIndex: row.source_turn_index } : {}),
		metadata: parseMetadata(row.metadata_json),
	};
}

function edgeFromRow(row: EdgeRow): SessionContextEdge {
	return {
		id: row.id,
		sessionId: row.session_id,
		sourceNodeId: row.source_node_id,
		targetNodeId: row.target_node_id,
		relation: row.relation,
		weight: row.weight,
		...(row.evidence_message_id ? { evidenceMessageId: row.evidence_message_id } : {}),
		metadata: parseMetadata(row.metadata_json),
	};
}

function artifactFromRow(row: ArtifactRow): SessionContextArtifact {
	return {
		id: row.id,
		sessionId: row.session_id,
		...(row.node_id ? { nodeId: row.node_id } : {}),
		kind: row.kind,
		ref: row.ref,
		label: row.label,
		metadata: parseMetadata(row.metadata_json),
	};
}

export function replaceSessionContext(input: ReplaceSessionContextInput): void {
	const db = getDb();
	const tx = db.transaction(() => {
		db.run("DELETE FROM session_context_artifacts WHERE session_id = ?", input.sessionId);
		db.run("DELETE FROM session_context_edges WHERE session_id = ?", input.sessionId);
		db.run("DELETE FROM session_context_nodes WHERE session_id = ?", input.sessionId);

		const insertNode = db.prepare(`
			INSERT INTO session_context_nodes (
				id, session_id, kind, title, body, compressed_body,
				source_message_id, source_turn_index, importance, created_at, metadata_json
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`);
		for (const node of input.nodes) {
			insertNode.run(
				node.id,
				node.sessionId,
				node.kind,
				node.title,
				node.body,
				node.compressedBody,
				node.sourceMessageId ?? null,
				node.sourceTurnIndex ?? null,
				node.importance,
				node.createdAt,
				JSON.stringify(node.metadata),
			);
		}

		const insertEdge = db.prepare(`
			INSERT INTO session_context_edges (
				id, session_id, source_node_id, target_node_id, relation,
				weight, evidence_message_id, metadata_json
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
		`);
		for (const edge of input.edges) {
			insertEdge.run(
				edge.id,
				edge.sessionId,
				edge.sourceNodeId,
				edge.targetNodeId,
				edge.relation,
				edge.weight,
				edge.evidenceMessageId ?? null,
				JSON.stringify(edge.metadata),
			);
		}

		const insertArtifact = db.prepare(`
			INSERT INTO session_context_artifacts (
				id, session_id, node_id, kind, ref, label, metadata_json
			) VALUES (?, ?, ?, ?, ?, ?, ?)
		`);
		for (const artifact of input.artifacts) {
			insertArtifact.run(
				artifact.id,
				artifact.sessionId,
				artifact.nodeId ?? null,
				artifact.kind,
				artifact.ref,
				artifact.label,
				JSON.stringify(artifact.metadata),
			);
		}
	});
	tx();
}

export function upsertSessionContextCheckpoint(input: SessionContextCheckpointInput): void {
	getDb().run(
		`INSERT INTO session_context_checkpoints (
			session_id, source_path, source_mtime_ms, source_size_bytes,
			node_count, edge_count, rebuilt_at
		) VALUES (?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(session_id) DO UPDATE SET
			source_path = excluded.source_path,
			source_mtime_ms = excluded.source_mtime_ms,
			source_size_bytes = excluded.source_size_bytes,
			node_count = excluded.node_count,
			edge_count = excluded.edge_count,
			rebuilt_at = excluded.rebuilt_at`,
		input.sessionId,
		input.sourcePath,
		input.sourceMtimeMs,
		input.sourceSizeBytes,
		input.nodeCount,
		input.edgeCount,
		input.rebuiltAt,
	);
}

export function getSessionContextGraph(sessionId: string, limit: number): SessionContextGraphResponse {
	const boundedLimit = Math.min(Math.max(Math.trunc(limit) || 200, 1), 500);
	const rows = getDb().query<NodeRow, [string, number]>(
		`SELECT * FROM session_context_nodes WHERE session_id = ? ORDER BY importance DESC, created_at DESC LIMIT ?`,
	).all(sessionId, boundedLimit);
	const nodes = rows.map(nodeFromRow);
	const nodeIds = new Set(nodes.map((node) => node.id));
	const edgeRows = getDb().query<EdgeRow, [string]>(
		`SELECT * FROM session_context_edges WHERE session_id = ? ORDER BY weight DESC`,
	).all(sessionId);
	const edges = edgeRows.filter((edge) => nodeIds.has(edge.source_node_id) && nodeIds.has(edge.target_node_id)).map(edgeFromRow);
	const artifactRows = getDb().query<ArtifactRow, [string]>(
		`SELECT * FROM session_context_artifacts WHERE session_id = ? ORDER BY kind, label`,
	).all(sessionId);
	const totalRow = getDb().query<{ c: number }, [string]>(
		`SELECT COUNT(*) AS c FROM session_context_nodes WHERE session_id = ?`,
	).get(sessionId);
	const totalNodes = totalRow?.c ?? nodes.length;
	return {
		sessionId,
		nodes,
		edges,
		artifacts: artifactRows.map(artifactFromRow),
		totalNodes,
		truncated: totalNodes > nodes.length,
	};
}
```

- [ ] **Step 4: Run DB tests**

Run:

```sh
bun test apps/server/src/db/session-context.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```sh
git add apps/server/src/db/migrations/005-session-context.sql apps/server/src/db/session-context.ts apps/server/src/db/session-context.test.ts
git commit -m "Add session context storage"
```

---

## Task 3: JSONL extractor and context pack service

**Files:**

- Create: `apps/server/src/session-context.ts`
- Create: `apps/server/src/session-context.test.ts`
- Modify: `apps/server/src/db/session-context.ts` if retrieval helpers need small additions

- [ ] **Step 1: Write failing extractor tests**

Create `apps/server/src/session-context.test.ts`:

```ts
import { describe, expect, test } from "bun:test";

import { extractSessionContextFromJsonl, renderSessionContextPack } from "./session-context.ts";

const jsonl = [
	JSON.stringify({ type: "title", v: 1, title: "Context topology" }),
	JSON.stringify({ type: "session", version: 3, id: "s1", cwd: "/repo", timestamp: "2026-07-02T00:00:00.000Z" }),
	JSON.stringify({ type: "message", id: "u1", timestamp: "2026-07-02T00:00:01.000Z", message: { role: "user", content: [{ type: "text", text: "继续会话内拓扑记忆系统的搭建" }] } }),
	JSON.stringify({ type: "message", id: "a1", timestamp: "2026-07-02T00:00:02.000Z", message: { role: "assistant", content: [{ type: "text", text: "推荐先做 Memory Cockpit 可视化拓扑。" }] } }),
	JSON.stringify({ type: "message", id: "u2", timestamp: "2026-07-02T00:00:03.000Z", message: { role: "user", content: [{ type: "text", text: "我希望的是作为上下文数据的替换方法，节省上下文空间" }] } }),
	JSON.stringify({ type: "message", id: "tool1", timestamp: "2026-07-02T00:00:04.000Z", message: { role: "tool", content: [{ type: "text", text: "bun test apps/server/src/session-context.test.ts\n10 pass 0 fail" }] } }),
].join("\n");

describe("session context extraction", () => {
	test("extracts user correction as superseding intent", () => {
		const result = extractSessionContextFromJsonl({ sessionId: "s1", content: jsonl });

		const correction = result.nodes.find((node) => node.kind === "user_intent" && node.body.includes("上下文数据"));
		expect(correction).toBeDefined();
		expect(result.nodes.some((node) => node.kind === "goal" && node.body.includes("拓扑记忆"))).toBe(true);
		expect(result.edges.some((edge) => edge.relation === "supersedes" || edge.relation === "contradicts")).toBe(true);
	});

	test("extracts test output as evidence", () => {
		const result = extractSessionContextFromJsonl({ sessionId: "s1", content: jsonl });

		expect(result.nodes).toEqual(expect.arrayContaining([
			expect.objectContaining({ kind: "evidence", sourceMessageId: "tool1" }),
		]));
		expect(result.artifacts).toEqual(expect.arrayContaining([
			expect.objectContaining({ kind: "test", ref: "bun test apps/server/src/session-context.test.ts" }),
		]));
	});

	test("renders compact context pack with correction before stale assumption", () => {
		const extracted = extractSessionContextFromJsonl({ sessionId: "s1", content: jsonl });
		const pack = renderSessionContextPack({ sessionId: "s1", query: "节省上下文空间", budget: 1600, ...extracted });

		expect(pack.summary).toContain("上下文");
		expect(pack.goals.length).toBeGreaterThan(0);
		expect(pack.rawRefs.some((ref) => ref.messageId === "u2")).toBe(true);
		expect(pack.omitted.reason).toBeString();
	});
});
```

Run:

```sh
bun test apps/server/src/session-context.test.ts
```

Expected: FAIL because `session-context.ts` does not exist.

- [ ] **Step 2: Implement deterministic extractor**

Create `apps/server/src/session-context.ts` with these exported functions and helpers:

```ts
import type {
	SessionContextArtifact,
	SessionContextEdge,
	SessionContextNode,
	SessionContextPackResponse,
	SessionContextRawRef,
} from "@omp-deck/protocol";

interface ExtractInput {
	sessionId: string;
	content: string;
}

interface ExtractedSessionContext {
	nodes: SessionContextNode[];
	edges: SessionContextEdge[];
	artifacts: SessionContextArtifact[];
}

interface JsonRecord {
	type?: unknown;
	id?: unknown;
	timestamp?: unknown;
	message?: unknown;
}

const FILE_RE = /(?:^|\s)([\w./~@-]+\.(?:ts|tsx|js|jsx|json|md|sql|yaml|yml|sh|ps1))(?:\b|$)/g;
const COMMIT_RE = /\b[0-9a-f]{7,40}\b/g;
const TEST_COMMAND_RE = /\b(?:bun|npm|pnpm|yarn)\s+(?:test|run\s+[^\n]+)/g;

function parseJsonLine(line: string): Record<string, unknown> | undefined {
	try {
		const parsed = JSON.parse(line) as unknown;
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
	} catch {
		return undefined;
	}
}

function textFromContent(value: unknown): string {
	if (typeof value === "string") return value;
	if (Array.isArray(value)) {
		return value.map((item) => {
			if (typeof item === "string") return item;
			if (!item || typeof item !== "object") return "";
			const obj = item as Record<string, unknown>;
			return typeof obj.text === "string" ? obj.text : "";
		}).filter(Boolean).join("\n");
	}
	return "";
}

function messageParts(record: Record<string, unknown>): { id: string; role: string; text: string; timestamp: string } | undefined {
	if (record.type !== "message") return undefined;
	const message = record.message;
	if (!message || typeof message !== "object") return undefined;
	const msg = message as Record<string, unknown>;
	const role = typeof msg.role === "string" ? msg.role : "unknown";
	const text = textFromContent(msg.content);
	if (!text.trim()) return undefined;
	const idValue = record.id;
	const id = typeof idValue === "string" && idValue.trim() ? idValue : `line-${Math.random().toString(36).slice(2)}`;
	const timestampValue = record.timestamp;
	const timestamp = typeof timestampValue === "string" ? timestampValue : new Date(0).toISOString();
	return { id, role, text, timestamp };
}

function compressText(text: string): string {
	return text
		.replace(/\s+/g, " ")
		.replace(/\b(?:I think|I should|Maybe|Now|Next)\b[:,]?\s*/gi, "")
		.trim()
		.slice(0, 1200);
}

function makeNode(input: {
	sessionId: string;
	kind: SessionContextNode["kind"];
	messageId: string;
	turnIndex: number;
	title: string;
	body: string;
	importance: number;
	createdAt: string;
	metadata?: Record<string, unknown>;
}): SessionContextNode {
	return {
		id: `${input.sessionId}:${input.kind}:${input.turnIndex}:${input.messageId}`,
		sessionId: input.sessionId,
		kind: input.kind,
		title: input.title.slice(0, 120),
		body: input.body,
		compressedBody: compressText(input.body),
		importance: input.importance,
		createdAt: input.createdAt,
		sourceMessageId: input.messageId,
		sourceTurnIndex: input.turnIndex,
		metadata: input.metadata ?? {},
	};
}

function classifyUserText(text: string): SessionContextNode["kind"] {
	if (/希望|不是|而是|纠正|改成|不要|必须|must|should|instead/i.test(text)) return "user_intent";
	return "goal";
}

function classifyNonUserText(role: string, text: string): SessionContextNode["kind"] | undefined {
	if (role === "tool" && /\b(pass|fail|error|exit|HTTP|buildSha|naturalWidth|status:)\b/i.test(text)) return /fail|error|exit 1/i.test(text) ? "issue" : "evidence";
	if (/\b(decision|recommend|architecture|选择|推荐|决定)\b/i.test(text)) return "decision";
	return undefined;
}

function artifactMatches(sessionId: string, nodeId: string, text: string): SessionContextArtifact[] {
	const artifacts: SessionContextArtifact[] = [];
	for (const match of text.matchAll(FILE_RE)) {
		const ref = match[1];
		if (!ref) continue;
		artifacts.push({ id: `${nodeId}:file:${artifacts.length}`, sessionId, nodeId, kind: "file", ref, label: ref, metadata: {} });
	}
	for (const match of text.matchAll(COMMIT_RE)) {
		const ref = match[0];
		artifacts.push({ id: `${nodeId}:commit:${artifacts.length}`, sessionId, nodeId, kind: "commit", ref, label: ref.slice(0, 12), metadata: {} });
	}
	for (const match of text.matchAll(TEST_COMMAND_RE)) {
		const ref = match[0];
		artifacts.push({ id: `${nodeId}:test:${artifacts.length}`, sessionId, nodeId, kind: "test", ref, label: ref, metadata: {} });
	}
	return artifacts;
}

export function extractSessionContextFromJsonl(input: ExtractInput): ExtractedSessionContext {
	const nodes: SessionContextNode[] = [];
	const edges: SessionContextEdge[] = [];
	const artifacts: SessionContextArtifact[] = [];
	let lastGoal: SessionContextNode | undefined;
	let lastIssue: SessionContextNode | undefined;
	let turnIndex = 0;

	for (const rawLine of input.content.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line) continue;
		const record = parseJsonLine(line);
		if (!record) continue;
		const message = messageParts(record);
		if (!message) continue;
		turnIndex += 1;

		const kind = message.role === "user" ? classifyUserText(message.text) : classifyNonUserText(message.role, message.text);
		if (!kind) continue;
		const node = makeNode({
			sessionId: input.sessionId,
			kind,
			messageId: message.id,
			turnIndex,
			title: message.text.split(/\r?\n/)[0] ?? kind,
			body: message.text,
			importance: kind === "user_intent" ? 1 : kind === "evidence" ? 0.85 : 0.7,
			createdAt: message.timestamp,
			metadata: { role: message.role },
		});
		nodes.push(node);
		artifacts.push(...artifactMatches(input.sessionId, node.id, message.text));

		if (kind === "goal") lastGoal = node;
		if (kind === "issue") lastIssue = node;
		if (kind === "user_intent" && lastGoal) {
			edges.push({ id: `${node.id}:supersedes:${lastGoal.id}`, sessionId: input.sessionId, sourceNodeId: node.id, targetNodeId: lastGoal.id, relation: "supersedes", weight: 1, evidenceMessageId: message.id, metadata: {} });
		}
		if (kind === "evidence" && lastIssue) {
			edges.push({ id: `${lastIssue.id}:verified_by:${node.id}`, sessionId: input.sessionId, sourceNodeId: lastIssue.id, targetNodeId: node.id, relation: "verified_by", weight: 0.9, evidenceMessageId: message.id, metadata: {} });
		}
	}

	return { nodes, edges, artifacts };
}
```

- [ ] **Step 3: Implement pack renderer in same file**

Append:

```ts
interface RenderPackInput extends ExtractedSessionContext {
	sessionId: string;
	query: string;
	budget: number;
}

function scoreNode(node: SessionContextNode, query: string): number {
	const q = query.trim().toLowerCase();
	let score = node.importance;
	if (q && `${node.title}\n${node.body}`.toLowerCase().includes(q)) score += 2;
	if (node.kind === "user_intent" || node.kind === "constraint") score += 1.5;
	if (node.kind === "issue" || node.kind === "evidence") score += 1;
	return score;
}

function byKinds(nodes: SessionContextNode[], kinds: SessionContextNode["kind"][]): SessionContextNode[] {
	const wanted = new Set(kinds);
	return nodes.filter((node) => wanted.has(node.kind));
}

function rawRefsFor(nodes: SessionContextNode[], artifacts: SessionContextArtifact[]): SessionContextRawRef[] {
	const refs: SessionContextRawRef[] = [];
	for (const node of nodes) {
		refs.push({ messageId: node.sourceMessageId, turnIndex: node.sourceTurnIndex, label: `${node.kind}: ${node.title}` });
	}
	for (const artifact of artifacts.slice(0, 20)) {
		refs.push({ artifactId: artifact.id, label: `${artifact.kind}: ${artifact.label}` });
	}
	return refs;
}

export function renderSessionContextPack(input: RenderPackInput): SessionContextPackResponse {
	const ranked = [...input.nodes].sort((a, b) => scoreNode(b, input.query) - scoreNode(a, input.query));
	let remaining = Math.max(500, input.budget);
	const selected: SessionContextNode[] = [];
	for (const node of ranked) {
		const cost = node.compressedBody.length + node.title.length + 64;
		if (selected.length > 0 && cost > remaining) continue;
		selected.push(node);
		remaining -= cost;
	}
	const selectedIds = new Set(selected.map((node) => node.id));
	const artifacts = input.artifacts.filter((artifact) => !artifact.nodeId || selectedIds.has(artifact.nodeId));
	const summary = selected.slice(0, 8).map((node) => `${node.kind}: ${node.compressedBody}`).join("\n");
	return {
		sessionId: input.sessionId,
		query: input.query,
		budget: input.budget,
		summary,
		goals: byKinds(selected, ["goal", "user_intent"]),
		constraints: byKinds(selected, ["constraint"]),
		decisions: byKinds(selected, ["decision"]),
		issues: byKinds(selected, ["issue"]),
		resolutions: byKinds(selected, ["resolution"]),
		artifacts,
		evidence: byKinds(selected, ["evidence"]),
		openTodos: byKinds(selected, ["todo_state"]),
		rawRefs: rawRefsFor(selected, artifacts),
		omitted: {
			nodeCount: input.nodes.length - selected.length,
			edgeCount: input.edges.filter((edge) => !selectedIds.has(edge.sourceNodeId) || !selectedIds.has(edge.targetNodeId)).length,
			reason: selected.length < input.nodes.length ? "budget" : "none",
		},
	};
}
```

- [ ] **Step 4: Run extractor tests**

Run:

```sh
bun test apps/server/src/session-context.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```sh
git add apps/server/src/session-context.ts apps/server/src/session-context.test.ts
git commit -m "Extract session context packs from JSONL"
```

---

## Task 4: Rebuild service and REST routes

**Files:**

- Modify: `apps/server/src/session-context.ts`
- Create: `apps/server/src/routes-session-context.ts`
- Modify: `apps/server/src/routes.ts`
- Create: `apps/server/src/routes-session-context.test.ts`

- [ ] **Step 1: Add rebuild orchestration test**

Extend `apps/server/src/session-context.test.ts` with a temp file rebuild test:

```ts
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach } from "bun:test";
import { closeDb, openDb } from "./db/index.ts";
import { getSessionContextGraph } from "./db/session-context.ts";
import { rebuildSessionContextFromFile } from "./session-context.ts";

const tempDirs: string[] = [];
afterEach(() => {
	closeDb();
	for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "session-context-service-"));
	tempDirs.push(dir);
	return dir;
}

test("rebuilds context store from a session file", async () => {
	const dir = tempDir();
	openDb({ path: path.join(dir, "deck.db") });
	const sessionFile = path.join(dir, "s1.jsonl");
	fs.writeFileSync(sessionFile, jsonl);

	const rebuilt = await rebuildSessionContextFromFile({ sessionId: "s1", sessionFile });

	expect(rebuilt.nodeCount).toBeGreaterThan(0);
	expect(rebuilt.sourcePath).toBe(sessionFile);
	const graph = getSessionContextGraph("s1", 50);
	expect(graph.nodes.length).toBe(rebuilt.nodeCount);
});
```

Run:

```sh
bun test apps/server/src/session-context.test.ts
```

Expected: FAIL because `rebuildSessionContextFromFile` is not implemented.

- [ ] **Step 2: Implement rebuild and stored pack helpers**

Append to `apps/server/src/session-context.ts`:

```ts
import { replaceSessionContext, getSessionContextGraph, upsertSessionContextCheckpoint } from "./db/session-context.ts";

export async function rebuildSessionContextFromFile(input: { sessionId: string; sessionFile: string }): Promise<SessionContextRebuildResponse> {
	const file = Bun.file(input.sessionFile);
	if (!(await file.exists())) throw new Error("session file not found");
	const [content, stat] = await Promise.all([file.text(), file.stat()]);
	const extracted = extractSessionContextFromJsonl({ sessionId: input.sessionId, content });
	replaceSessionContext({ sessionId: input.sessionId, ...extracted });
	const rebuiltAt = new Date().toISOString();
	upsertSessionContextCheckpoint({
		sessionId: input.sessionId,
		sourcePath: input.sessionFile,
		sourceMtimeMs: Math.trunc(stat.mtimeMs),
		sourceSizeBytes: stat.size,
		nodeCount: extracted.nodes.length,
		edgeCount: extracted.edges.length,
		rebuiltAt,
	});
	return { sessionId: input.sessionId, nodeCount: extracted.nodes.length, edgeCount: extracted.edges.length, sourcePath: input.sessionFile, rebuiltAt };
}

export function getStoredSessionContextPack(input: { sessionId: string; query: string; budget: number }): SessionContextPackResponse {
	const graph = getSessionContextGraph(input.sessionId, 500);
	return renderSessionContextPack({
		sessionId: input.sessionId,
		query: input.query,
		budget: input.budget,
		nodes: graph.nodes,
		edges: graph.edges,
		artifacts: graph.artifacts,
	});
}
```

Also add `SessionContextRebuildResponse` to the type import.

- [ ] **Step 3: Add routes**

Create `apps/server/src/routes-session-context.ts`:

```ts
import { Hono } from "hono";

import type { AgentBridge } from "./bridge/types.ts";
import { getSessionContextGraph } from "./db/session-context.ts";
import { logger } from "./log.ts";
import { getStoredSessionContextPack, rebuildSessionContextFromFile } from "./session-context.ts";

const log = logger("routes-session-context");

function parseLimit(value: string | undefined, fallback: number): number {
	const parsed = value ? Number.parseInt(value, 10) : fallback;
	if (!Number.isFinite(parsed)) return fallback;
	return Math.min(Math.max(parsed, 1), 500);
}

function parseBudget(value: string | undefined): number {
	const parsed = value ? Number.parseInt(value, 10) : 4000;
	if (!Number.isFinite(parsed)) return 4000;
	return Math.min(Math.max(parsed, 500), 12000);
}

export function buildSessionContextRouter(bridge: AgentBridge): Hono {
	const app = new Hono();

	app.post("/sessions/:id/context/rebuild", async (c) => {
		const id = c.req.param("id");
		const handle = bridge.getSession(id);
		if (!handle?.sessionFile) return c.json({ error: "session not found or has no session file" }, 404);
		try {
			return c.json(await rebuildSessionContextFromFile({ sessionId: id, sessionFile: handle.sessionFile }));
		} catch (err) {
			log.error("context rebuild failed", err);
			return c.json({ error: String((err as Error).message ?? err) }, 500);
		}
	});

	app.get("/sessions/:id/context-pack", (c) => {
		const id = c.req.param("id");
		const handle = bridge.getSession(id);
		if (!handle) return c.json({ error: "session not found" }, 404);
		const query = c.req.query("q") ?? "";
		const budget = parseBudget(c.req.query("budget"));
		return c.json(getStoredSessionContextPack({ sessionId: id, query, budget }));
	});

	app.get("/sessions/:id/context-graph", (c) => {
		const id = c.req.param("id");
		const handle = bridge.getSession(id);
		if (!handle) return c.json({ error: "session not found" }, 404);
		return c.json(getSessionContextGraph(id, parseLimit(c.req.query("limit"), 200)));
	});

	return app;
}
```

- [ ] **Step 4: Mount routes**

Modify `apps/server/src/routes.ts`:

Add import:

```ts
import { buildSessionContextRouter } from "./routes-session-context.ts";
```

Mount near other session-related routes before `return app`:

```ts
app.route("/", buildSessionContextRouter(bridge));
```

- [ ] **Step 5: Run service and DB tests**

Run:

```sh
bun test apps/server/src/session-context.test.ts apps/server/src/db/session-context.test.ts
bun run --filter '@omp-deck/server' typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit**

```sh
git add apps/server/src/session-context.ts apps/server/src/routes-session-context.ts apps/server/src/routes.ts apps/server/src/session-context.test.ts
git commit -m "Serve session context packs"
```

---

## Task 5: Web API and minimal debug panel

**Files:**

- Modify: `apps/web/src/lib/api.ts`
- Create: `apps/web/src/components/session/ContextPackPanel.tsx`
- Modify: current session/chat container after locating selected session id usage
- Modify: `apps/web/src/i18n/index.ts`

- [ ] **Step 1: Add API client methods**

Modify imports in `apps/web/src/lib/api.ts`:

```ts
import type {
	SessionContextGraphResponse,
	SessionContextPackResponse,
	SessionContextRebuildResponse,
	// existing imports...
} from "@omp-deck/protocol";
```

Add methods to `api`:

```ts
rebuildSessionContext(id: string): Promise<SessionContextRebuildResponse> {
	return request<SessionContextRebuildResponse>(`/sessions/${encodeURIComponent(id)}/context/rebuild`, { method: "POST" });
},
getSessionContextPack(id: string, params: { q?: string; budget?: number } = {}): Promise<SessionContextPackResponse> {
	const search = new URLSearchParams();
	if (params.q) search.set("q", params.q);
	if (params.budget) search.set("budget", String(params.budget));
	const qs = search.toString();
	return request<SessionContextPackResponse>(`/sessions/${encodeURIComponent(id)}/context-pack${qs ? `?${qs}` : ""}`);
},
getSessionContextGraph(id: string, limit = 200): Promise<SessionContextGraphResponse> {
	return request<SessionContextGraphResponse>(`/sessions/${encodeURIComponent(id)}/context-graph?limit=${encodeURIComponent(String(limit))}`);
},
```

- [ ] **Step 2: Create debug panel component**

Create `apps/web/src/components/session/ContextPackPanel.tsx`:

```tsx
import { useCallback, useState } from "react";
import type { SessionContextPackResponse } from "@omp-deck/protocol";

import { api } from "@/lib/api";
import { cn } from "@/lib/utils";

interface ContextPackPanelProps {
	sessionId: string | null;
	query?: string;
	className?: string;
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
	return (
		<section className="space-y-1">
			<h4 className="text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">{title}</h4>
			<div className="space-y-1 text-xs text-foreground/85">{children}</div>
		</section>
	);
}

function NodeList({ nodes }: { nodes: SessionContextPackResponse["goals"] }) {
	if (nodes.length === 0) return <div className="text-muted-foreground">None</div>;
	return (
		<ul className="space-y-1">
			{nodes.map((node) => (
				<li key={node.id} className="rounded border border-line/60 bg-panel/60 p-2">
					<div className="font-medium">{node.title}</div>
					<div className="text-muted-foreground">{node.compressedBody}</div>
				</li>
			))}
		</ul>
	);
}

export function ContextPackPanel({ sessionId, query = "", className }: ContextPackPanelProps) {
	const [pack, setPack] = useState<SessionContextPackResponse | null>(null);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const rebuildAndLoad = useCallback(async () => {
		if (!sessionId) return;
		setLoading(true);
		setError(null);
		try {
			await api.rebuildSessionContext(sessionId);
			setPack(await api.getSessionContextPack(sessionId, { q: query, budget: 4000 }));
		} catch (err) {
			setError(String((err as Error).message ?? err));
		} finally {
			setLoading(false);
		}
	}, [query, sessionId]);

	return (
		<div className={cn("rounded-lg border border-line bg-panel/70 p-3", className)}>
			<div className="flex items-center justify-between gap-2">
				<div>
					<h3 className="text-sm font-semibold">Context Pack</h3>
					<p className="text-xs text-muted-foreground">Derived replacement context for this session.</p>
				</div>
				<button className="rounded border border-line px-2 py-1 text-xs hover:bg-muted" disabled={!sessionId || loading} onClick={rebuildAndLoad}>
					{loading ? "Building…" : "Rebuild"}
				</button>
			</div>
			{error ? <div className="mt-2 rounded border border-red-500/30 bg-red-500/10 p-2 text-xs text-red-300">{error}</div> : null}
			{pack ? (
				<div className="mt-3 space-y-3">
					<Section title="Summary"><pre className="whitespace-pre-wrap rounded bg-black/20 p-2">{pack.summary || "No summary"}</pre></Section>
					<Section title="Goals"><NodeList nodes={pack.goals} /></Section>
					<Section title="Decisions"><NodeList nodes={pack.decisions} /></Section>
					<Section title="Issues"><NodeList nodes={pack.issues} /></Section>
					<Section title="Evidence"><NodeList nodes={pack.evidence} /></Section>
					<Section title="Raw refs">
						<ul className="space-y-1 text-muted-foreground">
							{pack.rawRefs.slice(0, 12).map((ref, index) => <li key={`${ref.label}-${index}`}>{ref.label}</li>)}
						</ul>
					</Section>
				</div>
			) : null}
		</div>
	);
}
```

- [ ] **Step 3: Add panel entry point in Chat**

Modify `apps/web/src/components/Chat.tsx`.

Add import:

```tsx
import { ContextPackPanel } from "./session/ContextPackPanel";
```

Render the panel after pending plan approval inside the existing centered message column:

```tsx
{session.pendingPlanApproval ? (
	<PlanApproval session={session} />
) : null}
<ContextPackPanel sessionId={session.sessionId} />
```

Keep the existing `max-w-[760px]` column and do not refactor chat layout.

- [ ] **Step 4: Add i18n keys and consume them in the panel**

Add both language blocks in `apps/web/src/i18n/index.ts` under the existing top-level translation object:

```ts
sessionContext: {
	title: "Context Pack",
	description: "Derived replacement context for this session.",
	rebuild: "Rebuild",
	building: "Building…",
	none: "None",
	noSummary: "No summary",
	sections: {
		summary: "Summary",
		goals: "Goals",
		decisions: "Decisions",
		issues: "Issues",
		evidence: "Evidence",
		rawRefs: "Raw refs",
	},
}
```

Chinese block:

```ts
sessionContext: {
	title: "上下文包",
	description: "从当前会话派生的替代上下文。",
	rebuild: "重建",
	building: "构建中…",
	none: "无",
	noSummary: "暂无摘要",
	sections: {
		summary: "摘要",
		goals: "目标",
		decisions: "决策",
		issues: "问题",
		evidence: "证据",
		rawRefs: "原始引用",
	},
}
```

In `ContextPackPanel.tsx`, read labels through the existing i18n hook/function used elsewhere in the app. If no hook is available in this component layer, import the project helper from `@/i18n` following nearby component conventions and replace hard-coded labels with those keys.

- [ ] **Step 5: Typecheck and build web**

Run:

```sh
bun run --filter '@omp-deck/web' typecheck
bun run --filter '@omp-deck/web' build
```

Expected: PASS.

- [ ] **Step 6: Commit**

```sh
git add apps/web/src/lib/api.ts apps/web/src/components/session/ContextPackPanel.tsx apps/web/src/components/Chat.tsx apps/web/src/i18n/index.ts
git commit -m "Add session context pack panel"
```

---

## Task 6: End-to-end verification and polish

**Files:**

- Modify only files touched by failed checks.

- [ ] **Step 1: Run targeted tests**

Run:

```sh
bun test apps/server/src/db/session-context.test.ts apps/server/src/session-context.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run server typecheck**

Run:

```sh
bun run --filter '@omp-deck/server' typecheck
```

Expected: PASS.

- [ ] **Step 3: Run web typecheck and build**

Run:

```sh
bun run --filter '@omp-deck/web' typecheck
bun run --filter '@omp-deck/web' build
```

Expected: PASS.

- [ ] **Step 4: Live API smoke**
Start deck on isolated ports:

```sh
OMP_DECK_PORT=8891 OMP_DECK_WEB_PORT=5177 bun run dev
```

In another terminal, create or resume a session, then call:

```sh
curl -s -X POST http://127.0.0.1:8891/api/sessions/<id>/context/rebuild
curl -s 'http://127.0.0.1:8891/api/sessions/<id>/context-pack?q=context&budget=2000'
```

Expected:

- Rebuild returns `nodeCount > 0` for a session with messages.
- Pack returns `summary`, `goals`, `rawRefs`, and bounded `omitted` metadata.
- Bulky raw tool output is not copied wholesale into `summary`.

- [ ] **Step 5: Browser smoke**

Open the web UI on the matching Vite port. In an active session:

1. Open the `Context Pack` panel.
2. Click `Rebuild`.
3. Confirm summary and sections render.
4. Confirm errors are shown if the session has no file.

- [ ] **Step 6: Final review**

Dispatch reviewer with these focus areas:

- Does extraction preserve user corrections and verification evidence?
- Is every compressed node source-referenced?
- Are DB writes limited to deck-owned tables?
- Are context pack APIs bounded?
- Are there any `any` or unsafe casts that should be type guards?

- [ ] **Step 7: Commit polish fixes**

If review or smoke finds fixes:

```sh
git add packages/protocol/src/index.ts apps/server/src/db/migrations/005-session-context.sql apps/server/src/db/session-context.ts apps/server/src/db/session-context.test.ts apps/server/src/session-context.ts apps/server/src/session-context.test.ts apps/server/src/routes-session-context.ts apps/server/src/routes.ts apps/web/src/lib/api.ts apps/web/src/components/session/ContextPackPanel.tsx apps/web/src/components/Chat.tsx apps/web/src/i18n/index.ts
git commit -m "Polish session context topology"
```

---

## Execution notes

- Use an isolated worktree for implementation because current `main` has unrelated dirty files.
- Recommended worktree path: `~/.config/superpowers/worktrees/omp-deck/session-context-topology`.
- Branch name: `feature/session-context-topology`.
- Do not stage unrelated existing dirty files in `/Users/hyan/AI/omp-deck`.
- Keep commits per task. Do not squash until final integration decision.
- Avoid `as any`; use `unknown`, `Record<string, unknown>`, and type guards.
- Avoid `ReturnType<typeof fn>`; export/import named types if needed.
