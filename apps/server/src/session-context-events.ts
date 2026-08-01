import { createHash } from "node:crypto";

export interface NormalizedToolCall {
	id: string;
	name: string;
	arguments: Record<string, unknown>;
	intent?: string;
	sourceEntryId: string;
	lifecycleStartedAt?: string;
	lifecycleMetadata: Record<string, unknown>;
}

export interface NormalizedToolResult {
	toolCallId: string;
	toolName?: string;
	text: string;
	details?: unknown;
	isError: boolean;
	prunedAt?: string;
	sourceEntryId: string;
	lifecycleEndedAt?: string;
	metadata: Record<string, unknown>;
}

export interface NormalizedSessionEvent {
	entryId: string;
	parentId?: string;
	sourceLine: number;
	sourceTimestamp?: string;
	sdkTimestampMs?: number;
	role: "user" | "assistant" | "developer" | "system" | "tool" | "unknown";
	synthetic: boolean;
	text: string;
	stopReason?: string;
	toolCalls: NormalizedToolCall[];
	toolResult?: NormalizedToolResult;
	customType?: string;
	metadata: Record<string, unknown>;
}

export interface NormalizedTimestamp {
	sourceTimestamp?: string;
	sdkTimestampMs?: number;
	metadata: Record<string, unknown>;
	diagnosticCodes: string[];
}

interface ParsedEntry {
	record: Record<string, unknown>;
	line: number;
	entryId: string;
	hasSourceId: boolean;
	parentId?: string;
}

interface LifecycleData {
	toolCallId?: string;
	timestamp?: string;
	metadata: Record<string, unknown>;
}

const MIN_PLAUSIBLE_UNIX_MS = Date.UTC(2000, 0, 1);
const MAX_PLAUSIBLE_UNIX_MS = Date.UTC(3000, 0, 1);
const LIFECYCLE_TYPES: Record<string, true> = { tool_execution_start: true, tool_execution_end: true };

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function recordOrEmpty(value: unknown): Record<string, unknown> {
	return isRecord(value) ? value : {};
}

function canonicalJson(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	const record = value as Record<string, unknown>;
	const fields: string[] = [];
	for (const key of Object.keys(record).sort()) {
		const child = record[key];
		if (child !== undefined) fields.push(`${JSON.stringify(key)}:${canonicalJson(child)}`);
	}
	return `{${fields.join(",")}}`;
}

function fallbackEntryId(line: number, record: Record<string, unknown>): string {
	const digest = createHash("sha256").update(canonicalJson(record)).digest("hex").slice(0, 16);
	return `line-${line}-${digest}`;
}

function validIsoTimestamp(value: unknown): string | undefined {
	if (typeof value !== "string" || value.length === 0) return undefined;
	const milliseconds = Date.parse(value);
	if (!Number.isFinite(milliseconds)) return undefined;
	return new Date(milliseconds).toISOString() === value ? value : undefined;
}

function validUnixMilliseconds(value: unknown): number | undefined {
	if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value)) return undefined;
	if (value < MIN_PLAUSIBLE_UNIX_MS || value > MAX_PLAUSIBLE_UNIX_MS) return undefined;
	return value;
}

export function normalizeSessionEventTimestamp(input: {
	recordTimestamp: unknown;
	sdkTimestamp: unknown;
}): NormalizedTimestamp {
	const metadata: Record<string, unknown> = {};
	const diagnosticCodes: string[] = [];
	const recordTimestamp = validIsoTimestamp(input.recordTimestamp);
	const sdkTimestampMs = validUnixMilliseconds(input.sdkTimestamp);

	if (input.recordTimestamp !== undefined && !recordTimestamp) {
		metadata.recordTimestampInvalid = true;
		diagnosticCodes.push("invalid_record_timestamp");
	}
	if (input.sdkTimestamp !== undefined && sdkTimestampMs === undefined) {
		metadata.sdkTimestampInvalid = true;
		diagnosticCodes.push("invalid_sdk_timestamp");
	}

	if (recordTimestamp) {
		if (sdkTimestampMs !== undefined) {
			const sdkTimestampIso = new Date(sdkTimestampMs).toISOString();
			if (sdkTimestampIso !== recordTimestamp) {
				metadata.timestampMismatch = true;
				metadata.sdkTimestampIso = sdkTimestampIso;
			}
		}
		return { sourceTimestamp: recordTimestamp, sdkTimestampMs, metadata, diagnosticCodes };
	}

	if (sdkTimestampMs !== undefined) {
		return { sourceTimestamp: new Date(sdkTimestampMs).toISOString(), sdkTimestampMs, metadata, diagnosticCodes };
	}

	diagnosticCodes.push("invalid_timestamp");
	return { metadata, diagnosticCodes };
}

function textFromContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	let text = "";
	for (const block of content) {
		if (!isRecord(block) || block.type !== "text" || typeof block.text !== "string") continue;
		text += block.text;
	}
	return text;
}

function normalizeToolCalls(content: unknown, sourceEntryId: string): NormalizedToolCall[] {
	if (!Array.isArray(content)) return [];
	const toolCalls: NormalizedToolCall[] = [];
	for (const block of content) {
		if (!isRecord(block) || block.type !== "toolCall") continue;
		const id = nonEmptyString(block.id);
		const name = nonEmptyString(block.name);
		if (!id || !name) continue;
		const call: NormalizedToolCall = {
			id,
			name,
			arguments: recordOrEmpty(block.arguments),
			sourceEntryId,
			lifecycleMetadata: {},
		};
		const intent = nonEmptyString(block.intent);
		if (intent) call.intent = intent;
		toolCalls.push(call);
	}
	return toolCalls;
}

function optionalCanonicalMilliseconds(value: unknown): string | undefined {
	const milliseconds = validUnixMilliseconds(value);
	return milliseconds === undefined ? undefined : new Date(milliseconds).toISOString();
}

function normalizeToolResult(message: Record<string, unknown>, sourceEntryId: string, legacyRole: boolean): NormalizedToolResult | undefined {
	const toolCallId = nonEmptyString(message.toolCallId);
	if (!toolCallId) return undefined;
	const metadata: Record<string, unknown> = { messageRole: legacyRole ? "tool" : "toolResult" };
	if (legacyRole) {
		metadata.legacyRole = true;
		metadata.orphan = true;
	}
	const result: NormalizedToolResult = {
		toolCallId,
		text: textFromContent(message.content),
		isError: message.isError === true,
		sourceEntryId,
		metadata,
	};
	const toolName = nonEmptyString(message.toolName);
	if (toolName) result.toolName = toolName;
	if (message.details !== undefined) result.details = message.details;
	const prunedAt = optionalCanonicalMilliseconds(message.prunedAt);
	if (prunedAt) result.prunedAt = prunedAt;
	return result;
}

function baseMetadata(record: Record<string, unknown>, timestampMetadata: Record<string, unknown>): Record<string, unknown> {
	const metadata: Record<string, unknown> = { ...timestampMetadata };
	const entryType = nonEmptyString(record.type);
	if (entryType) metadata.entryType = entryType;
	return metadata;
}

function normalizeMessageEntry(entry: ParsedEntry, diagnostics: Array<{ line: number; code: string }>): NormalizedSessionEvent {
	const message = recordOrEmpty(entry.record.message);
	const timestamp = normalizeSessionEventTimestamp({ recordTimestamp: entry.record.timestamp, sdkTimestamp: message.timestamp });
	for (const code of timestamp.diagnosticCodes) diagnostics.push({ line: entry.line, code });
	const messageRole = nonEmptyString(message.role);
	const synthetic = message.synthetic === true || message.attribution === "agent";
	let role: NormalizedSessionEvent["role"];
	if (messageRole === "user" && !synthetic) role = "user";
	else if (messageRole === "assistant") role = "assistant";
	else if (messageRole === "toolResult" || messageRole === "tool") role = "tool";
	else if (messageRole === "developer" || messageRole === "system" || messageRole === "advisor" || messageRole === "custom" || messageRole === "user") role = "system";
	else role = "unknown";

	const metadata = baseMetadata(entry.record, timestamp.metadata);
	if (messageRole) metadata.messageRole = messageRole;
	const attribution = nonEmptyString(message.attribution);
	if (attribution) metadata.attribution = attribution;
	if (messageRole === "user" && synthetic) metadata.syntheticUser = true;

	const event: NormalizedSessionEvent = {
		entryId: entry.entryId,
		sourceLine: entry.line,
		role,
		synthetic,
		text: textFromContent(message.content),
		toolCalls: role === "assistant" ? normalizeToolCalls(message.content, entry.entryId) : [],
		metadata,
	};
	if (entry.parentId) event.parentId = entry.parentId;
	if (timestamp.sourceTimestamp) event.sourceTimestamp = timestamp.sourceTimestamp;
	if (timestamp.sdkTimestampMs !== undefined) event.sdkTimestampMs = timestamp.sdkTimestampMs;
	if (role === "assistant") {
		const stopReason = nonEmptyString(message.stopReason);
		if (stopReason) event.stopReason = stopReason;
	}
	if (role === "tool") event.toolResult = normalizeToolResult(message, entry.entryId, messageRole === "tool");
	return event;
}

function normalizeControlEntry(entry: ParsedEntry, diagnostics: Array<{ line: number; code: string }>): NormalizedSessionEvent {
	const timestamp = normalizeSessionEventTimestamp({ recordTimestamp: entry.record.timestamp, sdkTimestamp: undefined });
	for (const code of timestamp.diagnosticCodes) diagnostics.push({ line: entry.line, code });
	const entryType = nonEmptyString(entry.record.type);
	const customType = nonEmptyString(entry.record.customType);
	const metadata = baseMetadata(entry.record, timestamp.metadata);
	if (entryType === "custom" && entry.record.data !== undefined) metadata.data = entry.record.data;
	const event: NormalizedSessionEvent = {
		entryId: entry.entryId,
		sourceLine: entry.line,
		role: entryType ? "system" : "unknown",
		synthetic: true,
		text: entryType === "custom_message" ? textFromContent(entry.record.content) : "",
		toolCalls: [],
		metadata,
	};
	if (entry.parentId) event.parentId = entry.parentId;
	if (timestamp.sourceTimestamp) event.sourceTimestamp = timestamp.sourceTimestamp;
	if (timestamp.sdkTimestampMs !== undefined) event.sdkTimestampMs = timestamp.sdkTimestampMs;
	if (customType) event.customType = customType;
	return event;
}

function lifecycleData(event: NormalizedSessionEvent): LifecycleData {
	const data = recordOrEmpty(event.metadata.data);
	const nestedMetadata = recordOrEmpty(data.metadata);
	const timestampKey = event.customType === "tool_execution_start" ? "startedAt" : "endedAt";
	const explicitTimestamp = validIsoTimestamp(data[timestampKey]);
	return {
		toolCallId: nonEmptyString(data.toolCallId),
		timestamp: explicitTimestamp ?? event.sourceTimestamp,
		metadata: nestedMetadata,
	};
}

function enrichLifecycles(activeEvents: NormalizedSessionEvent[], diagnostics: Array<{ line: number; code: string }>): void {
	const toolCalls = new Map<string, NormalizedToolCall>();
	const toolResults = new Map<string, NormalizedToolResult>();
	for (const event of activeEvents) {
		for (const call of event.toolCalls) toolCalls.set(call.id, call);
		if (event.toolResult) toolResults.set(event.toolResult.toolCallId, event.toolResult);
	}

	for (const event of activeEvents) {
		if (!event.customType || LIFECYCLE_TYPES[event.customType] !== true) continue;
		const lifecycle = lifecycleData(event);
		const target = event.customType === "tool_execution_start"
			? lifecycle.toolCallId ? toolCalls.get(lifecycle.toolCallId) : undefined
			: lifecycle.toolCallId ? toolResults.get(lifecycle.toolCallId) : undefined;
		if (!target) {
			event.metadata.lifecycleMatched = false;
			if (lifecycle.toolCallId) event.metadata.orphanToolCallId = lifecycle.toolCallId;
			diagnostics.push({ line: event.sourceLine, code: "orphan_tool_lifecycle" });
			continue;
		}
		event.metadata.lifecycleMatched = true;
		if (event.customType === "tool_execution_start") {
			const call = target as NormalizedToolCall;
			if (lifecycle.timestamp) call.lifecycleStartedAt = lifecycle.timestamp;
			call.lifecycleMetadata = lifecycle.metadata;
		} else {
			const result = target as NormalizedToolResult;
			if (lifecycle.timestamp) result.lifecycleEndedAt = lifecycle.timestamp;
			result.metadata.lifecycle = lifecycle.metadata;
		}
	}
}

function parseEntries(content: string, diagnostics: Array<{ line: number; code: string }>): ParsedEntry[] {
	const parsed: ParsedEntry[] = [];
	const lines = content.split(/\r?\n/);
	for (let index = 0; index < lines.length; index++) {
		const line = lines[index]!;
		if (line.trim().length === 0) continue;
		let value: unknown;
		try {
			value = JSON.parse(line);
		} catch {
			diagnostics.push({ line: index + 1, code: "malformed_json" });
			continue;
		}
		if (!isRecord(value)) {
			diagnostics.push({ line: index + 1, code: "invalid_record" });
			continue;
		}
		const sourceId = nonEmptyString(value.id);
		parsed.push({
			record: value,
			line: index + 1,
			entryId: sourceId ?? fallbackEntryId(index + 1, value),
			hasSourceId: sourceId !== undefined,
			parentId: nonEmptyString(value.parentId),
		});
	}
	return parsed;
}

function selectActiveChain(entries: ParsedEntry[], diagnostics: Array<{ line: number; code: string }>): ParsedEntry[] {
	let leaf: ParsedEntry | undefined;
	for (let index = entries.length - 1; index >= 0; index--) {
		if (entries[index]!.hasSourceId) {
			leaf = entries[index];
			break;
		}
	}
	if (!leaf) leaf = entries.at(-1);
	if (!leaf) return [];

	const byId = new Map<string, ParsedEntry>();
	for (const entry of entries) byId.set(entry.entryId, entry);
	const reverseChain: ParsedEntry[] = [];
	const seen = new Set<string>();
	let current: ParsedEntry | undefined = leaf;
	while (current) {
		if (seen.has(current.entryId)) {
			diagnostics.push({ line: current.line, code: "parent_cycle" });
			break;
		}
		seen.add(current.entryId);
		reverseChain.push(current);
		if (!current.parentId) break;
		const parent = byId.get(current.parentId);
		if (!parent) {
			diagnostics.push({ line: current.line, code: "missing_parent" });
			break;
		}
		if (seen.has(parent.entryId)) {
			diagnostics.push({ line: parent.line, code: "parent_cycle" });
			break;
		}
		current = parent;
	}
	return reverseChain.reverse();
}

export function normalizeSessionJsonl(input: { content: string }): {
	activeEvents: NormalizedSessionEvent[];
	diagnostics: Array<{ line: number; code: string }>;
} {
	const diagnostics: Array<{ line: number; code: string }> = [];
	const entries = parseEntries(input.content, diagnostics);
	const chain = selectActiveChain(entries, diagnostics);
	const activeEvents = chain.map((entry) => entry.record.type === "message"
		? normalizeMessageEntry(entry, diagnostics)
		: normalizeControlEntry(entry, diagnostics));
	enrichLifecycles(activeEvents, diagnostics);
	return { activeEvents, diagnostics };
}
