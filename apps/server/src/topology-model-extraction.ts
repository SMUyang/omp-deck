import type { SessionContextNode, SessionContextEdge, SessionContextArtifact } from "@omp-deck/protocol";

import { readManagedEnvFile } from "./env-store.ts";

export interface ExtractedNode {
	kind: SessionContextNode["kind"];
	title: string;
	compressedBody: string;
	importance: number;
	messageId: string;
	turnIndex: number;
	createdAt: string;
	role: string;
	inputIndex: number;
}

export interface ExtractionBatchResult {
	nodes: ExtractedNode[];
}

export interface ModelExtractionConfig {
	enabled: boolean;
	model: string;
	baseUrl: string;
	endpointPath: string;
	apiKey: string;
	batchSize: number;
	timeoutMs: number;
}

const DEFAULT_EXTRACTION_CONFIG: ModelExtractionConfig = {
	enabled: false,
	model: "deepseek/deepseek-v4-flash:low",
	baseUrl: "",
	apiKey: "",
	batchSize: 15,
	timeoutMs: 30_000,
	endpointPath: "/v1/chat/completions",
};

export function getModelExtractionConfig(envOverride?: Record<string, string | undefined>): ModelExtractionConfig {
	const get = (key: string): string | undefined => {
		if (envOverride) return envOverride[key] ?? undefined;
		if (process.env[key] !== undefined) return process.env[key];
		const file = readManagedEnvFile();
		return file.values.get(key);
	};
	const enabled = (get("OMP_DECK_TOPOLOGY_EXTRACTION_MODE") ?? "").toLowerCase() === "fast_model";
	return {
		enabled,
		model: get("OMP_DECK_TOPOLOGY_EXTRACTION_MODEL") ?? DEFAULT_EXTRACTION_CONFIG.model,
		baseUrl: get("OMP_DECK_TOPOLOGY_EXTRACTION_BASE_URL") ?? DEFAULT_EXTRACTION_CONFIG.baseUrl,
		apiKey: get("OMP_DECK_TOPOLOGY_EXTRACTION_API_KEY") ?? DEFAULT_EXTRACTION_CONFIG.apiKey,
		batchSize: Number(get("OMP_DECK_TOPOLOGY_EXTRACTION_BATCH_SIZE")) || DEFAULT_EXTRACTION_CONFIG.batchSize,
		timeoutMs: Number(get("OMP_DECK_TOPOLOGY_EXTRACTION_TIMEOUT_MS")) || DEFAULT_EXTRACTION_CONFIG.timeoutMs,
		endpointPath: get("OMP_DECK_TOPOLOGY_EXTRACTION_ENDPOINT_PATH") || DEFAULT_EXTRACTION_CONFIG.endpointPath,
	};
}

interface MessageForExtraction {
	id: string;
	role: string;
	text: string;
	turnIndex: number;
	createdAt: string;
}

function buildExtractionPrompt(messages: MessageForExtraction[]): string {
	return `From the following conversation messages, extract key nodes for a knowledge graph.

For each message, return:
- kind: one of goal, decision, evidence, issue, constraint, user_intent, action, artifact, todo_state
- title: a one-line title (max 80 chars)
- compressedBody: a compressed version preserving key information (conclusions, numbers, URLs, file paths, decisions). Remove filler words, explanations, and repetition. Keep it under 300 chars.
- importance: 0.0-1.0 (decisions/evidence/conclusions=0.9, goals/issues=0.7, actions=0.6, other=0.5)

Return a JSON object with a "nodes" array. Do NOT include messages that are purely conversational filler (greetings, acknowledgments, "ok", "thanks").

Each returned object MUST include an "inputIndex" field matching the message number [N] shown above. This is required for mapping.

Messages:
${messages.map((m, i) => `[${i}] role=${m.role} turn=${m.turnIndex}\n${m.text.slice(0, 800)}`).join("\n---\n")}

Return a JSON object: {"nodes": [...]}. No other text.`
}

function parseExtractionResult(raw: string): ExtractedNode[] | undefined {
	// json_object mode: parse the whole response, extract .nodes
	if (raw.trim().startsWith("{")) {
		const obj = safeJsonParse(raw);
		if (obj && typeof obj === "object" && !Array.isArray(obj)) {
			const nodes = (obj as Record<string, unknown>).nodes;
			if (Array.isArray(nodes)) return filterValidExtractionNodes(nodes);
		}
	}
	// bare array fallback: extract first JSON array from text
	const arrMatch = raw.match(/\[[\s\S]*\]/);
	if (!arrMatch) return undefined;
	const arr = safeJsonParse(arrMatch[0]);
	if (Array.isArray(arr)) return filterValidExtractionNodes(arr);
	return undefined;
}

function safeJsonParse(raw: string): unknown {
	try {
		return JSON.parse(raw) as unknown;
	} catch {
		return undefined;
	}
}

function filterValidExtractionNodes(parsed: unknown[]): ExtractedNode[] {
	const results: ExtractedNode[] = [];
	for (const item of parsed) {
		if (!isRecord(item)) continue;
		const kind = item.kind;
		if (typeof kind !== "string") continue;
		const validKinds = new Set(["goal", "decision", "evidence", "issue", "constraint", "user_intent", "action", "artifact", "todo_state", "handoff_summary", "resolution", "user_goal", "recommendation", "task", "plan", "note", "observation"]);
		if (!validKinds.has(kind)) continue;
		const kindMap: Record<string, SessionContextNode["kind"]> = {
			user_goal: "goal",
			recommendation: "decision",
			task: "action",
			plan: "decision",
			note: "evidence",
			observation: "evidence",
		};
		const nodeKind = kindMap[kind] ?? (kind as SessionContextNode["kind"]);
		const title = typeof item.title === "string" ? item.title.slice(0, 80) : kind;
		const compressedBody = typeof item.compressedBody === "string" ? item.compressedBody.slice(0, 300) : "";
		const rawImportance = typeof item.importance === "number" && Number.isFinite(item.importance) ? item.importance : 7;
		const importance = rawImportance > 1 ? Math.min(1, rawImportance / 10) : Math.min(1, Math.max(0, rawImportance));
		const inputIndex = typeof item.inputIndex === "number" ? item.inputIndex : -1;
		results.push({
			kind: nodeKind,
			title,
			compressedBody,
			importance,
			messageId: "",
			turnIndex: 0,
			createdAt: "",
			role: "",
			inputIndex,
		});
	}
	return results;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeModelForApi(model: string): string {
	// Strip OMP provider prefix (e.g. "deepseek/" from "deepseek/deepseek-v4-flash")
	// and thinking suffix (e.g. ":low" from "deepseek-v4-flash:low")
	const slash = model.indexOf("/");
	const withoutPrefix = slash >= 0 ? model.slice(slash + 1) : model;
	const colon = withoutPrefix.indexOf(":");
	return colon >= 0 ? withoutPrefix.slice(0, colon) : withoutPrefix;
}

export async function extractWithFastModel(
	config: ModelExtractionConfig,
	messages: MessageForExtraction[],
): Promise<ExtractionBatchResult> {
	if (!config.baseUrl || !config.apiKey || messages.length === 0) return { nodes: [] };

	const prompt = buildExtractionPrompt(messages);
	const model = normalizeModelForApi(config.model);

	try {
		const endpointPath = config.endpointPath || "/v1/chat/completions";
		const res = await fetch(`${config.baseUrl.replace(/\/$/, "")}${endpointPath}`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"Authorization": `Bearer ${config.apiKey}`,
			},
			body: JSON.stringify({
				model,
				messages: [
					{ role: "system", content: "You are a structured information extractor. Return only valid JSON arrays." },
					{ role: "user", content: prompt },
				],
				max_tokens: 2000,
				temperature: 0.1,
				response_format: { type: "json_object" },
			}),
			signal: AbortSignal.timeout(config.timeoutMs),
		});
		if (!res.ok) {
			const errBody = await res.text().catch(() => "");
			console.error("[fast-model] HTTP", res.status, errBody.slice(0, 200));
			return { nodes: [] };
		}
		const data = await res.json().catch(() => undefined) as Record<string, unknown> | undefined;
		if (!data || !isRecord(data)) return { nodes: [] };
		const choices = data.choices;
		if (!Array.isArray(choices) || !choices[0]) return { nodes: [] };
		const choice = choices[0];
		if (!isRecord(choice)) return { nodes: [] };
		const message = choice.message;
		if (!isRecord(message)) return { nodes: [] };
		const contentText = typeof message.content === "string" ? message.content : "";
		let extracted = contentText.trim() !== "" ? parseExtractionResult(contentText) : undefined;
		if (!extracted) {
			const rc = message.reasoning_content;
			if (typeof rc === "string" && rc.trim() !== "") {
				extracted = parseExtractionResult(rc);
				if (!extracted) {
					console.error("[fast-model] reasoning_content had no usable JSON");
				}
			} else {
				console.error("[fast-model] no content and no reasoning_content. message keys:", Object.keys(message || {}));
			}
		}
		if (!extracted) {
			console.error("[fast-model] parse failed. content:", contentText.slice(0, 500));
			return { nodes: [] };
		}

		// Map by inputIndex — model may skip filler messages
		for (const node of extracted) {
			if (node.inputIndex < 0 || node.inputIndex >= messages.length) continue;
			const msg = messages[node.inputIndex];
			if (!msg) continue;
			node.messageId = msg.id;
			node.turnIndex = msg.turnIndex;
			node.createdAt = msg.createdAt;
			node.role = msg.role;
		}

		return { nodes: extracted.filter((n) => n.messageId) };
	} catch (err) {
		console.error("[fast-model] extraction failed:", err instanceof Error ? err.message : String(err));
		return { nodes: [] };
	}
}

export function messageForExtraction(input: {
	id: string;
	role: string;
	text: string;
	turnIndex: number;
	createdAt: string;
}): MessageForExtraction {
	return input;
}
