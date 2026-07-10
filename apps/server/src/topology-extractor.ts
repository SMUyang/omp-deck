/**
 * LLM-based topology node refinement.
 *
 * After regex extraction produces initial nodes from JSONL, this module
 * sends the batch to the `topology_extractor` model role for refinement:
 * - Filter noise (internal markers, trivial output, duplicates)
 * - Reclassify misclassified nodes (e.g. "error" keyword in large content)
 * - Improve titles and compressed bodies
 *
 * One LLM call per rebuild — not per message.
 */

import type { SessionContextNode } from "@omp-deck/protocol";
import { logger } from "./log.ts";

const log = logger("topology-extractor");

export interface ExtractorNodeInput {
	id: string;
	kind: string;
	title: string;
	body: string;
	role: string;
}

export interface ExtractorNodeOutput {
	id: string;
	kind: string;
	title: string;
	body: string;
}

export interface TopologyExtractorModelClient {
	extractNodes(input: {
		modelRole: string;
		prompt: string;
		timeoutMs: number;
	}): Promise<unknown>;
}

export const SYSTEM_PROMPT = `You are refining topology nodes extracted from a coding agent session.
For each node, output a refined version or mark it "skip" to drop.

Classification rules:
- "goal": what the user wanted to achieve
- "user_intent": a correction or constraint the user imposed
- "decision": architectural or design choice
- "resolution": code or solution the assistant proposed
- "evidence": concrete tool results (file content, test output, command results)
- "issue": actual errors/failures (NOT just "error" keyword appearing in large content)
- "skip": noise — internal markers, "(no output)", "Skipped due to...", bare numbers, duplicates

Return JSON: { "nodes": [{ "id": "...", "kind": "evidence|issue|resolution|decision|goal|user_intent|skip", "title": "concise title (max 80 chars)", "body": "compressed body (max 300 chars)" }] }`;

export function buildExtractionPrompt(nodes: ExtractorNodeInput[]): string {
	return JSON.stringify(nodes, null, 2);
}

export interface TopologyExtractorPoolSlot {
	label: string;
	client: TopologyExtractorModelClient;
	maxConcurrency: number;
}

export interface TopologyExtractorPoolOptions {
	slots: TopologyExtractorPoolSlot[];
	chunkSize?: number;
	maxChunkBytes?: number;
}

export function createPooledTopologyExtractorClient(options: TopologyExtractorPoolOptions): TopologyExtractorModelClient {
	const slots = options.slots.filter((slot) => slot.maxConcurrency > 0);
	if (slots.length === 0) return { extractNodes: async () => undefined };
	const chunkSize = Math.max(1, options.chunkSize ?? 20);
	// 24KB serialized ≈ 6-8K tokens. Anything larger risks blowing the
	// 4bit/8bit oMLX resident set and the model's KV cache.
	const maxBytes = Math.max(1024, options.maxChunkBytes ?? 24_000);
	log.info(`extractor pool: ${slots.length} slots, chunk=${chunkSize}, maxBytes/chunk=${maxBytes}`);
	return {
		async extractNodes({ modelRole, prompt, timeoutMs }) {
			if (slots.length === 0) return undefined;
			let nodes: ExtractorNodeInput[];
			try {
				const parsed = JSON.parse(prompt) as unknown;
				if (!Array.isArray(parsed)) return undefined;
				nodes = parsed.filter(isExtractorNodeInput);
			} catch {
				return undefined;
			}
			if (nodes.length === 0) return undefined;

			const chunks: ExtractorNodeInput[][] = splitByBudget(nodes, chunkSize, maxBytes);
			log.info(`extractor pool start nodes=${nodes.length} chunks=${chunks.length}`);

			const queues = new Map<TopologyExtractorPoolSlot, ExtractorNodeInput[][]>();
			chunks.forEach((chunk, index) => {
				const slot = slots[index % slots.length]!;
				const queue = queues.get(slot) ?? [];
				queue.push(chunk);
				queues.set(slot, queue);
			});

			// Each slot has its own internal queue and respects maxConcurrency
			// locally. No global gate: the local slot is throttled to 2 to
			// bound on-device memory, while the fast/cloud slot fans out
			// wider since it has no local cost.
			const settled = await Promise.all(Array.from(queues.entries()).map(([slot, queue]) => runExtractorSlotQueue({ slot, queue, modelRole, timeoutMs })));
			const outputs = settled.flat();
			return outputs.length > 0 ? { nodes: outputs } : undefined;
		},
	};
}

function isExtractorNodeInput(value: unknown): value is ExtractorNodeInput {
	if (!isRecord(value)) return false;
	return typeof value.id === "string"
		&& typeof value.kind === "string"
		&& typeof value.title === "string"
		&& typeof value.body === "string"
		&& typeof value.role === "string";
}

async function runExtractorSlotQueue(input: {
	slot: TopologyExtractorPoolSlot;
	queue: ExtractorNodeInput[][];
	modelRole: string;
	timeoutMs: number;
}): Promise<ExtractorNodeOutput[]> {
	const results: ExtractorNodeOutput[] = [];
	const running = new Set<Promise<void>>();

	for (const chunk of input.queue) {
		const job = runExtractorChunk(input.slot, chunk, input.modelRole, input.timeoutMs, results)
			.finally(() => running.delete(job));
		running.add(job);
		if (running.size >= input.slot.maxConcurrency) await Promise.race(running);
	}
	await Promise.all(running);
	return results;
}

async function runExtractorChunk(
	slot: TopologyExtractorPoolSlot,
	chunk: ExtractorNodeInput[],
	modelRole: string,
	timeoutMs: number,
	results: ExtractorNodeOutput[],
): Promise<void> {
	try {
		const raw = await slot.client.extractNodes({ modelRole, prompt: buildExtractionPrompt(chunk), timeoutMs });
		const parsed = parseExtractionResponse(raw);
		if (parsed) { results.push(...parsed); } else { log.info(`extractor slot ${slot.label} chunk returned invalid/empty response`); }
	} catch (err) {
		log.info(`extractor slot ${slot.label} chunk failed: ${String(err)}`);
	}
}

function splitByBudget(nodes: ExtractorNodeInput[], maxCount: number, maxBytes: number): ExtractorNodeInput[][] {
	const out: ExtractorNodeInput[][] = [];
	let current: ExtractorNodeInput[] = [];
	let currentBytes = 0;
	for (const node of nodes) {
		const nodeBytes = approximateNodeBytes(node);
		if (current.length > 0 && (current.length >= maxCount || currentBytes + nodeBytes > maxBytes)) {
			out.push(current);
			current = [];
			currentBytes = 0;
		}
		current.push(node);
		currentBytes += nodeBytes;
	}
	if (current.length > 0) out.push(current);
	return out;
}

function approximateNodeBytes(node: ExtractorNodeInput): number {
	// Each node contributes roughly: id + kind + title + body + role + JSON overhead.
	// We only need an order-of-magnitude estimate for chunking; UTF-16 length
	// is close enough to bytes for English/Chinese mix.
	return node.id.length + node.kind.length + node.title.length + node.body.length + node.role.length + 64;
}



export function buildExtractorRpcCommand(input: {
	modelRole: string;
	prompt: string;
}): {
	type: "invoke_model_role";
	modelRole: string;
	input: { systemPrompt: string; userPrompt: string };
	responseFormat: { type: "json_object"; schemaName: "TopologyExtractionResult" };
} {
	return {
		type: "invoke_model_role",
		modelRole: input.modelRole,
		input: {
			systemPrompt: SYSTEM_PROMPT,
			userPrompt: input.prompt,
		},
		responseFormat: { type: "json_object", schemaName: "TopologyExtractionResult" },
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

const VALID_KINDS = new Set([
	"goal",
	"user_intent",
	"decision",
	"resolution",
	"evidence",
	"issue",
	"skip",
]);

export function parseExtractionResponse(raw: unknown): ExtractorNodeOutput[] | undefined {
	if (!isRecord(raw)) return undefined;
	const nodesRaw = raw.nodes ?? (isRecord(raw.output) ? raw.output.nodes : undefined);
	if (!Array.isArray(nodesRaw)) return undefined;

	const out: ExtractorNodeOutput[] = [];
	for (const item of nodesRaw) {
		if (!isRecord(item)) continue;
		const id = typeof item.id === "string" ? item.id : "";
		const kind = typeof item.kind === "string" ? item.kind : "";
		if (!id || !VALID_KINDS.has(kind)) continue;
		out.push({
			id,
			kind,
			title: typeof item.title === "string" ? item.title.slice(0, 80) : "",
			body: typeof item.body === "string" ? item.body.slice(0, 300) : "",
		});
	}
	return out.length > 0 ? out : undefined;
}

/**
 * Refine regex-extracted nodes using the topology_extractor model role.
 * Falls back to the original nodes if the LLM call fails or is not configured.
 */
export async function refineNodesWithLLM(input: {
	nodes: SessionContextNode[];
	client: TopologyExtractorModelClient;
	modelRole: string;
	timeoutMs?: number;
}): Promise<SessionContextNode[]> {
	const timeoutMs = input.timeoutMs ?? 180_000;

	const extractorInput: ExtractorNodeInput[] = input.nodes.map((n) => ({
		id: n.id,
		kind: n.kind,
		title: n.title,
		body: n.compressedBody || n.body,
		role: String(n.metadata?.role ?? "unknown"),
	}));

	const prompt = buildExtractionPrompt(extractorInput);

	try {
		const raw = await input.client.extractNodes({
			modelRole: input.modelRole,
			prompt,
			timeoutMs,
		});
		const refined = parseExtractionResponse(raw);
		if (!refined) {
			log.debug("LLM extraction returned no valid output, keeping regex nodes");
			return input.nodes;
		}

		// Build a map of refined nodes by id
		const refinedMap = new Map(refined.map((r) => [r.id, r]));

		// Apply refinements: keep original node structure, update kind/title/body
		// Drop nodes marked "skip"
		const result = input.nodes.filter((n) => {
			const r = refinedMap.get(n.id);
			return !(r && r.kind === "skip");
		}).map((n) => {
			const r = refinedMap.get(n.id);
			if (!r) return n; // not refined, keep as-is
			return {
				...n,
				kind: r.kind as SessionContextNode["kind"],
				title: r.title || n.title,
				body: r.body || n.body,
				compressedBody: r.body || n.compressedBody,
			};
		});

	const skipped = input.nodes.length - result.length;
		log.info(`LLM refined ${result.length}/${input.nodes.length} nodes (${skipped} skipped)`);
		return result;
	} catch (err) {
		log.debug(`LLM extraction failed, keeping regex nodes: ${String(err)}`);
		return input.nodes;
	}
}
