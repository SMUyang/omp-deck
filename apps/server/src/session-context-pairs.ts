import { createHash } from "node:crypto";

import type { SessionContextArtifact, SessionContextNode, SessionContextNodeStatus, SessionContextOperation } from "@omp-deck/protocol";
import type { ExtractedSessionContext } from "./session-context.ts";
import type { NormalizedSessionEvent, NormalizedToolCall, NormalizedToolResult } from "./session-context-events.ts";
import { redactSensitiveText } from "./redaction.ts";

const PURPOSE_LIMIT = 240;
const BODY_LIMIT = 600;
const TITLE_LIMIT = 80;
const URL_RE = /https?:\/\/[^\s<>"')\]]+/g;
const COMMIT_RE = /\b[0-9a-f]{7,40}\b/g;
const FILE_RE = /(?:^|[\s"'])([\w./~@-]+\.(?:ts|tsx|js|jsx|json|md|sql|yaml|yml|sh|ps1|svg|png|jpg|jpeg|gif|webp|pdf))(?:\b|$)/g;
const IMAGE_RE = /\.(?:png|jpg|jpeg|gif|webp|svg)$/i;
const NOISE_RE = /^\s*(?:\[Superseded by a newer read of this file\]|Skipped due to queued user message|\(no output\)|poll(?:ing)?\b|status:\s*(?:queued|running|pending)|still running|cancelled before execution|canceled before execution|queued\b|superseded\b)/i;
const REPETITIVE_LOG_RE = /^\s*(?:\[(?:INFO|DEBUG|WARN|ERROR)\].*\n?){2,}\s*$/i;
const TEST_COMMAND_RE = /(?:^|\s)(bun\s+test\b|npm\s+(?:test|run\s+test)\b|pnpm\s+(?:test|run\s+test)\b|yarn\s+test\b|pytest\b|cargo\s+test\b|go\s+test\b)/i;
const BUILD_COMMAND_RE = /(?:^|\s)(bun|npm|pnpm|yarn)\s+(?:run\s+)?(?:build|typecheck)\b/i;

interface PairWork {
	prompt: NormalizedSessionEvent;
	pairId: string;
	userNode: SessionContextNode;
	toolCalls: Map<string, NormalizedToolCall>;
	toolResults: Map<string, NormalizedToolResult>;
	assistantCandidates: NormalizedSessionEvent[];
	closeReason?: "answered" | "unanswered" | "error" | "aborted";
}

interface ChildBuild {
	node: SessionContextNode;
	artifacts: SessionContextArtifact[];
	mutation: boolean;
	investigation: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function firstString(record: Record<string, unknown>, keys: string[]): string | undefined {
	for (const key of keys) {
		const value = nonEmptyString(record[key]);
		if (value) return value;
	}
	return undefined;
}

function safeText(value: string, limit: number): string {
	return redactSensitiveText(value).replace(/\s+/g, " ").trim().slice(0, limit);
}

function boundedBody(parts: Array<string | undefined>): string {
	return redactSensitiveText(parts.filter((part): part is string => Boolean(part?.trim())).join("\n")).slice(0, BODY_LIMIT);
}

function eventTimestamp(event: NormalizedSessionEvent): string {
	if (event.sourceTimestamp) return event.sourceTimestamp;
	if (event.sdkTimestampMs !== undefined) return new Date(event.sdkTimestampMs).toISOString();
	return new Date(0).toISOString();
}

function sourceMetadata(event: NormalizedSessionEvent, extra: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		...event.metadata,
		sourceEntryId: event.entryId,
		sourceLine: event.sourceLine,
		...(event.parentId ? { parentId: event.parentId } : {}),
		...(event.sdkTimestampMs !== undefined ? { sdkTimestampMs: event.sdkTimestampMs } : {}),
		...extra,
	};
}

function explicitPurpose(text: string): { purpose: string | null; purposeSource: "explicit_text" | "unclassified" } {
	const purpose = safeText(text, PURPOSE_LIMIT);
	return purpose ? { purpose, purposeSource: "explicit_text" } : { purpose: null, purposeSource: "unclassified" };
}

function structuredPurpose(call: NormalizedToolCall, fallback: string): { purpose: string | null; purposeSource: "structured_intent" | "unclassified" } {
	const candidate = call.intent ?? firstString(call.arguments, ["purpose", "target", "task", "text", "prompt", "path", "pattern", "command"]) ?? fallback;
	const purpose = safeText(candidate, PURPOSE_LIMIT);
	return purpose ? { purpose, purposeSource: "structured_intent" } : { purpose: null, purposeSource: "unclassified" };
}

function userOperation(text: string): SessionContextOperation {
	const value = text.trim();
	if (!value) return "unknown";
	if (/\b(?:actually|correction|correcting|instead|rather than)\b|(?:其实|纠正|改成|而不是)/i.test(value)) return "correct";
	if (/\b(?:do not|don't|must not|never|only|must|without)\b|(?:不要|不得|必须|只能|不允许)/i.test(value)) return "constrain";
	if (/\b(?:i approve|approved|looks good|go ahead)\b|(?:我同意|批准|可以这样)/i.test(value)) return "approve";
	if (/\b(?:i reject|rejected|do not accept)\b|(?:我拒绝|不接受|否决)/i.test(value)) return "reject";
	if (/^(?:what|why|how|when|where|who|which|can|could|would|is|are|do|does|did)\b|[?？]\s*$/i.test(value)) return "ask";
	if (/\b(?:please|could you|would you|i need you to|i want you to|implement|create|add|remove|update|modify|fix|run|inspect|verify|write|build)\b|(?:请|帮我|实现|创建|添加|删除|修改|修复|运行|检查|验证)/i.test(value)) return "request";
	if (/\b(?:i found|i observed|the result is|the test fails|the error is)\b|(?:我发现|结果是|测试失败|错误是)/i.test(value)) return "report";
	if (/\b(?:here is|attached is|i am providing|this is the log)\b|(?:这是|提供|附上)/i.test(value)) return "provide";
	return "unknown";
}

function makeUserNode(sessionId: string, event: NormalizedSessionEvent, pairId: string): SessionContextNode {
	const purpose = explicitPurpose(event.text);
	const operation = userOperation(event.text);
	const body = redactSensitiveText(event.text).slice(0, BODY_LIMIT);
	return {
		id: `${sessionId}:entry:${event.entryId}:message`, sessionId, kind: operation === "correct" ? "user_intent" : "goal",
		title: safeText(event.text, TITLE_LIMIT) || "User prompt", body, compressedBody: safeText(body, 300), importance: 1,
		createdAt: eventTimestamp(event), sourceMessageId: event.entryId, sourceTurnIndex: event.sourceLine,
		population: "user", nodeRole: "main", origin: "user", pairId, operation, ...purpose, status: "pending", metadata: sourceMetadata(event),
	};
}

function normalizeStopReason(reason: string | undefined): string {
	return reason?.trim().toLowerCase() ?? "";
}

function assistantStatus(event: NormalizedSessionEvent, fallback: boolean): SessionContextNodeStatus {
	if (fallback) return "unknown";
	const reason = normalizeStopReason(event.stopReason);
	if (reason === "error") return "failed";
	if (reason === "aborted" || reason === "abort" || reason === "cancelled" || reason === "canceled") return "aborted";
	if (reason === "stop" || reason === "length") return "completed";
	return "unknown";
}

function appendArtifact(artifacts: SessionContextArtifact[], sessionId: string, nodeId: string, kind: SessionContextArtifact["kind"], ref: string, source: string): void {
	const safeRef = safeText(ref, 500);
	if (!safeRef || artifacts.some((artifact) => artifact.kind === kind && artifact.ref === safeRef)) return;
	artifacts.push({ id: `${nodeId}:artifact:${kind}:${artifacts.length}`, sessionId, nodeId, kind, ref: safeRef, label: safeRef.slice(0, 120), metadata: { source } });
}

function collectStructuredStrings(value: unknown, key = "", depth = 0): Array<{ key: string; value: string }> {
	if (depth > 3) return [];
	if (typeof value === "string") return [{ key, value }];
	if (Array.isArray(value)) return value.flatMap((item) => collectStructuredStrings(item, key, depth + 1));
	if (!isRecord(value)) return [];
	return Object.entries(value).flatMap(([childKey, child]) => collectStructuredStrings(child, childKey, depth + 1));
}

function collectArtifacts(sessionId: string, nodeId: string, call: NormalizedToolCall, result: NormalizedToolResult, includeCommand: boolean): SessionContextArtifact[] {
	const artifacts: SessionContextArtifact[] = [];
	for (const item of [...collectStructuredStrings(call.arguments), ...collectStructuredStrings(result.details)]) {
		const key = item.key.toLowerCase();
		const value = item.value.trim();
		if (!value) continue;
		if (key.includes("url") || /^https?:\/\//i.test(value)) appendArtifact(artifacts, sessionId, nodeId, "url", value, "structured");
		else if (key.includes("commit") && /^[0-9a-f]{7,40}$/i.test(value)) appendArtifact(artifacts, sessionId, nodeId, "commit", value, "structured");
		else if (key.includes("image") || (IMAGE_RE.test(value) && /(?:image|asset|output)/i.test(key))) appendArtifact(artifacts, sessionId, nodeId, "image", value, "structured");
		else if (key.includes("path") || key.includes("file") || /\.[a-z0-9]{1,8}$/i.test(value)) appendArtifact(artifacts, sessionId, nodeId, IMAGE_RE.test(value) && /(?:image|asset|output)/i.test(key) ? "image" : "file", value, "structured");
	}
	const command = nonEmptyString(call.arguments.command);
	if (includeCommand && command) appendArtifact(artifacts, sessionId, nodeId, TEST_COMMAND_RE.test(command) ? "test" : "command", command, "structured");
	const legacy = `${result.text}\n${JSON.stringify(result.details ?? {})}`;
	for (const match of legacy.matchAll(URL_RE)) appendArtifact(artifacts, sessionId, nodeId, "url", match[0], "legacy_regex");
	for (const match of legacy.matchAll(COMMIT_RE)) appendArtifact(artifacts, sessionId, nodeId, "commit", match[0], "legacy_regex");
	for (const match of legacy.matchAll(FILE_RE)) if (match[1]) appendArtifact(artifacts, sessionId, nodeId, IMAGE_RE.test(match[1]) ? "image" : "file", match[1], "legacy_regex");
	return artifacts;
}

function detailRecord(result: NormalizedToolResult): Record<string, unknown> {
	return isRecord(result.details) ? result.details : {};
}

function lifecycleRecord(result: NormalizedToolResult): Record<string, unknown> {
	return isRecord(result.metadata.lifecycle) ? result.metadata.lifecycle : {};
}

function numericValue(record: Record<string, unknown>, keys: string[]): number | undefined {
	for (const key of keys) {
		const value = record[key];
		if (typeof value === "number" && Number.isFinite(value)) return value;
	}
	return undefined;
}

function structuredFailure(result: NormalizedToolResult): { failed: boolean; exitCode?: number; durationMs?: number } {
	const details = detailRecord(result);
	const lifecycle = lifecycleRecord(result);
	const exitCode = numericValue(details, ["exitCode", "code"]);
	const durationMs = numericValue(lifecycle, ["durationMs", "duration_ms"]) ?? numericValue(details, ["durationMs", "duration_ms"]);
	const lifecycleStatus = firstString(lifecycle, ["status", "state"]);
	return { failed: result.isError || (exitCode !== undefined && exitCode !== 0) || /^(?:failed|error|aborted|cancelled|canceled)$/i.test(lifecycleStatus ?? ""), ...(exitCode !== undefined ? { exitCode } : {}), ...(durationMs !== undefined ? { durationMs } : {}) };
}

function isNoise(call: NormalizedToolCall, result: NormalizedToolResult): boolean {
	const text = result.text.trim();
	if (result.prunedAt || !text || NOISE_RE.test(text) || REPETITIVE_LOG_RE.test(text)) return true;
	const action = firstString(call.arguments, ["action", "op", "operation", "type"]);
	return /^(?:poll|status|wait|list|jobs|inbox)$/i.test(action ?? "");
}

function operationDetail(call: NormalizedToolCall, fallback: string): string | undefined {
	const candidate = call.intent ?? firstString(call.arguments, ["operationDetail", "action", "target", "path", "pattern", "command"]) ?? fallback;
	const detail = safeText(candidate, 120).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
	return detail || undefined;
}

function toolChild(sessionId: string, pair: PairWork, assistantNodeId: string, call: NormalizedToolCall, result: NormalizedToolResult): ChildBuild | undefined {
	if (isNoise(call, result)) return undefined;
	const name = call.name.toLowerCase();
	const failure = structuredFailure(result);
	const command = nonEmptyString(call.arguments.command);
	const isTest = (name === "bash" || name === "eval") && Boolean(command && (TEST_COMMAND_RE.test(command) || BUILD_COMMAND_RE.test(command)));
	const mutation = name === "write" || name === "edit";
	const investigation = name === "read" || name === "grep" || name === "glob";
	const childType: NonNullable<SessionContextNode["childType"]> = failure.failed && !isTest ? "error" : isTest ? "test" : "tool_evidence";
	const operation: SessionContextOperation = isTest ? "verify" : mutation ? "modify" : "observe";
	const details = detailRecord(result);
	const passMatch = result.text.match(/\b(\d+)\s+(?:pass|passed|passes)\b/i)?.[1];
	const failMatch = result.text.match(/\b(\d+)\s+(?:fail|failed|fails|failures)\b/i)?.[1];
	const passCount = numericValue(details, ["passCount", "passed", "passes"]) ?? (passMatch ? Number(passMatch) : undefined);
	const failCount = numericValue(details, ["failCount", "failed", "failures"]) ?? (failMatch ? Number(failMatch) : undefined);
	const nodeId = `${sessionId}:pair:${pair.prompt.entryId}:tool:${call.id}`;
	const purpose = structuredPurpose(call, `${name} result`);
	const body = boundedBody([command ? `Command: ${safeText(command, 300)}` : undefined, result.text, isTest ? [passCount !== undefined ? `${passCount} pass` : undefined, failCount !== undefined ? `${failCount} fail` : undefined, failure.exitCode !== undefined ? `exitCode=${failure.exitCode}` : undefined, failure.durationMs !== undefined ? `durationMs=${failure.durationMs}` : undefined].filter(Boolean).join(", ") : undefined]);
	const detail = operationDetail(call, isTest ? "run_tests" : name);
	const node: SessionContextNode = {
		id: nodeId, sessionId, kind: childType === "error" ? "issue" : "evidence", title: safeText(`${call.name}: ${result.text}`, TITLE_LIMIT) || `${call.name} result`, body, compressedBody: safeText(body, 300), importance: childType === "error" ? 0.9 : isTest ? 0.85 : 0.65,
		createdAt: result.lifecycleEndedAt ?? eventTimestamp(pair.prompt), sourceMessageId: result.sourceEntryId, population: "assistant", nodeRole: "child", origin: "tool", childType, pairId: pair.pairId, parentNodeId: assistantNodeId, operation, ...(detail ? { operationDetail: detail } : {}), ...purpose, status: failure.failed ? "failed" : "completed",
		metadata: { toolCallId: call.id, toolName: call.name, callSourceEntryId: call.sourceEntryId, resultSourceEntryId: result.sourceEntryId, ...(command ? { command: safeText(command, 300) } : {}), ...(typeof call.arguments.path === "string" ? { path: safeText(call.arguments.path, 300) } : {}), ...(passCount !== undefined ? { passCount } : {}), ...(failCount !== undefined ? { failCount } : {}), ...(failure.exitCode !== undefined ? { exitCode: failure.exitCode } : {}), ...(failure.durationMs !== undefined ? { durationMs: failure.durationMs } : {}), rawSource: { entryId: result.sourceEntryId, toolCallId: call.id } },
	};
	return { node, artifacts: collectArtifacts(sessionId, nodeId, call, result, Boolean(command)), mutation: mutation && !failure.failed, investigation: investigation && !failure.failed };
}

function safeIdentity(value: string): string {
	return value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 100) || "unknown-agent";
}

function agentBuilds(sessionId: string, pair: PairWork, assistantNodeId: string): ChildBuild[] {
	const finalByAgentCall = new Map<string, { rawAgentId: string; agentId: string; call: NormalizedToolCall; result: NormalizedToolResult }>();
	const targetsByRawAgentId = new Map<string, string>();
	for (const call of pair.toolCalls.values()) {
		if (!/(?:agent|task|hub)/i.test(call.name)) continue;
		const result = pair.toolResults.get(call.id);
		if (!result) continue;
		const details = detailRecord(result);
		const rawAgentId = firstString(details, ["agentId", "agent_id", "id", "to"]) ?? firstString(call.arguments, ["agentId", "agent_id", "id", "to", "name"]);
		if (!rawAgentId) continue;
		const agentId = safeIdentity(rawAgentId);
		const target = firstString(call.arguments, ["target", "task", "message", "prompt", "description"]);
		if (target) targetsByRawAgentId.set(rawAgentId, safeText(target, PURPOSE_LIMIT));
		const action = firstString(call.arguments, ["action", "op", "operation", "type"]);
		const status = firstString(details, ["status", "state", "lifecycle"]);
		const conclusion = firstString(details, ["conclusion", "summary", "result", "final", "output"]);
		if (/^(?:result|final|complete|completed|done)$/i.test(action ?? "") || /^(?:completed|failed|error|aborted|cancelled|canceled|done)$/i.test(status ?? "") || conclusion) {
			finalByAgentCall.set(`${rawAgentId}\u0000${agentId}\u0000${call.id}`, { rawAgentId, agentId, call, result });
		}
	}
	return Array.from(finalByAgentCall.values()).map((item) => {
		const details = detailRecord(item.result);
		const failure = structuredFailure(item.result);
		const statusText = firstString(details, ["status", "state"]);
		const status: SessionContextNodeStatus = failure.failed || /^(?:failed|error)$/i.test(statusText ?? "") ? "failed" : /^(?:aborted|cancelled|canceled)$/i.test(statusText ?? "") ? "aborted" : "completed";
		const conclusion = firstString(details, ["conclusion", "summary", "result", "final", "output"]) ?? item.result.text;
		const mutationValue = details.mutatedFiles ?? details.mutation ?? details.mutated;
		const mutation = mutationValue === true || (Array.isArray(details.filesChanged) && details.filesChanged.length > 0);
		const target = targetsByRawAgentId.get(item.rawAgentId) ?? safeText(firstString(item.call.arguments, ["target", "task", "message", "prompt"]) ?? "delegated task", PURPOSE_LIMIT);
		const identityHash = createHash("sha256").update(item.rawAgentId).update("\u0000").update(item.call.id).digest("hex").slice(0, 32);
		const nodeId = `${sessionId}:pair:${pair.prompt.entryId}:agent:${item.agentId}:${identityHash}`;
		const body = boundedBody([conclusion]);
		const detail = operationDetail(item.call, "delegate");
		const node: SessionContextNode = { id: nodeId, sessionId, kind: mutation && status === "completed" ? "resolution" : status === "failed" ? "issue" : "evidence", title: safeText(`${item.agentId}: ${conclusion}`, TITLE_LIMIT) || `${item.agentId} result`, body, compressedBody: safeText(body, 300), importance: status === "failed" ? 0.9 : 0.75, createdAt: item.result.lifecycleEndedAt ?? eventTimestamp(pair.prompt), sourceMessageId: item.result.sourceEntryId, population: "assistant", nodeRole: "child", origin: "subagent", childType: "subagent_result", pairId: pair.pairId, parentNodeId: assistantNodeId, operation: "delegate", ...(detail ? { operationDetail: detail } : {}), purpose: target || null, purposeSource: target ? "structured_intent" : "unclassified", status, metadata: { agentId: item.agentId, rawAgentId: item.rawAgentId, delegatedTarget: target, mutation, toolCallId: item.call.id, resultSourceEntryId: item.result.sourceEntryId, rawSource: { entryId: item.result.sourceEntryId, toolCallId: item.call.id } } };
		return { node, artifacts: collectArtifacts(sessionId, nodeId, item.call, item.result, false), mutation: mutation && status === "completed", investigation: !mutation && status === "completed" };
	});
}

function taskBuilds(sessionId: string, pair: PairWork, assistantNodeId: string): ChildBuild[] {
	const latest = new Map<string, { call: NormalizedToolCall; result?: NormalizedToolResult }>();
	for (const call of pair.toolCalls.values()) {
		if (!(call.name.toLowerCase().includes("todo") || call.name.toLowerCase() === "task_state")) continue;
		const text = firstString(call.arguments, ["text", "task", "title", "description"]);
		const id = firstString(call.arguments, ["id", "taskId", "task_id"]);
		if (id || text) latest.set(id ?? text!, { call, result: pair.toolResults.get(call.id) });
	}
	return Array.from(latest.values()).map(({ call, result }) => {
		const taskText = firstString(call.arguments, ["text", "task", "title", "description"]) ?? "Task";
		const taskId = firstString(call.arguments, ["id", "taskId", "task_id"]);
		const hash = createHash("sha256").update(taskId ?? taskText).digest("hex").slice(0, 16);
		const statusValue = firstString(call.arguments, ["status", "state"]);
		const status: SessionContextNodeStatus = /^(?:complete|completed|done)$/i.test(statusValue ?? "") ? "completed" : /^(?:failed|error)$/i.test(statusValue ?? "") ? "failed" : /^(?:blocked)$/i.test(statusValue ?? "") ? "blocked" : /^(?:aborted|cancelled|canceled)$/i.test(statusValue ?? "") ? "aborted" : "pending";
		const nodeId = `${sessionId}:pair:${pair.prompt.entryId}:task:${hash}`;
		const body = boundedBody([taskText, statusValue ? `Status: ${statusValue}` : undefined]);
		const detail = operationDetail(call, "track_task");
		const node: SessionContextNode = { id: nodeId, sessionId, kind: "todo_state", title: safeText(taskText, TITLE_LIMIT) || "Task state", body, compressedBody: safeText(body, 300), importance: 0.65, createdAt: result?.lifecycleEndedAt ?? eventTimestamp(pair.prompt), sourceMessageId: result?.sourceEntryId ?? call.sourceEntryId, population: "assistant", nodeRole: "child", origin: "task", childType: "task_state", pairId: pair.pairId, parentNodeId: assistantNodeId, operation: "track", ...(detail ? { operationDetail: detail } : {}), purpose: safeText(taskText, PURPOSE_LIMIT) || null, purposeSource: taskText.trim() ? "structured_intent" : "unclassified", status, metadata: { ...(taskId ? { taskId } : {}), taskText: safeText(taskText, PURPOSE_LIMIT), toolCallId: call.id, rawSource: { entryId: result?.sourceEntryId ?? call.sourceEntryId, toolCallId: call.id } } };
		return { node, artifacts: result ? collectArtifacts(sessionId, nodeId, call, result, false) : [], mutation: false, investigation: false };
	});
}

function childBuilds(sessionId: string, pair: PairWork, assistantNodeId: string): ChildBuild[] {
	const agents = agentBuilds(sessionId, pair, assistantNodeId);
	const agentCallIds = new Set(agents.map((build) => build.node.metadata.toolCallId).filter((id): id is string => typeof id === "string"));
	const tasks = taskBuilds(sessionId, pair, assistantNodeId);
	const taskCallIds = new Set(tasks.map((build) => build.node.metadata.toolCallId).filter((id): id is string => typeof id === "string"));
	const tools: ChildBuild[] = [];
	for (const call of pair.toolCalls.values()) {
		if (agentCallIds.has(call.id) || taskCallIds.has(call.id) || /(?:agent|task|hub|todo)/i.test(call.name)) continue;
		const result = pair.toolResults.get(call.id);
		if (!result) continue;
		const build = toolChild(sessionId, pair, assistantNodeId, call, result);
		if (build) tools.push(build);
	}
	return [...tools, ...agents, ...tasks];
}

function assistantSemantics(text: string, children: ChildBuild[]): { operation: SessionContextOperation; kind: SessionContextNode["kind"] } {
	if (children.some((child) => child.mutation && child.node.status === "completed")) return { operation: /\b(?:implemented|created|added|built)\b|(?:实现|创建|添加)/i.test(text) ? "implement" : "modify", kind: "resolution" };
	if (/\b(?:plan|steps|roadmap|proposal)\b|(?:计划|步骤|方案)/i.test(text)) return { operation: "plan", kind: "decision" };
	if (children.some((child) => child.investigation && child.node.status === "completed")) return { operation: "investigate", kind: "action" };
	if (/\b(?:to explain|explanation|here is why)\b|(?:解释|原因是)/i.test(text)) return { operation: "explain", kind: "action" };
	if (/\b(?:summary|to summarize|in summary)\b|(?:总结|概括)/i.test(text)) return { operation: "summarize", kind: "action" };
	if (/\b(?:report|results are|findings)\b|(?:报告|结果如下|发现如下)/i.test(text)) return { operation: "report", kind: "action" };
	return { operation: text.trim() ? "answer" : "unknown", kind: "action" };
}

function collectAssistantArtifacts(sessionId: string, nodeId: string, text: string): SessionContextArtifact[] {
	const artifacts: SessionContextArtifact[] = [];
	for (const match of text.matchAll(URL_RE)) appendArtifact(artifacts, sessionId, nodeId, "url", match[0], "legacy_regex");
	for (const match of text.matchAll(COMMIT_RE)) appendArtifact(artifacts, sessionId, nodeId, "commit", match[0], "legacy_regex");
	for (const match of text.matchAll(FILE_RE)) if (match[1]) appendArtifact(artifacts, sessionId, nodeId, IMAGE_RE.test(match[1]) ? "image" : "file", match[1], "legacy_regex");
	return artifacts;
}

function finishPair(sessionId: string, pair: PairWork, finalEvent: NormalizedSessionEvent | undefined, fallback: boolean, nodes: SessionContextNode[], edges: ExtractedSessionContext["edges"], artifacts: SessionContextArtifact[]): void {
	if (!finalEvent || !finalEvent.text.trim()) {
		pair.userNode.status = pair.closeReason === "error" ? "failed" : pair.closeReason === "aborted" ? "aborted" : "unknown";
		pair.userNode.metadata = { ...pair.userNode.metadata, pairCloseReason: pair.closeReason ?? "unanswered" };
		return;
	}
	const assistantNodeId = `${sessionId}:entry:${finalEvent.entryId}:message`;
	const builtChildren = childBuilds(sessionId, pair, assistantNodeId);
	const semantics = assistantSemantics(finalEvent.text, builtChildren);
	const purpose = explicitPurpose(finalEvent.text);
	const body = redactSensitiveText(finalEvent.text).slice(0, BODY_LIMIT);
	const status = assistantStatus(finalEvent, fallback);
	const assistantNode: SessionContextNode = { id: assistantNodeId, sessionId, kind: semantics.kind, title: safeText(finalEvent.text, TITLE_LIMIT) || "Assistant answer", body, compressedBody: safeText(body, 300), importance: 0.9, createdAt: eventTimestamp(finalEvent), sourceMessageId: finalEvent.entryId, sourceTurnIndex: finalEvent.sourceLine, population: "assistant", nodeRole: "main", origin: "assistant", pairId: pair.pairId, operation: semantics.operation, ...purpose, status, metadata: sourceMetadata(finalEvent, fallback ? { answerBoundarySource: "missing_stop_reason_fallback" } : { answerBoundarySource: "stop_reason", stopReason: finalEvent.stopReason }) };
	pair.userNode.status = status === "completed" ? "completed" : status;
	pair.userNode.metadata = { ...pair.userNode.metadata, pairCloseReason: "answered", answerMessageId: finalEvent.entryId };
	nodes.push(assistantNode, ...builtChildren.map((build) => build.node));
	edges.push({ id: `${assistantNode.id}:answers:${pair.userNode.id}`, sessionId, sourceNodeId: assistantNode.id, targetNodeId: pair.userNode.id, relation: "answers", weight: 1, evidenceMessageId: finalEvent.entryId, metadata: { pairId: pair.pairId, source: "deterministic_pair_boundary" } });
	artifacts.push(...collectAssistantArtifacts(sessionId, assistantNode.id, finalEvent.text));
	for (const build of builtChildren) artifacts.push(...build.artifacts);
}

export function buildConversationTopology(input: { sessionId: string; events: NormalizedSessionEvent[] }): ExtractedSessionContext {
	const nodes: SessionContextNode[] = [];
	const edges: ExtractedSessionContext["edges"] = [];
	const artifacts: SessionContextArtifact[] = [];
	let openPair: PairWork | undefined;
	const closeOpenPair = (): void => {
		if (!openPair) return;
		const candidate = openPair.assistantCandidates.at(-1);
		openPair.closeReason = candidate ? "answered" : "unanswered";
		finishPair(input.sessionId, openPair, candidate, Boolean(candidate), nodes, edges, artifacts);
		openPair = undefined;
	};
	for (const event of input.events) {
		if (event.role === "user" && !event.synthetic) {
			closeOpenPair();
			const pairId = `${input.sessionId}:pair:${event.entryId}`;
			const userNode = makeUserNode(input.sessionId, event, pairId);
			nodes.push(userNode);
			openPair = { prompt: event, pairId, userNode, toolCalls: new Map(), toolResults: new Map(), assistantCandidates: [] };
			continue;
		}
		if (!openPair) continue;
		for (const toolCall of event.toolCalls) openPair.toolCalls.set(toolCall.id, toolCall);
		if (event.toolResult) openPair.toolResults.set(event.toolResult.toolCallId, event.toolResult);
		if (event.role !== "assistant") continue;
		const reason = normalizeStopReason(event.stopReason);
		if (reason === "tooluse" || reason === "tool_use") continue;
		if (reason === "error" || reason === "aborted" || reason === "abort" || reason === "cancelled" || reason === "canceled") {
			openPair.closeReason = reason === "error" ? "error" : "aborted";
			finishPair(input.sessionId, openPair, undefined, false, nodes, edges, artifacts);
			openPair = undefined;
			continue;
		}
		if (!event.text.trim()) continue;
		if (reason === "stop" || reason === "length") {
			finishPair(input.sessionId, openPair, event, false, nodes, edges, artifacts);
			openPair = undefined;
		} else openPair.assistantCandidates.push(event);
	}
	closeOpenPair();
	return { nodes, edges, artifacts };
}
