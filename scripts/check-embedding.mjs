#!/usr/bin/env bun
/**
 * Diagnostic script for omp-deck topology embedding setup.
 *
 * Usage:
 *   bun scripts/check-embedding.mjs
 *
 * It reads the managed env file and (if a key is present) sends a single
 * test embedding request to the configured endpoint. It never prints the
 * raw API key; it only reports whether a key is set.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { Database } from "bun:sqlite";

function getDataDir() {
	const explicit = process.env.OMP_DECK_DATA_DIR?.trim();
	if (explicit) return path.resolve(explicit);
	if (process.platform === "win32") {
		const local = process.env.LOCALAPPDATA?.trim() || path.join(os.homedir(), "AppData", "Local");
		return path.join(local, "omp-deck");
	}
	const xdg = process.env.XDG_CONFIG_HOME?.trim();
	return path.join(xdg ? path.resolve(xdg) : path.join(os.homedir(), ".config"), "omp-deck");
}

function readEnvFile() {
	const filePath = path.join(getDataDir(), ".env");
	const map = new Map();
	try {
		const text = fs.readFileSync(filePath, "utf8");
		for (const line of text.split(/\r?\n/)) {
			const idx = line.indexOf("=");
			if (idx <= 0) continue;
			const key = line.slice(0, idx).trim();
			const value = line.slice(idx + 1).trim();
			if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) map.set(key, value);
		}
	} catch (err) {
		if (err.code !== "ENOENT") throw err;
	}
	return { filePath, map };
}

function getEnv(map, key) {
	return process.env[key] ?? map.get(key) ?? "";
}

function mask(value) {
	if (!value) return "<empty>";
	if (value.length <= 8) return "<set>";
	return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

async function testEndpoint(baseUrl, endpointPath, apiKey, model) {
	const url = `${baseUrl.replace(/\/$/, "")}${endpointPath.startsWith("/") ? endpointPath : `/${endpointPath}`}`;
	const start = performance.now();
	const res = await fetch(url, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
		},
		body: JSON.stringify({
			model,
			input: ["测试", "test"],
		}),
	});
	const latency = Math.round(performance.now() - start);
	if (!res.ok) {
		const text = await res.text();
		return { ok: false, status: res.status, latency, error: text.slice(0, 200) };
	}
	const data = await res.json();
	const vectors = data?.data;
	if (!Array.isArray(vectors) || vectors.length !== 2) {
		return { ok: false, status: res.status, latency, error: "unexpected response shape", data };
	}
	return {
		ok: true,
		status: res.status,
		latency,
		dimension: vectors[0]?.embedding?.length ?? "unknown",
		model: data?.model ?? model,
	};
}

function resolveDbPath() {
	const dataDir = process.env.OMP_DECK_DATA_DIR?.trim();
	if (dataDir) return path.join(path.resolve(dataDir), "deck.db");
	// When run from the repo root, use the local data dir.
	const local = path.join(process.cwd(), "data", "deck.db");
	if (fs.existsSync(local)) return local;
	return path.join(getDataDir(), "deck.db");
}

function checkDb() {
	const dbPath = resolveDbPath();
	if (!fs.existsSync(dbPath)) return { exists: false, path: dbPath, rows: 0 };
	const db = new Database(dbPath, { readonly: true });
	try {
		const table = db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='session_context_node_embeddings'").get();
		if (!table) return { exists: true, path: dbPath, rows: 0, tableExists: false };
		const { count } = db.query("SELECT COUNT(*) AS count FROM session_context_node_embeddings").get();
		const { node_count } = db.query("SELECT COUNT(DISTINCT node_id) AS node_count FROM session_context_node_embeddings").get();
		return { exists: true, path: dbPath, rows: count ?? 0, distinctNodes: node_count ?? 0, tableExists: true };
	} finally {
		db.close();
	}
}

const { filePath, map } = readEnvFile();
const enabled = getEnv(map, "OMP_DECK_TOPOLOGY_EMBEDDING_ENABLED").trim().toLowerCase();
const baseUrl = getEnv(map, "OMP_DECK_TOPOLOGY_EMBEDDING_BASE_URL").trim();
const apiKey = getEnv(map, "OMP_DECK_TOPOLOGY_EMBEDDING_API_KEY").trim();
const model = getEnv(map, "OMP_DECK_TOPOLOGY_EMBEDDING_MODEL").trim() || "BAAI/bge-large-zh-v1.5";
const endpointPath = getEnv(map, "OMP_DECK_TOPOLOGY_EMBEDDING_ENDPOINT_PATH").trim() || "/embeddings";

console.log(`Managed env file: ${filePath}`);
console.log(`Embedding enabled: ${enabled || "<unset>"}`);
console.log(`Base URL:          ${baseUrl || "<unset>"}`);
console.log(`API key:           ${mask(apiKey)}`);
console.log(`Model:             ${model}`);
console.log(`Endpoint path:     ${endpointPath}`);
console.log();

if (!enabled || !["1", "true", "yes"].includes(enabled)) {
	console.log("❌ Embedding is NOT enabled. Set OMP_DECK_TOPOLOGY_EMBEDDING_ENABLED=1 and restart the server.");
	process.exit(1);
}
if (!baseUrl) {
	console.log("❌ Base URL missing. Set OMP_DECK_TOPOLOGY_EMBEDDING_BASE_URL.");
	process.exit(1);
}

console.log("→ Testing embedding endpoint...");
const result = await testEndpoint(baseUrl, endpointPath, apiKey, model);
if (!result.ok) {
	console.log(`❌ Endpoint test failed: HTTP ${result.status} (${result.latency}ms)`);
	console.log(`   ${result.error}`);
	process.exit(1);
}

console.log(`✅ Endpoint OK: HTTP ${result.status} (${result.latency}ms)`);
console.log(`   Model returned: ${result.model}`);
console.log(`   Vector dimension: ${result.dimension}`);
console.log();

const db = checkDb();
if (!db.exists) {
	console.log(`❌ DB not found at ${db.path}. Is the server running?`);
	process.exit(1);
}
if (!db.tableExists) {
	console.log(`❌ Embedding table missing in ${db.path}. Restart the server to run migrations.`);
	process.exit(1);
}
console.log(`✅ DB: ${db.path}`);
console.log(`✅ DB embedding table: ${db.rows} rows across ${db.distinctNodes ?? "?"} nodes`);
