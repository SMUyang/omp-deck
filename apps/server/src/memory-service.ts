/**
 * Read-only access to OMP's Mnemopi memory backends.
 *
 * Finds all Mnemopi bank SQLite DBs under the agent memories directory and
 * provides status counts + FTS-backed text search. Does NOT write — all
 * mutation goes through the agent's own `/memory` slash commands.
 */
import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import type {
	MemoryBankSummary,
	MemoryGraphEdge,
	MemoryGraphNode,
	MemoryGraphResponse,
	MemoryItem,
	MemoryStatusResponse,
} from "@omp-deck/protocol";

import { logger } from "./log.ts";

const log = logger("memory-service");

const MEMORY_CONTENT_LIMIT = 2_000;
const MEMORY_GRAPH_DEFAULT_LIMIT = 120;
const MEMORY_GRAPH_MAX_LIMIT = 500;
const SIMILARITY_THRESHOLD = 0.75;
const SAME_SESSION_WEIGHT = 0.25;
const SAME_SESSION_MAX_EDGES_PER_SESSION = 5;

const GRAPH_EDGE_COLUMN_CANDIDATES: Record<"source" | "target" | "relation" | "weight", string[]> = {
	source: ["source_id", "source", "from_id", "from", "src"],
	target: ["target_id", "target", "to_id", "to", "dst"],
	relation: ["relationship", "relation", "type", "edge_type", "label"],
	weight: ["weight", "score", "strength"],
};

function trimMemoryContent(content: string): { content: string; truncated: boolean } {
	if (content.length <= MEMORY_CONTENT_LIMIT) return { content, truncated: false };
	return { content: `${content.slice(0, MEMORY_CONTENT_LIMIT)}…`, truncated: true };
}

function openDbReadonly(dbPath: string): Database {
	try {
		return new Database(dbPath, { readonly: true });
	} catch {
		// Some DBs in WAL recovery state fail readonly but succeed read-write.
		// We never write — this just lets SQLite do WAL recovery if needed.
		return new Database(dbPath);
	}
}

interface RawWorkingMemoryRow {
	id: string;
	content: string;
	source: string | null;
	timestamp: string | null;
	importance: number | null;
	memory_type: string | null;
	recall_count: number | null;
	superseded_by: string | null;
	session_id?: string | null;
}

interface RawEpisodicGraphRow {
	id: string;
	content: string | null;
	summary_of: string | null;
	importance: number | null;
	timestamp: string | null;
}

interface RawFactGraphRow {
	fact_id: string;
	source_msg_id: string | null;
	subject: string | null;
	predicate: string | null;
	object: string | null;
	confidence: number | null;
	timestamp: string | null;
}

interface RawEmbeddingRow {
	memory_id: string;
	embedding_json: string;
}

interface RawTripleRow {
	subject: string;
	source: string | null;
	confidence: number | null;
}

interface RawKgRow {
	subject: string | null;
	source_memory_id: string | null;
	confidence: number | null;
}

interface CountRow {
	c: number;
}

interface FtsRow {
	id: string;
}

interface ColumnInfoRow {
	name: string;
}

interface RawGraphEdgeRow {
	source: string;
	target: string;
	relation: string | null;
	weight: number | null;
}

type SqliteRow = Record<string, unknown>;

interface MemoryGraphOptions {
	bank?: string;
	query?: string;
	limit?: number;
}

/** Resolve the agent directory: explicit env → default ~/.omp/agent. */
function resolveAgentDir(): string {
	return process.env.OMP_AGENT_DIR?.trim() || path.join(os.homedir(), ".omp", "agent");
}

/** Resolve the memories root: agentDir/memories/mnemopi. */
function resolveMnemopiDir(agentDir: string): string {
	return path.join(agentDir, "memories", "mnemopi");
}

/** Find every mnemopi.db under the mnemopi root (root + banks/<name>/). */
export function findMnemopiDbs(agentDir: string): string[] {
	const root = resolveMnemopiDir(agentDir);
	const dbs: string[] = [];

	// Root-level DB (global/default bank)
	const rootDb = path.join(root, "mnemopi.db");
	if (fs.existsSync(rootDb)) dbs.push(rootDb);

	// Bank-scoped DBs
	const banksDir = path.join(root, "banks");
	try {
		for (const entry of fs.readdirSync(banksDir, { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			const dbPath = path.join(banksDir, entry.name, "mnemopi.db");
			if (fs.existsSync(dbPath)) dbs.push(dbPath);
		}
	} catch {
		// banks dir may not exist
	}

	return dbs;
}

/** Derive a human-readable bank name from the DB path. */
function bankNameFromPath(dbPath: string): string {
	const base = path.basename(path.dirname(dbPath));
	if (base === "mnemopi") return "default";
	return base;
}

/** Safely count rows in a table that may not exist in older schemas. */
function safeCount(db: Database, table: string): number {
	try {
		const row = db.query(`SELECT COUNT(*) as c FROM "${table}"`).get() as CountRow | undefined;
		return row?.c ?? 0;
	} catch {
		return 0;
	}
}

function summarizeBank(dbPath: string, agentDir: string): MemoryBankSummary {
	let db: Database;
	try {
		db = openDbReadonly(dbPath);
	} catch (err) {
		log.warn("failed to open bank DB", { dbPath, error: String(err) });
		return {
			bank: bankNameFromPath(dbPath),
			dbPath,
			workingCount: 0,
			episodicCount: 0,
			factCount: 0,
			embeddingCount: 0,
			graphEdgeCount: 0,
		};
	}
	try {
		return {
			bank: bankNameFromPath(dbPath),
			dbPath,
			workingCount: safeCount(db, "working_memory"),
			episodicCount: safeCount(db, "episodic_memory"),
			factCount: safeCount(db, "facts"),
			embeddingCount: safeCount(db, "memory_embeddings"),
			graphEdgeCount: safeCount(db, "graph_edges"),
		};
	} finally {
		db.close();
	}
}

/**
 * Read OMP config.yml to find the active memory.backend setting.
 *
 * Simple regex — intentionally avoids a YAML dependency. Known limitations:
 * misses inline YAML (`memory: {backend: ...}`), commented lines between the
 * two keys, or trailing comments on the backend line. All failure modes
 * silently fall back to "off", which is safe (no false-positive "available").
 */
function readMemoryBackend(agentDir: string): string {
	const configPath = path.join(agentDir, "config.yml");
	try {
		const raw = fs.readFileSync(configPath, "utf-8");
		const match = raw.match(/^memory:\s*\n\s*backend:\s*(\S+)/m);
		return match?.[1]?.trim() ?? "off";
	} catch {
		return "off";
	}
}

export function getMemoryStatus(agentDir: string): MemoryStatusResponse {
	const dir = agentDir || resolveAgentDir();
	const memoryDir = resolveMnemopiDir(dir);
	const backend = readMemoryBackend(dir) as MemoryStatusResponse["backend"];

	if (!fs.existsSync(memoryDir)) {
		return {
			backend,
			available: false,
			agentDir: dir,
			memoryDir,
			banks: [],
			totalWorking: 0,
			totalEpisodic: 0,
			totalFacts: 0,
			totalEmbeddings: 0,
			totalGraphEdges: 0,
			message: backend === "off"
				? "Memory backend is off. Set memory.backend in OMP settings."
				: "Mnemopi directory not found. Start a session with memory enabled first.",
		};
	}

	const dbPaths = findMnemopiDbs(dir);
	if (dbPaths.length === 0) {
		return {
			backend,
			available: false,
			agentDir: dir,
			memoryDir,
			banks: [],
			totalWorking: 0,
			totalEpisodic: 0,
			totalFacts: 0,
			totalEmbeddings: 0,
			totalGraphEdges: 0,
			message: "No Mnemopi databases found yet.",
		};
	}

	const banks = dbPaths.map((p) => summarizeBank(p, dir));
	const totals = banks.reduce(
		(acc, b) => ({
			working: acc.working + b.workingCount,
			episodic: acc.episodic + b.episodicCount,
			facts: acc.facts + b.factCount,
			embeddings: acc.embeddings + b.embeddingCount,
			edges: acc.edges + b.graphEdgeCount,
		}),
		{ working: 0, episodic: 0, facts: 0, embeddings: 0, edges: 0 },
	);

	return {
		backend,
		available: true,
		agentDir: dir,
		memoryDir,
		banks,
		totalWorking: totals.working,
		totalEpisodic: totals.episodic,
		totalFacts: totals.facts,
		totalEmbeddings: totals.embeddings,
		totalGraphEdges: totals.edges,
	};
}

/**
 * Text search across all Mnemopi banks using the FTS tables.
 * Falls back to LIKE on working_memory.content if FTS is unavailable.
 */
export function searchMemories(agentDir: string, query: string, limit = 50): { items: MemoryItem[] } {
	const dir = agentDir || resolveAgentDir();
	const dbPaths = findMnemopiDbs(dir);
	const ranked: Array<{ item: MemoryItem; rank: number }> = [];

	for (const dbPath of dbPaths) {
		const bank = bankNameFromPath(dbPath);
		let db: Database;
		try {
			db = openDbReadonly(dbPath);
		} catch (err) {
			log.warn("failed to open bank DB for search", { dbPath, error: String(err) });
			continue;
		}
		try {
			const ftsQuery = query.trim().split(/\s+/).filter(Boolean).map((t) => `"${t.replace(/"/g, '""')}"`).join(" ");
			let rows: RawWorkingMemoryRow[];
			let ftsRanked = false;

			if (ftsQuery) {
				// Try FTS first; preserve returned id order within this bank.
				try {
					const ftsIds = db
						.query("SELECT id FROM fts_working WHERE fts_working MATCH ? LIMIT ?")
						.all(ftsQuery, limit) as FtsRow[];
					if (ftsIds.length > 0) {
						ftsRanked = true;
						const placeholders = ftsIds.map(() => "?").join(",");
						// No ORDER BY — let the FTS id list order be preserved
						// by reconstructing in ftsIds sequence below.
						const rawRows = db
							.query(`SELECT * FROM working_memory WHERE id IN (${placeholders})`)
							.all(...ftsIds.map((r) => r.id)) as RawWorkingMemoryRow[];
						const byId = new Map(rawRows.map((r) => [r.id, r]));
						rows = ftsIds.map((f) => byId.get(f.id)).filter((r): r is RawWorkingMemoryRow => r !== undefined);
					} else {
						rows = [];
					}
				} catch {
					// FTS not available — LIKE fallback with escaped wildcards.
					const escaped = query.replace(/[%_\\]/g, "\\$&");
					rows = db
						.query("SELECT * FROM working_memory WHERE content LIKE ? ESCAPE '\\' ORDER BY importance DESC LIMIT ?")
						.all(`%${escaped}%`, limit) as RawWorkingMemoryRow[];
				}
			} else {
				rows = db
					.query("SELECT * FROM working_memory ORDER BY importance DESC, timestamp DESC LIMIT ?")
					.all(limit) as RawWorkingMemoryRow[];
			}

			for (const row of rows) {
				const trimmed = trimMemoryContent(row.content);
				ranked.push({
					item: {
						id: row.id,
						content: trimmed.content,
						...(trimmed.truncated ? { contentTruncated: true } : {}),
						source: row.source ?? undefined,
						timestamp: row.timestamp ?? undefined,
						importance: row.importance ?? undefined,
						memoryType: row.memory_type ?? undefined,
						bank,
						recallCount: row.recall_count ?? undefined,
						supersededBy: row.superseded_by,
					},
					rank: ftsRanked ? 0 : 1,
				});
			}
		} catch (err) {
			log.warn("search failed for bank", { bank, error: String(err) });
		} finally {
			db.close();
		}
	}

	// Cross-bank merge: FTS-ranked results first (rank 0), then importance (rank 1).
	ranked.sort((a, b) => {
		if (a.rank !== b.rank) return a.rank - b.rank;
		return (b.item.importance ?? 0) - (a.item.importance ?? 0);
	});

	return { items: ranked.slice(0, limit).map((r) => r.item) };
}

function clampGraphLimit(limit: number | undefined): number {
	if (typeof limit !== "number" || !Number.isFinite(limit)) return MEMORY_GRAPH_DEFAULT_LIMIT;
	return Math.min(Math.max(Math.trunc(limit), 1), MEMORY_GRAPH_MAX_LIMIT);
}

function graphNodeId(bank: string, memoryId: string): string {
	return `${bank}:${memoryId}`;
}

function selectKnownColumn(columns: Set<string>, candidates: string[]): string | null {
	for (const candidate of candidates) {
		if (columns.has(candidate)) return candidate;
	}
	return null;
}

function listTableColumns(db: Database, table: string): Set<string> {
	try {
		const rows = db.query(`PRAGMA table_info("${table}")`).all() as ColumnInfoRow[];
		return new Set(rows.map((row) => row.name));
	} catch {
		return new Set();
	}
}

function loadGraphEdgeRows(db: Database): RawGraphEdgeRow[] {
	const columns = listTableColumns(db, "graph_edges");
	const sourceColumn = selectKnownColumn(columns, GRAPH_EDGE_COLUMN_CANDIDATES.source);
	const targetColumn = selectKnownColumn(columns, GRAPH_EDGE_COLUMN_CANDIDATES.target);
	if (!sourceColumn || !targetColumn) return [];
	const relationColumn = selectKnownColumn(columns, GRAPH_EDGE_COLUMN_CANDIDATES.relation);
	const weightColumn = selectKnownColumn(columns, GRAPH_EDGE_COLUMN_CANDIDATES.weight);
	const relationExpr = relationColumn ? `"${relationColumn}"` : "NULL";
	const weightExpr = weightColumn ? `"${weightColumn}"` : "NULL";
	try {
		return db
			.query(`SELECT "${sourceColumn}" as source, "${targetColumn}" as target, ${relationExpr} as relation, ${weightExpr} as weight FROM graph_edges LIMIT ?`)
			.all(MEMORY_GRAPH_MAX_LIMIT) as RawGraphEdgeRow[];
	} catch {
		return [];
	}
}

function loadWorkingRowsForGraph(db: Database, query: string, scanLimit: number): RawWorkingMemoryRow[] {
	const ftsQuery = query.trim().split(/\s+/).filter(Boolean).map((t) => `"${t.replace(/"/g, '""')}"`).join(" ");
	if (!ftsQuery) {
		return db
			.query("SELECT * FROM working_memory ORDER BY importance DESC, timestamp DESC LIMIT ?")
			.all(scanLimit) as RawWorkingMemoryRow[];
	}

	try {
		const ftsIds = db
			.query("SELECT id FROM fts_working WHERE fts_working MATCH ? LIMIT ?")
			.all(ftsQuery, scanLimit) as FtsRow[];
		if (ftsIds.length === 0) return [];
		const placeholders = ftsIds.map(() => "?").join(",");
		const rawRows = db
			.query(`SELECT * FROM working_memory WHERE id IN (${placeholders})`)
			.all(...ftsIds.map((row) => row.id)) as RawWorkingMemoryRow[];
		const byId = new Map(rawRows.map((row) => [row.id, row]));
		return ftsIds.map((row) => byId.get(row.id)).filter((row): row is RawWorkingMemoryRow => row !== undefined);
	} catch {
		const escaped = query.replace(/[%_\\]/g, "\\$&");
		return db
			.query("SELECT * FROM working_memory WHERE content LIKE ? ESCAPE '\\' ORDER BY importance DESC LIMIT ?")
			.all(`%${escaped}%`, scanLimit) as RawWorkingMemoryRow[];
	}
}

function stringFromRow(row: SqliteRow | undefined, key: string): string | undefined {
	const value = row?.[key];
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberFromRow(row: SqliteRow | undefined, key: string): number | undefined {
	const value = row?.[key];
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function loadRowById(db: Database, table: string, idColumn: string, id: string): SqliteRow | undefined {
	try {
		return db.query(`SELECT * FROM "${table}" WHERE "${idColumn}" = ? LIMIT 1`).get(id) as SqliteRow | undefined;
	} catch {
		return undefined;
	}
}

function contentFromFactRow(row: SqliteRow | undefined, fallback: string): string {
	const subject = stringFromRow(row, "subject");
	const predicate = stringFromRow(row, "predicate");
	const object = stringFromRow(row, "object");
	const triple = [subject, predicate, object].filter(Boolean).join(" ");
	return triple || fallback;
}

function resolveEndpointNode(db: Database, bank: string, memoryId: string, workingRows: Map<string, RawWorkingMemoryRow>): MemoryGraphNode {
	const working = workingRows.get(memoryId);
	if (working) return toGraphNode(bank, working);
	const workingDirect = loadRowById(db, "working_memory", "id", memoryId) as RawWorkingMemoryRow | undefined;
	if (workingDirect && workingDirect.content) return toGraphNode(bank, workingDirect);

	const episodic = loadRowById(db, "episodic_memory", "id", memoryId);
	if (episodic) {
		const content = stringFromRow(episodic, "content") ?? memoryId;
		const trimmed = trimMemoryContent(content);
		return {
			id: graphNodeId(bank, memoryId),
			memoryId,
			bank,
			kind: "episodic",
			content: trimmed.content,
			...(trimmed.truncated ? { contentTruncated: true } : {}),
			importance: numberFromRow(episodic, "importance"),
			memoryType: stringFromRow(episodic, "memory_type"),
			timestamp: stringFromRow(episodic, "timestamp"),
			recallCount: numberFromRow(episodic, "recall_count"),
			inbound: 0,
			outbound: 0,
		};
	}

	const fact = loadRowById(db, "facts", "fact_id", memoryId);
	if (fact) {
		return {
			id: graphNodeId(bank, memoryId),
			memoryId,
			bank,
			kind: "fact",
			content: contentFromFactRow(fact, memoryId),
			timestamp: stringFromRow(fact, "timestamp"),
			inbound: 0,
			outbound: 0,
		};
	}

	return {
		id: graphNodeId(bank, memoryId),
		memoryId,
		bank,
		kind: "reference",
		content: memoryId,
		inbound: 0,
		outbound: 0,
	};
}

function toGraphNode(bank: string, row: RawWorkingMemoryRow): MemoryGraphNode {
	const trimmed = trimMemoryContent(row.content);
	return {
		id: graphNodeId(bank, row.id),
		memoryId: row.id,
		bank,
		kind: "working",
		content: trimmed.content,
		...(trimmed.truncated ? { contentTruncated: true } : {}),
		importance: row.importance ?? undefined,
		memoryType: row.memory_type ?? undefined,
		timestamp: row.timestamp ?? undefined,
		recallCount: row.recall_count ?? undefined,
		inbound: 0,
		outbound: 0,
	};
}

function bumpDegrees(nodes: Map<string, MemoryGraphNode>, edge: MemoryGraphEdge): void {
	const source = nodes.get(edge.source);
	if (source) source.outbound += 1;
	const target = nodes.get(edge.target);
	if (target) target.inbound += 1;
}

function parseSummaryIds(summaryOf: string | null): string[] {
	if (!summaryOf) return [];
	return summaryOf.split(",").map((s) => s.trim()).filter(Boolean);
}

/** Cosine similarity between two equal-or-differing-length float vectors. */
function cosineSimilarity(a: number[], b: number[]): number {
	const len = Math.min(a.length, b.length);
	if (len === 0) return 0;
	let dot = 0;
	let normA = 0;
	let normB = 0;
	for (let i = 0; i < len; i++) {
		const ai = a[i] ?? 0;
		const bi = b[i] ?? 0;
		dot += ai * bi;
		normA += ai * ai;
		normB += bi * bi;
	}
	const denom = Math.sqrt(normA) * Math.sqrt(normB);
	return denom === 0 ? 0 : dot / denom;
}

function loadDerivedEdges(
	db: Database,
	bank: string,
	query: string,
	seedNodeIds: Set<string>,
	candidateMap: Map<string, MemoryGraphNode>,
	workingRows: Map<string, RawWorkingMemoryRow>,
): MemoryGraphEdge[] {
	const derived: MemoryGraphEdge[] = [];

	let episodicRows: RawEpisodicGraphRow[] = [];
	try {
		episodicRows = db.query("SELECT id, content, summary_of, importance, timestamp FROM episodic_memory LIMIT ?").all(MEMORY_GRAPH_MAX_LIMIT) as RawEpisodicGraphRow[];
	} catch {
		// episodic_memory may not have these columns
	}
	for (const ep of episodicRows) {
		const epNodeId = graphNodeId(bank, ep.id);
		const trimmed = trimMemoryContent(ep.content ?? ep.id);
		const epNode: MemoryGraphNode = {
			id: epNodeId,
			memoryId: ep.id,
			bank,
			kind: "episodic",
			content: trimmed.content,
			...(trimmed.truncated ? { contentTruncated: true } : {}),
			importance: ep.importance ?? undefined,
			timestamp: ep.timestamp ?? undefined,
			inbound: 0,
			outbound: 0,
		};
		if (!query && !candidateMap.has(epNodeId)) candidateMap.set(epNodeId, epNode);
		for (const targetId of parseSummaryIds(ep.summary_of)) {
			const targetNodeId = graphNodeId(bank, targetId);
			if (query && !seedNodeIds.has(epNodeId) && !seedNodeIds.has(targetNodeId)) continue;
			if (!candidateMap.has(epNodeId)) candidateMap.set(epNodeId, epNode);
			if (!candidateMap.has(targetNodeId)) candidateMap.set(targetNodeId, resolveEndpointNode(db, bank, targetId, workingRows));
			derived.push({ source: epNodeId, target: targetNodeId, bank, relation: "summarizes", weight: 1 });
		}
	}

	let factRows: RawFactGraphRow[] = [];
	try {
		factRows = db.query("SELECT fact_id, source_msg_id, subject, predicate, object, confidence, timestamp FROM facts LIMIT ?").all(MEMORY_GRAPH_MAX_LIMIT) as RawFactGraphRow[];
	} catch {
		// facts may not have these columns
	}
	for (const fact of factRows) {
		const factNodeId = graphNodeId(bank, fact.fact_id);
		const triple = [fact.subject, fact.predicate, fact.object].filter(Boolean).join(" ");
		const factNode: MemoryGraphNode = {
			id: factNodeId,
			memoryId: fact.fact_id,
			bank,
			kind: "fact",
			content: trimMemoryContent(triple || fact.fact_id).content,
			timestamp: fact.timestamp ?? undefined,
			inbound: 0,
			outbound: 0,
		};
		if (!query && !candidateMap.has(factNodeId)) candidateMap.set(factNodeId, factNode);
		if (!fact.source_msg_id) continue;
		const targetNodeId = graphNodeId(bank, fact.source_msg_id);
		if (query && !seedNodeIds.has(factNodeId) && !seedNodeIds.has(targetNodeId)) continue;
		if (!candidateMap.has(factNodeId)) candidateMap.set(factNodeId, factNode);
		if (!candidateMap.has(targetNodeId)) candidateMap.set(targetNodeId, resolveEndpointNode(db, bank, fact.source_msg_id, workingRows));
		derived.push({ source: factNodeId, target: targetNodeId, bank, relation: "extracted_from", weight: fact.confidence ?? 0.7 });
	}


	// ─── Same-session edges ───────────────────────────────────────────
	// Connect working memories sharing a session_id (excludes the generic
	// "default" session). Weak weight; capped per session to avoid explosion.
	const bySession = new Map<string, RawWorkingMemoryRow[]>();
	for (const row of workingRows.values()) {
		const sid = row.session_id;
		if (!sid || sid === "default") continue;
		const group = bySession.get(sid);
		if (group) group.push(row);
		else bySession.set(sid, [row]);
	}
	for (const [, members] of bySession) {
		if (members.length < 2) continue;
		members.sort((a, b) => (a.timestamp ?? "").localeCompare(b.timestamp ?? ""));
		const edgeCount = Math.min(SAME_SESSION_MAX_EDGES_PER_SESSION, members.length - 1);
		for (let i = 0; i < edgeCount; i++) {
			const memberA = members[i];
			const memberB = members[i + 1];
			if (!memberA || !memberB) continue;
			derived.push({ source: graphNodeId(bank, memberA.id), target: graphNodeId(bank, memberB.id), bank, relation: "same_session", weight: SAME_SESSION_WEIGHT });
		}
	}

	// ─── Entity overlap edges (triples + memoria_kg) ──────────────────
	// Memories that are sources of triples sharing the same subject.
	const entitySources = new Map<string, Map<string, number>>();
	let tripleRows: RawTripleRow[] = [];
	try {
		tripleRows = db.query("SELECT subject, source, confidence FROM triples WHERE subject IS NOT NULL LIMIT ?").all(MEMORY_GRAPH_MAX_LIMIT) as RawTripleRow[];
	} catch {
		// triples table may not exist
	}
	let kgRows: RawKgRow[] = [];
	try {
		kgRows = db.query("SELECT subject, source_memory_id, confidence FROM memoria_kg WHERE subject IS NOT NULL LIMIT ?").all(MEMORY_GRAPH_MAX_LIMIT) as RawKgRow[];
	} catch {
		// memoria_kg table may not exist
	}
	for (const { subject, source, confidence } of tripleRows) {
		if (!source) continue;
		let group = entitySources.get(subject);
		if (!group) { group = new Map(); entitySources.set(subject, group); }
		const conf = confidence ?? 0.7;
		const prev = group.get(source);
		if (prev === undefined || conf > prev) group.set(source, conf);
	}
	for (const row of kgRows) {
		if (!row.subject || !row.source_memory_id) continue;
		let group = entitySources.get(row.subject);
		if (!group) { group = new Map(); entitySources.set(row.subject, group); }
		const conf = row.confidence ?? 0.7;
		const prev = group.get(row.source_memory_id);
		if (prev === undefined || conf > prev) group.set(row.source_memory_id, conf);
	}
	for (const [, sources] of entitySources) {
		if (sources.size < 2) continue;
		const entries = Array.from(sources.entries());
		for (let i = 0; i < entries.length; i++) {
			for (let j = i + 1; j < entries.length; j++) {
				const entryA = entries[i];
				const entryB = entries[j];
				if (!entryA || !entryB) continue;
				const [idA, confA] = entryA;
				const [idB, confB] = entryB;
				const nodeA = graphNodeId(bank, idA);
				const nodeB = graphNodeId(bank, idB);
				if (query && !seedNodeIds.has(nodeA) && !seedNodeIds.has(nodeB)) continue;
				if (!candidateMap.has(nodeA)) candidateMap.set(nodeA, resolveEndpointNode(db, bank, idA, workingRows));
				if (!candidateMap.has(nodeB)) candidateMap.set(nodeB, resolveEndpointNode(db, bank, idB, workingRows));
				const [src, tgt] = nodeA < nodeB ? [nodeA, nodeB] : [nodeB, nodeA];
				derived.push({ source: src, target: tgt, bank, relation: "shares_entity", weight: Math.min(confA, confB) });
			}
		}
	}

	// ─── Embedding similarity edges ───────────────────────────────────
	// Compute cosine similarity between all embedding pairs above threshold.
	let embeddingRows: RawEmbeddingRow[] = [];
	try {
		embeddingRows = db.query("SELECT memory_id, embedding_json FROM memory_embeddings LIMIT ?").all(MEMORY_GRAPH_MAX_LIMIT) as RawEmbeddingRow[];
	} catch {
		// memory_embeddings table may not exist
	}
	const embeddings: { memoryId: string; vector: number[] }[] = [];
	for (const row of embeddingRows) {
		try {
			const parsed = JSON.parse(row.embedding_json);
			if (Array.isArray(parsed) && parsed.length > 0 && parsed.every((v: unknown) => typeof v === "number" && Number.isFinite(v))) {
				embeddings.push({ memoryId: row.memory_id, vector: parsed });
			}
		} catch {
			// malformed embedding_json — skip
		}
	}
	for (let i = 0; i < embeddings.length; i++) {
		for (let j = i + 1; j < embeddings.length; j++) {
			const embA = embeddings[i];
			const embB = embeddings[j];
			if (!embA || !embB) continue;
			const sim = cosineSimilarity(embA.vector, embB.vector);
			if (sim < SIMILARITY_THRESHOLD) continue;
			const nodeA = graphNodeId(bank, embA.memoryId);
			const nodeB = graphNodeId(bank, embB.memoryId);
			if (query && !seedNodeIds.has(nodeA) && !seedNodeIds.has(nodeB)) continue;
			if (!candidateMap.has(nodeA)) candidateMap.set(nodeA, resolveEndpointNode(db, bank, embA.memoryId, workingRows));
			if (!candidateMap.has(nodeB)) candidateMap.set(nodeB, resolveEndpointNode(db, bank, embB.memoryId, workingRows));
			const [src, tgt] = nodeA < nodeB ? [nodeA, nodeB] : [nodeB, nodeA];
			derived.push({ source: src, target: tgt, bank, relation: "similar", weight: sim });
		}
	}
	return derived;
}

export function getMemoryGraph(agentDir: string, options: MemoryGraphOptions = {}): MemoryGraphResponse {
	const dir = agentDir || resolveAgentDir();
	const query = options.query?.trim() ?? "";
	const limit = clampGraphLimit(options.limit);
	const dbPaths = findMnemopiDbs(dir);
	const selectedDbPaths = options.bank ? dbPaths.filter((dbPath) => bankNameFromPath(dbPath) === options.bank) : dbPaths;
	const candidateMap = new Map<string, MemoryGraphNode>();
	const candidateRows = new Map<string, RawWorkingMemoryRow>();
	const rawEdges: MemoryGraphEdge[] = [];

	for (const dbPath of selectedDbPaths) {
		const bank = bankNameFromPath(dbPath);
		let db: Database;
		try {
			db = openDbReadonly(dbPath);
		} catch (err) {
			log.warn("failed to open bank DB for graph", { dbPath, error: String(err) });
			continue;
		}
		try {
			const rows = loadWorkingRowsForGraph(db, query, MEMORY_GRAPH_MAX_LIMIT);
			const workingRows = new Map(rows.map((row) => [row.id, row]));
			const seedNodeIds = new Set(rows.map((row) => graphNodeId(bank, row.id)));
			for (const row of rows) {
				const node = toGraphNode(bank, row);
				candidateRows.set(node.id, row);
				candidateMap.set(node.id, node);
			}
			for (const edge of loadGraphEdgeRows(db)) {
				const source = graphNodeId(bank, edge.source);
				const target = graphNodeId(bank, edge.target);
				if (query && !seedNodeIds.has(source) && !seedNodeIds.has(target)) continue;
				if (!candidateMap.has(source)) candidateMap.set(source, resolveEndpointNode(db, bank, edge.source, workingRows));
				if (!candidateMap.has(target)) candidateMap.set(target, resolveEndpointNode(db, bank, edge.target, workingRows));
				rawEdges.push({
					source,
					target,
					bank,
					relation: edge.relation ?? "related",
					...(typeof edge.weight === "number" ? { weight: edge.weight } : {}),
				});
			}
			rawEdges.push(...loadDerivedEdges(db, bank, query, seedNodeIds, candidateMap, workingRows));
		} catch (err) {
			log.warn("graph build failed for bank", { bank, error: String(err) });
		} finally {
			db.close();
		}
	}

	const candidates = Array.from(candidateMap.values());
	candidates.sort((a, b) => (b.importance ?? 0) - (a.importance ?? 0));
	const nodes = candidates.slice(0, limit);
	const nodeIds = new Set(nodes.map((node) => node.id));
	const edges: MemoryGraphEdge[] = [];

	for (const node of nodes) {
		const row = candidateRows.get(node.id);
		if (!row?.superseded_by) continue;
		const target = graphNodeId(node.bank, row.superseded_by);
		if (!nodeIds.has(target)) continue;
		edges.push({ source: node.id, target, bank: node.bank, relation: "supersedes", weight: 1 });
	}

	for (const edge of rawEdges) {
		if (!nodeIds.has(edge.source) || !nodeIds.has(edge.target)) continue;
		edges.push(edge);
	}

	const nodeMap = new Map(nodes.map((node) => [node.id, node]));
	for (const edge of edges) bumpDegrees(nodeMap, edge);

	return {
		query,
		...(options.bank ? { bank: options.bank } : {}),
		nodes,
		edges,
		totalNodes: candidates.length,
		truncated: candidates.length > nodes.length,
	};
}
