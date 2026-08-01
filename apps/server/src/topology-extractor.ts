import type { SessionContextNode } from "@omp-deck/protocol";
import { logger } from "./log.ts";
import { redactSensitiveText } from "./redaction.ts";

const log = logger("topology-extractor");
const OPERATION_DETAIL_LIMIT = 120;
const REFINED_PURPOSE_LIMIT = 240;
const PROMPT_VERSION = "conversation-purpose-v1";

export interface ExtractorNodeInput {
	id: string;
	operation?: string;
	purpose?: string | null;
	body: string;
	kind?: string;
	title?: string;
	role?: string;
}

export interface ExtractorNodeOutput {
	id: string;
	operationDetail?: string;
	refinedPurpose?: string;
}

export interface TopologyExtractorModelClient {
	extractNodes(input: { modelRole: string; prompt: string; timeoutMs: number }): Promise<unknown>;
}

export const SYSTEM_PROMPT = `You refine only optional purpose labels for deterministic conversation topology nodes.
Return JSON: { "nodes": [{ "id": "...", "operationDetail": "optional_snake_case", "refinedPurpose": "optional concise purpose" }] }.
You must not change kind, title, body, population, nodeRole, origin, childType, pairId, parentNodeId, operation, purpose, purposeSource, status, source IDs, timestamps, metadata, edges, or artifacts.
Omit an optional field when no safe improvement is justified.`;

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

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isExtractorNodeInput(value: unknown): value is ExtractorNodeInput {
	return isRecord(value) && typeof value.id === "string" && typeof value.body === "string";
}

function approximateNodeBytes(node: ExtractorNodeInput): number {
	return node.id.length + (node.operation?.length ?? 0) + (node.purpose?.length ?? 0) + node.body.length + (node.title?.length ?? 0) + (node.kind?.length ?? 0) + (node.role?.length ?? 0) + 64;
}

function splitByBudget(nodes: ExtractorNodeInput[], maxCount: number, maxBytes: number): ExtractorNodeInput[][] {
	const out: ExtractorNodeInput[][] = [];
	let current: ExtractorNodeInput[] = [];
	let currentBytes = 0;
	for (const node of nodes) {
		const bytes = approximateNodeBytes(node);
		if (current.length > 0 && (current.length >= maxCount || currentBytes + bytes > maxBytes)) {
			out.push(current);
			current = [];
			currentBytes = 0;
		}
		current.push(node);
		currentBytes += bytes;
	}
	if (current.length > 0) out.push(current);
	return out;
}

async function runExtractorChunk(slot: TopologyExtractorPoolSlot, chunk: ExtractorNodeInput[], modelRole: string, timeoutMs: number, results: ExtractorNodeOutput[]): Promise<void> {
	try {
		const raw = await slot.client.extractNodes({ modelRole, prompt: buildExtractionPrompt(chunk), timeoutMs });
		const parsed = parseExtractionResponse(raw);
		if (parsed) results.push(...parsed);
		else log.info(`extractor slot ${slot.label} chunk returned invalid/empty response`);
	} catch (error) {
		log.info(`extractor slot ${slot.label} chunk failed: ${String(error)}`);
	}
}

async function runExtractorSlotQueue(input: { slot: TopologyExtractorPoolSlot; queue: ExtractorNodeInput[][]; modelRole: string; timeoutMs: number }): Promise<ExtractorNodeOutput[]> {
	const results: ExtractorNodeOutput[] = [];
	const running = new Set<Promise<void>>();
	for (const chunk of input.queue) {
		const job = runExtractorChunk(input.slot, chunk, input.modelRole, input.timeoutMs, results).finally(() => running.delete(job));
		running.add(job);
		if (running.size >= input.slot.maxConcurrency) await Promise.race(running);
	}
	await Promise.all(running);
	return results;
}

export function createPooledTopologyExtractorClient(options: TopologyExtractorPoolOptions): TopologyExtractorModelClient {
	const slots = options.slots.filter((slot) => slot.maxConcurrency > 0);
	if (slots.length === 0) return { extractNodes: async () => undefined };
	const chunkSize = Math.max(1, options.chunkSize ?? 20);
	const maxBytes = Math.max(1024, options.maxChunkBytes ?? 24_000);
	return {
		async extractNodes({ modelRole, prompt, timeoutMs }) {
			let nodes: ExtractorNodeInput[];
			try {
				const parsed = JSON.parse(prompt) as unknown;
				if (!Array.isArray(parsed)) return undefined;
				nodes = parsed.filter(isExtractorNodeInput);
			} catch {
				return undefined;
			}
			if (nodes.length === 0) return undefined;
			const chunks = splitByBudget(nodes, chunkSize, maxBytes);
			const queues = new Map<TopologyExtractorPoolSlot, ExtractorNodeInput[][]>();
			chunks.forEach((chunk, index) => {
				const slot = slots[index % slots.length]!;
				const queue = queues.get(slot) ?? [];
				queue.push(chunk);
				queues.set(slot, queue);
			});
			const settled = await Promise.all(Array.from(queues.entries()).map(([slot, queue]) => runExtractorSlotQueue({ slot, queue, modelRole, timeoutMs })));
			const outputs = settled.flat();
			return outputs.length > 0 ? { nodes: outputs } : undefined;
		},
	};
}

export function buildExtractorRpcCommand(input: { modelRole: string; prompt: string }): {
	type: "invoke_model_role";
	modelRole: string;
	input: { systemPrompt: string; userPrompt: string };
	responseFormat: { type: "json_object"; schemaName: "TopologyExtractionResult" };
} {
	return { type: "invoke_model_role", modelRole: input.modelRole, input: { systemPrompt: SYSTEM_PROMPT, userPrompt: input.prompt }, responseFormat: { type: "json_object", schemaName: "TopologyExtractionResult" } };
}

const OUTPUT_KEYS = new Set(["id", "operationDetail", "refinedPurpose"]);
const OPERATION_DETAIL_RE = /^[a-z0-9]+(?:_[a-z0-9]+)*$/;

export function parseExtractionResponse(raw: unknown): ExtractorNodeOutput[] | undefined {
	if (!isRecord(raw)) return undefined;
	const nodesRaw = raw.nodes ?? (isRecord(raw.output) ? raw.output.nodes : undefined);
	if (!Array.isArray(nodesRaw)) return undefined;
	const out: ExtractorNodeOutput[] = [];
	for (const item of nodesRaw) {
		if (!isRecord(item) || Object.keys(item).some((key) => !OUTPUT_KEYS.has(key))) return undefined;
		if (typeof item.id !== "string" || item.id.length === 0) return undefined;
		const operationDetail = item.operationDetail;
		const refinedPurpose = item.refinedPurpose;
		if (operationDetail !== undefined && (typeof operationDetail !== "string" || !OPERATION_DETAIL_RE.test(operationDetail))) return undefined;
		if (refinedPurpose !== undefined && (typeof refinedPurpose !== "string" || refinedPurpose.trim().length === 0)) return undefined;
		if (operationDetail === undefined && refinedPurpose === undefined) return undefined;
		out.push({ id: item.id, ...(operationDetail ? { operationDetail } : {}), ...(refinedPurpose ? { refinedPurpose } : {}) });
	}
	return out.length > 0 ? out : undefined;
}

export async function refineNodesWithLLM(input: { nodes: SessionContextNode[]; client: TopologyExtractorModelClient; modelRole: string; timeoutMs?: number }): Promise<SessionContextNode[]> {
	const extractorInput: ExtractorNodeInput[] = input.nodes.map((node) => ({ id: node.id, operation: node.operation ?? "unknown", purpose: node.purpose ?? null, body: (node.compressedBody || node.body).slice(0, 300) }));
	try {
		const raw = await input.client.extractNodes({ modelRole: input.modelRole, prompt: buildExtractionPrompt(extractorInput), timeoutMs: input.timeoutMs ?? 180_000 });
		const refined = parseExtractionResponse(raw);
		if (!refined) return input.nodes;
		const knownIds = new Set(input.nodes.map((node) => node.id));
		if (refined.some((entry) => !knownIds.has(entry.id))) return input.nodes;
		const refinedMap = new Map(refined.map((entry) => [entry.id, entry]));
		return input.nodes.map((node) => {
			const entry = refinedMap.get(node.id);
			if (!entry) return node;
			const operationDetail = entry.operationDetail ? redactSensitiveText(entry.operationDetail).slice(0, OPERATION_DETAIL_LIMIT) : undefined;
			const refinedPurpose = entry.refinedPurpose ? redactSensitiveText(entry.refinedPurpose).trim().slice(0, REFINED_PURPOSE_LIMIT) : undefined;
			if (!operationDetail && !refinedPurpose) return node;
			return { ...node, ...(operationDetail ? { operationDetail } : {}), ...(refinedPurpose ? { refinedPurpose } : {}), refinement: { model: input.modelRole, promptVersion: PROMPT_VERSION } };
		});
	} catch (error) {
		log.debug(`LLM extraction failed, keeping deterministic nodes: ${String(error)}`);
		return input.nodes;
	}
}
