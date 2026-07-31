/**
 * Shared auto-rebuild state machine for session topology.
 * Used by both the RPC and in-process bridges.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { getSessionContextStatus } from "../db/session-context.ts";
import { logger } from "../log.ts";
import { rebuildSessionContextFromFile } from "../session-context.ts";
import { createPooledTopologyExtractorClient, SYSTEM_PROMPT, type TopologyExtractorModelClient, type TopologyExtractorPoolSlot } from "../topology-extractor.ts";

const log = logger("auto-rebuild");

export interface AutoRebuildCheckpoint {
	built: boolean;
	sourceMtimeMs?: number;
	sourceSizeBytes?: number;
}

export interface AutoRebuildDeps {
	readonly sessionId: string;
	getSessionFile: () => string | undefined;
	statFile: (p: string) => Promise<{ mtimeMs: number; size: number }>;
	getCheckpoint: (sid: string) => AutoRebuildCheckpoint;
	rebuild: (sid: string, f: string) => Promise<void>;
	sleep: (ms: number) => Promise<void>;
}

export class AutoRebuildTopology {
	#inFlight = false;
	#pending = false;
	readonly #deps: AutoRebuildDeps;

	constructor(deps: AutoRebuildDeps) {
		this.#deps = deps;
	}

	trigger(): Promise<void> {
		return this.#run();
	}

	maybeTrigger(): void {
		void this.#run();
	}

	async #run(): Promise<void> {
		if (this.#inFlight) {
			this.#pending = true;
			return;
		}
		this.#inFlight = true;
		try {
			do {
				this.#pending = false;
				const sessionFile = this.#deps.getSessionFile();
				if (!sessionFile) break;
				let stale = true;
				try {
					const stat = await this.#deps.statFile(sessionFile);
					const checkpoint = this.#deps.getCheckpoint(this.#deps.sessionId);
					if (checkpoint.built && checkpoint.sourceMtimeMs === Math.trunc(stat.mtimeMs) && checkpoint.sourceSizeBytes === stat.size) {
						stale = false;
					}
				} catch {
					stale = false;
				}
				if (stale) {
					await this.#deps.sleep(500);
					await this.#deps.rebuild(this.#deps.sessionId, sessionFile);
				}
			} while (this.#pending);
		} catch (err) {
			log.debug(`auto-rebuild skip ${String(err)}`);
		} finally {
			this.#inFlight = false;
		}
	}
}

export function createAutoRebuildTopology(deps: { sessionId: string; getSessionFile: () => string | undefined }): AutoRebuildTopology {
	const extractorClient = createExtractorPool();
	return new AutoRebuildTopology({
		...deps,
		statFile: (p) => Bun.file(p).stat(),
		getCheckpoint: (id) => getSessionContextStatus(id),
		rebuild: (id, f) => rebuildSessionContextFromFile({
			sessionId: id,
			sessionFile: f,
			extractorClient: extractorClient ?? undefined,
			extractorModelRole: extractorClient ? "topology_extractor" : undefined,
		}).then(() => {}),
		sleep: (ms) => Bun.sleep(ms),
	});
}

export function createExtractorPool(): TopologyExtractorModelClient | null {
	const mode = (process.env.OMP_DECK_TOPOLOGY_EXTRACTION_MODE ?? "regex").toLowerCase();
	if (mode !== "fast_model") {
		// Deterministic regex extraction only — no model pool. Matches the
		// env-schema contract ("regex (default, deterministic)").
		return null;
	}
	const slots: TopologyExtractorPoolSlot[] = [];
	const chunkSize = Number.parseInt(process.env.OMP_DECK_TOPOLOGY_EXTRACTION_BATCH_SIZE ?? "5", 10) || 5;

	// DeepSeek v4 flash — cheap, fast cloud model for node extraction.
	// Uses the same API shape as oMLX/SF (OpenAI-compatible chat completions).
	const dsKey = process.env.OMP_DECK_TOPOLOGY_EXTRACTION_API_KEY;
	if (dsKey) {
		const dsConcurrency = Math.max(1, Number.parseInt(process.env.OMP_DECK_TOPOLOGY_EXTRACTION_CONCURRENCY ?? "4", 10) || 4);
		slots.push({
			label: "ds",
			client: createHttpExtractor({
				baseUrl: process.env.OMP_DECK_TOPOLOGY_EXTRACTION_BASE_URL ?? "https://api.deepseek.com",
				model: process.env.OMP_DECK_TOPOLOGY_EXTRACTION_MODEL ?? "deepseek-v4-flash",
				apiKey: dsKey,
				endpointPath: process.env.OMP_DECK_TOPOLOGY_EXTRACTION_ENDPOINT_PATH ?? "/chat/completions",
				customSystemPrompt: SYSTEM_PROMPT,
				extraBody: { max_tokens: Number.parseInt(process.env.OMP_DECK_TOPOLOGY_EXTRACTION_MAX_TOKENS ?? "8000", 10) || 8000 },
			}),
			maxConcurrency: dsConcurrency,
		});
	}

	if (slots.length === 0) return null;
	log.info(`extractor pool slots=${slots.length} (${slots.map((s) => `${s.label}@${s.maxConcurrency}`).join(",")}) chunk=${chunkSize}`);
	const maxBytes = 120_000;
	return createPooledTopologyExtractorClient({
		slots,
		chunkSize,
		...(Number.isFinite(maxBytes) && maxBytes > 0 ? { maxChunkBytes: maxBytes } : {}),
	});
}

function createHttpExtractor(opts: { baseUrl: string; model: string; apiKey: string; noSystemPrompt?: boolean; endpointPath?: string; customSystemPrompt?: string; extraBody?: Record<string, unknown> }): TopologyExtractorModelClient {
	return {
		async extractNodes({ prompt, timeoutMs }): Promise<unknown> {
			const endpointPath = opts.endpointPath ?? "/v1/chat/completions";
			const res = await fetch(`${opts.baseUrl}${endpointPath}`, {
				method: "POST",
				headers: { Authorization: `Bearer ${opts.apiKey}`, "Content-Type": "application/json" },
			body: JSON.stringify({
				model: opts.model,
				temperature: 0,
				...(opts.extraBody ?? {}),
				messages: opts.noSystemPrompt
					? [{ role: "user", content: `${TINY_MODEL_PROMPT}\n\n${prompt}` }]
					: [
						{ role: "system", content: opts.customSystemPrompt ?? SYSTEM_PROMPT },
						{ role: "user", content: prompt },
					],
			}),
			signal: AbortSignal.timeout(Math.max(1, timeoutMs)),
		});
			if (!res.ok) return undefined;
			const data = await res.json() as { choices?: Array<{ message?: { content?: string } }> };
			const content = data.choices?.[0]?.message?.content;
			if (!content) return undefined;
			// Tiny models often wrap JSON in a markdown code fence.
			// Strip before parsing. Also remove lone backticks.
			const json = stripCodeFence(content.trim().replace(/`/g, ""));
			if (!json) return undefined;
			return JSON.parse(json);
		},
	};
}



const TINY_MODEL_PROMPT = `Classify each node as: evidence, issue, resolution, decision, goal, user_intent, or skip.
Return JSON: {"nodes":[{"id":"...","kind":"evidence|...","title":"...","body":"..."}]}`;

function stripCodeFence(text: string): string | null {
	// Match ```json...``` or ```...``` code fences
	const m = text.match(/^```(?:json)?\s*\n([\s\S]*?)\n\s*```$/);
	if (m) return m[1]!.trim();
	// Not wrapped in fence — return as-is
	return text;
}

function readOmlxApiKey(): string | null {
	try {
		const settingsPath = path.join(os.homedir(), ".omlx", "settings.json");
		return JSON.parse(fs.readFileSync(settingsPath, "utf-8"))?.auth?.api_key ?? null;
	} catch {
		return null;
	}
}
