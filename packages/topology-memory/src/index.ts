/**
 * topology-memory — Standalone OMP Extension
 *
 * Extracts session topology from JSONL, retrieves relevant context
 * via IDF scoring, and injects a compact focus block before each
 * user turn. Works WITHOUT the omp-deck server.
 *
 * Dual-mode:
 *   1. Deck-connected: if OMP_DECK_API_BASE is set and reachable,
 *      fetch focus from the deck server (richer: embeddings + rerank).
 *   2. Standalone: extract + retrieve locally using the embedded engine.
 *
 * Configure via environment:
 *   OMP_TOPOLOGY_MEMORY_ENABLED=1         Enable (default: disabled)
 *   OMP_TOPOLOGY_MEMORY_DB_PATH=/path     SQLite path (default: ~/.omp/agent/topology-memory.db)
 *   OMP_TOPOLOGY_MEMORY_OUTPUT_NODES=40   Max nodes in focus (default: 40)
 *   OMP_TOPOLOGY_MEMORY_KEEP_TURNS=3      Recent turns to keep when replacing
 *   OMP_TOPOLOGY_MEMORY_TIMEOUT_MS=1500   HTTP fetch timeout for deck-connected mode
 *   OMP_DECK_API_BASE=http://127.0.0.1:8787  Deck server URL (optional)
 *
 * Install: copy this directory to ~/.omp/agent/extensions/topology-memory/
 */

import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { mkdirSync } from "node:fs";
import { extractFromMessages } from "./extract.ts";
import { TopologyStore } from "./store.ts";
import { retrieveTopology, renderFocus } from "./retrieve.ts";
import { optimizeTopology } from "./optimize.ts";
import { collectForReflection } from "./skill-bridge.ts";
import type { TopologyContextMessage } from "./types-extension.ts";

const CUSTOM_TYPE = "topology-memory-context";

let store: TopologyStore | undefined;
let extLogger: { info?: (...a: unknown[]) => void; warn?: (...a: unknown[]) => void; error?: (...a: unknown[]) => void; debug?: (...a: unknown[]) => void } | undefined;

function log(level: "info" | "warn" | "error" | "debug", ...args: unknown[]): void {
	extLogger?.[level]?.(...args);
}

function getStore(): TopologyStore {
	if (!store) store = new TopologyStore(process.env.OMP_TOPOLOGY_MEMORY_DB_PATH);
	return store;
}

function isEnabled(): boolean {
	return (process.env.OMP_TOPOLOGY_MEMORY_ENABLED ?? "").trim().toLowerCase() !== "0";
}

function readEnvInt(name: string, fallback: number, min: number, max: number): number {
	const raw = Number(process.env[name]);
	if (!Number.isFinite(raw)) return fallback;
	return Math.min(Math.max(Math.trunc(raw), min), max);
}

function extractLatestUserText(messages: readonly unknown[]): string | null {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i] as Record<string, unknown> | undefined;
		if (!msg || msg.role !== "user") continue;
		const content = msg.content;
		if (typeof content === "string") return content.trim();
		if (Array.isArray(content)) {
			const text = content
				.map((p) => {
					if (typeof p === "string") return p;
					if (typeof p === "object" && p !== null) {
						const r = p as Record<string, unknown>;
						if (typeof r.text === "string") return r.text;
					}
					return "";
				})
				.join("")
				.trim();
			if (text) return text;
		}
	}
	return null;
}

function readRole(value: unknown): string | null {
	if (typeof value === "object" && value !== null) {
		const r = value as Record<string, unknown>;
		if (typeof r.role === "string") return r.role;
	}
	return null;
}

function isLoopback(url: string): boolean {
	return url.includes("127.0.0.1") || url.includes("localhost");
}

async function fetchDeckFocus(url: string, timeoutMs: number): Promise<string | null> {
	try {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), timeoutMs);
		const resp = await fetch(url, { signal: controller.signal });
		clearTimeout(timer);
		if (!resp.ok) return null;
		const data = await resp.json() as Record<string, unknown>;
		const focus = data.focus;
		return typeof focus === "string" && focus.length > 0 ? focus : null;
	} catch {
		return null;
	}
}

/**
 * Try deck-connected mode. Returns focus string or null if deck is
 * unavailable (caller falls back to standalone extraction).
 */
async function tryDeckMode(
	apiBase: string | undefined,
	sessionId: string,
	query: string,
	timeoutMs: number,
): Promise<string | null> {
	if (!apiBase || !isLoopback(apiBase)) return null;
	const url = `${apiBase}/sessions/${encodeURIComponent(sessionId)}/context-focus?q=${encodeURIComponent(query.slice(0, 500))}`;
	return fetchDeckFocus(url, timeoutMs);
}

/**
 * Extract topology from the agent_end event's pre-parsed messages.
 * No JSONL parsing — uses AgentMessage[] directly from OMP.
 */
async function extractAndStoreFromMessages(sessionId: string, messages: readonly Record<string, unknown>[]): Promise<number> {
	const extracted = await extractFromMessages(sessionId, messages);
	const s = getStore();
	s.replaceSession(sessionId, extracted.nodes, extracted.edges, extracted.artifacts);
	await Bun.sleep(0);
	log("info", `[topology-memory] extracted ${extracted.nodes.length} nodes from ${messages.length} messages`);
	return extracted.nodes.length;
}

/**
 * Retrieve from store and render focus for injection (pure read).
 */
function renderStoredFocus(sessionId: string, query: string): string {
	const s = getStore();
	const nodes = s.getNodes(sessionId);
	if (nodes.length === 0) return "";
	const edges = s.getEdges(sessionId);
	const artifacts = s.getArtifacts(sessionId);
	const outputNodes = readEnvInt("OMP_TOPOLOGY_MEMORY_OUTPUT_NODES", 40, 5, 100);
	const retrieved = retrieveTopology(query, nodes, edges, { outputLimit: outputNodes });
	return renderFocus(sessionId, query, retrieved, artifacts, { showArtifacts: true });
}

function replaceTopologyContext<T>(messages: readonly T[], focus: string, keepRecentUserTurns: number): Array<T | TopologyContextMessage> {
	const result: Array<T | TopologyContextMessage> = [];
	const userTurnIndices: number[] = [];
	for (let i = 0; i < messages.length; i++) {
		const role = readRole(messages[i]);
		if (role === "user") userTurnIndices.push(i);
	}
	const keepFromIndex = userTurnIndices.length > keepRecentUserTurns
		? (userTurnIndices[userTurnIndices.length - keepRecentUserTurns] ?? 0)
		: 0;

	let injected = false;
	for (let i = 0; i < messages.length; i++) {
		if (i >= keepFromIndex) {
			const msg = messages[i];
			if (msg !== undefined) result.push(msg);
		} else if (!injected) {
			result.push({
				role: "custom",
				content: focus,
				customType: CUSTOM_TYPE,
				display: false,
			} as TopologyContextMessage);
			injected = true;
		}
	}
	if (!injected) {
		result.push({
			role: "custom",
			content: focus,
			customType: CUSTOM_TYPE,
			display: false,
		} as TopologyContextMessage);
	}
	return result;
}

export default function topologyMemoryExtension(pi: ExtensionAPI): void {
	extLogger = pi.logger as typeof extLogger;

	// ── Primary extraction: agent_end ──────────────────────────────
	// After the agent responds, the JSONL has the full conversation.
	// Extract topology here so it's ready for the next context event.
	pi.on("agent_end", async (event, ctx) => {
		if (!isEnabled()) return;
		const sessionId = ctx.sessionManager.getSessionId();
		if (!sessionId) return;
		if (!event.messages || event.messages.length === 0) return;

		try {
			const nodeCount = await extractAndStoreFromMessages(sessionId, event.messages as unknown as Record<string, unknown>[]);

			if (nodeCount >= 20) {
				const s = getStore();
				const nodes = s.getNodes(sessionId);
				const edges = s.getEdges(sessionId);
				const result = optimizeTopology(nodes, edges);
				if (result.removedNodeIds.size > 0) {
					const survivingEdges = edges.filter(
						(e) => !result.removedNodeIds.has(e.sourceNodeId) && !result.removedNodeIds.has(e.targetNodeId),
					);
					const artifacts = s.getArtifacts(sessionId).filter(
						(a) => !a.nodeId || !result.removedNodeIds.has(a.nodeId),
					);
					s.replaceSession(sessionId, result.nodes, survivingEdges, artifacts);
					log("info", `[topology-memory] optimized: merged=${result.mergedCount} pruned=${result.prunedCount}`);
				}
			}
		} catch (err) {
			log("warn", `[topology-memory] agent_end extraction failed:`, err);
		}
	});

	// ── Focus injection: context event ─────────────────────────────
	// Read from store (populated by agent_end) and inject topology focus.
	pi.on("context", async (event, ctx) => {
		if (!isEnabled()) return undefined;

		const sessionId = ctx.sessionManager.getSessionId();
		if (!sessionId) return undefined;

		const query = extractLatestUserText(event.messages);
		if (!query) return undefined;

		const apiBase = process.env.OMP_DECK_API_BASE?.trim() || undefined;
		const timeoutMs = readEnvInt("OMP_TOPOLOGY_MEMORY_TIMEOUT_MS", 1500, 100, 30_000);

		// Try deck-connected mode first (richer: embeddings + rerank)
		let focus = await tryDeckMode(apiBase, sessionId, query, timeoutMs);

		// Standalone: read from store (already extracted by agent_end)
		if (!focus) {
			focus = renderStoredFocus(sessionId, query);
		}

		if (!focus) return undefined;

		const maxChars = readEnvInt("OMP_TOPOLOGY_MEMORY_MAX_FOCUS_CHARS", 50_000, 1000, 100_000);
		const bounded = focus.length > maxChars ? `${focus.slice(0, maxChars)}\n[truncated]` : focus;
		const keepTurns = readEnvInt("OMP_TOPOLOGY_MEMORY_KEEP_TURNS", 3, 1, 20);

		const replaced = replaceTopologyContext(event.messages as unknown[], bounded, keepTurns);
		log("debug", `[topology-memory] injected focus (${bounded.length} chars) for session=${sessionId}`);
		return { messages: replaced } as { messages: typeof event.messages };
	});

	// ── Skill-evolution bridge: session_shutdown ───────────────────
	pi.on("session_shutdown", async (_event: { type: string }, ctx: { sessionManager: { getSessionId(): string | undefined } }) => {
		if (!isEnabled()) return;
		const sessionId = ctx.sessionManager.getSessionId();
		if (!sessionId) return;
		const s = getStore();
		const nodes = s.getNodes(sessionId);
		if (nodes.length === 0) return;
		const edges = s.getEdges(sessionId);

		const reflection = collectForReflection(nodes, edges);
		if (reflection.recentNodes.length === 0) return;

		const reflectionDir = `${process.env.HOME ?? ""}/.omp/agent/reflection`;
		const outputPath = `${reflectionDir}/topology-input.md`;
		try {
			mkdirSync(reflectionDir, { recursive: true });
			await Bun.write(outputPath, reflection.markdown);
			log("info", `[topology-memory] wrote reflection (${reflection.recentNodes.length} nodes)`);
		} catch (err) {
			log("warn", `[topology-memory] failed to write reflection:`, err);
		}
	});
}

export { extractFromMessages, retrieveTopology, renderFocus, TopologyStore, optimizeTopology, collectForReflection };
