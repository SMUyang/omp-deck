/**
 * Standalone topology extraction engine.
 *
 * Reads session JSONL files, classifies messages into topology nodes
 * (goals, decisions, evidence, issues, etc.), and builds edges between
 * them. Designed to run inside an OMP extension without a server.
 *
 * Extraction is intentionally regex-based (no LLM dependency) and
 * yields to the event loop every CHUNK_LINES to avoid blocking.
 */

import type {
	TopologyNode,
	TopologyEdge,
	TopologyArtifact,
	ExtractedTopology,
	NodeKind,
} from "./types.ts";

const FILE_RE = /(?:^|\s)([\w./~@-]+\.(?:ts|tsx|js|jsx|json|md|sql|yaml|yml|sh|ps1))(?:\b|$)/g;
const COMMIT_RE = /\b[0-9a-f]{7,40}\b/g;
const TEST_COMMAND_RE = /\b(?:bun|npm|pnpm|yarn)\s+(?:test|run)[^\n]*/g;

// Note: \b doesn't work for CJK characters — removed for Chinese keywords.
const GOAL_RE = /(?:\b(?:goal|objective|target|aim)\b|目标|任务|需求)/i;
const CONSTRAINT_RE = /(?:\b(?:constraint|requirement|must|cannot)\b|限制|约束|必须|不能)/i;
const DECISION_RE = /(?:\b(?:decision|recommend|architecture|select)\b|选择|推荐|决定|方案)/i;

const TOOL_NOISE_RE = /^\s*(?:\[Superseded by a newer read of this file\]|Skipped due to queued user message|\(no output\)|Background job \w+|## (?:Completed|Still Running)|Spawned agent|Remaining ite)/;

function parseJsonLine(line: string): Record<string, unknown> | undefined {
	try {
		const parsed = JSON.parse(line);
		return typeof parsed === "object" && parsed !== null ? parsed as Record<string, unknown> : undefined;
	} catch {
		return undefined;
	}
}

function textFromContent(value: unknown): string {
	if (typeof value === "string") return value;
	if (Array.isArray(value)) {
		return value.map((part) => {
			if (typeof part === "string") return part;
			if (typeof part === "object" && part !== null) {
				const record = part as Record<string, unknown>;
				if (typeof record.text === "string") return record.text;
				if (typeof record.content === "string") return record.content;
			}
			return "";
		}).join("");
	}
	return "";
}

function messageParts(record: Record<string, unknown>): {
	id: string;
	role: string;
	text: string;
	timestamp: string;
} | undefined {
	const type = record.type as string | undefined;
	if (type !== "message") return undefined;
	// OMP JSONL nests role/content inside a `message` envelope:
	// { type: "message", id: "...", message: { role: "user", content: [...] } }
	const msg = typeof record.message === "object" && record.message !== null
		? record.message as Record<string, unknown>
		: undefined;
	const role = (msg?.role ?? record.role) as string | undefined;
	if (!role) return undefined;
	const content = msg?.content ?? record.content;
	const text = textFromContent(content).trim();
	if (!text) return undefined;
	const id = String(record.id ?? `${role}-${record.timestamp ?? Date.now()}`);
	const timestamp = String(record.timestamp ?? new Date().toISOString());
	return { id, role, text, timestamp };
}

// Bug REPORT (not fix request): requires a report verb before the bug keyword.
// "帮我修 auth bug" = request → user_intent; "这是个 bug" = report → issue.
const USER_ISSUE_RE = /(?:发现|出现了?|有个?|是个?|遇到|存在|报错|失败|异常|坏了|有问题).{0,15}(?:bug|错误|问题)/i;

function classifyUserText(text: string): NodeKind | undefined {
	if (CONSTRAINT_RE.test(text)) return "constraint";
	if (GOAL_RE.test(text)) return "goal";
	// Bug reports become issue nodes so resolved_by edges can form
	if (USER_ISSUE_RE.test(text)) return "issue";
	return "user_intent";
}

function isToolNoiseContent(text: string): boolean {
	return TOOL_NOISE_RE.test(text);
}
const ACTION_RE = /(?:\b(?:wrote|created|modified|updated|deleted|fixed|implemented|refactored|added|removed|installed|ran|executed)\b|完成|修改|创建|修复|实现|添加|删除)/i;

function classifyNonUserText(role: string, text: string): NodeKind | undefined {
	// OMP uses camelCase "toolResult"; also handle "tool" and "tool_result"
	if (role === "tool" || role === "tool_result" || role === "toolResult") {
		if (isToolNoiseContent(text)) return undefined;
		const lower = text.toLowerCase();
		if ((lower.includes("fail") || lower.includes("error")) && /\d/.test(text) && !lower.includes("0 fail")) {
			return "issue";
		}
		return "evidence";
	}
	if (role === "assistant") {
		if (DECISION_RE.test(text)) return "decision";
		if (/```[\s\S]*?```/m.test(text)) return "resolution";
		if (ACTION_RE.test(text) && text.length > 20) return "action";
		return undefined;
	}
	return undefined;
}

function artifactMatches(nodeId: string, text: string): TopologyArtifact[] {
	const artifacts: TopologyArtifact[] = [];
	for (const match of text.matchAll(FILE_RE)) {
		const ref = match[1] ?? "";
		if (ref) artifacts.push({ id: `${nodeId}:file:${artifacts.length}`, sessionId: "", nodeId, kind: "file", ref, label: ref });
	}
	for (const match of text.matchAll(COMMIT_RE)) {
		const ref = match[0];
		artifacts.push({ id: `${nodeId}:commit:${artifacts.length}`, sessionId: "", nodeId, kind: "commit", ref, label: ref.slice(0, 12) });
	}
	for (const match of text.matchAll(TEST_COMMAND_RE)) {
		const ref = match[0];
		artifacts.push({ id: `${nodeId}:test:${artifacts.length}`, sessionId: "", nodeId, kind: "test", ref, label: ref });
	}
	return artifacts;
}

function compressText(text: string): string {
	const lines = text.split(/\r?\n/).filter((l) => l.trim());
	if (lines.length <= 3) return text.slice(0, 500);
	return lines.slice(0, 2).join(" ").slice(0, 500);
}

const CHUNK_LINES = 200;

/**
 * Extract topology from session JSONL content.
 * Yields to the event loop every CHUNK_LINES lines.
 */
export async function extractTopology(sessionId: string, content: string): Promise<ExtractedTopology> {
	const nodes: TopologyNode[] = [];
	const edges: TopologyEdge[] = [];
	const artifacts: TopologyArtifact[] = [];
	let lastGoal: TopologyNode | undefined;
	let turnIndex = 0;

	const lines = content.split(/\r?\n/);
	for (let i = 0; i < lines.length; i++) {
		if (i > 0 && i % CHUNK_LINES === 0) await Bun.sleep(0);

		const line = (lines[i] ?? "").trim();
		if (!line) continue;
		const record = parseJsonLine(line);
		if (!record) continue;
		const message = messageParts(record);
		if (!message) continue;
		turnIndex++;

		const kind = message.role === "user"
			? classifyUserText(message.text)
			: classifyNonUserText(message.role, message.text);
		if (!kind) continue;

		const node: TopologyNode = {
			id: `${sessionId}:${message.id}`,
			sessionId,
			kind,
			messageId: message.id,
			turnIndex,
			title: message.text.split(/\r?\n/)[0]?.slice(0, 200) ?? kind,
			body: compressText(message.text),
			importance: kind === "user_intent" ? 1 : kind === "evidence" ? 0.85 : 0.7,
			createdAt: message.timestamp,
			metadata: { role: message.role },
		};
		nodes.push(node);
		artifacts.push(...artifactMatches(node.id, message.text).map((a) => ({ ...a, sessionId })));

		if (kind === "goal") {
			if (lastGoal) {
				edges.push({
					id: `${node.id}:continues:${lastGoal.id}`,
					sessionId,
					sourceNodeId: node.id,
					targetNodeId: lastGoal.id,
					relation: "continues",
					weight: 0.65,
					metadata: {},
				});
			}
			lastGoal = node;
		}
		if (kind === "decision" && lastGoal) {
			edges.push({
				id: `${node.id}:depends_on:${lastGoal.id}`,
				sessionId,
				sourceNodeId: node.id,
				targetNodeId: lastGoal.id,
				relation: "depends_on",
				weight: 0.7,
				metadata: {},
			});
		}
	}

	return { nodes, edges, artifacts };
}

const SUPERSEDE_RE = /(?:改成|换成|不要了|不用了|还是|改回|switch|change|instead|replace)/i;

/** Lightweight tokenizer for issue-resolution matching (ASCII words + CJK bigrams). */
function tokenizeWords(text: string): string[] {
	const tokens: string[] = [];
	const lower = text.toLowerCase();
	for (const seg of lower.split(/[^a-z0-9\u4e00-\u9fff]+/u)) {
		if (!seg) continue;
		const cjk = seg.match(/[\u4e00-\u9fff]/gu);
		if (cjk && cjk.length === seg.length) {
			for (let i = 0; i < seg.length - 1; i++) tokens.push(seg.slice(i, i + 2));
		} else if (seg.length >= 3) {
			tokens.push(seg);
		}
	}
	return tokens;
}

/**
 * Extract topology from pre-parsed AgentMessage[] (from OMP events).
 * This is the primary extraction path — no JSONL parsing needed.
 * Each message has { role: string, content: ContentBlock[] | string }.
 */
export async function extractFromMessages(
	sessionId: string,
	messages: readonly Record<string, unknown>[],
): Promise<ExtractedTopology> {
	const nodes: TopologyNode[] = [];
	const edges: TopologyEdge[] = [];
	const artifacts: TopologyArtifact[] = [];
	let lastGoal: TopologyNode | undefined;
	let openIssues: TopologyNode[] = [];
	let lastResolution: TopologyNode | undefined;
 	let turnIndex = 0;

	for (let i = 0; i < messages.length; i++) {
		if (i > 0 && i % 50 === 0) await Bun.sleep(0);

		const msg = messages[i];
		if (!msg) continue;

		// AgentMessage has role/content at top level (from OMP events)
		const role = typeof msg.role === "string" ? msg.role : null;
		if (!role) continue;

		const content = msg.content;
		const text = textFromContent(content).trim();
		if (!text) continue;
		turnIndex++;

		const kind = role === "user" ? classifyUserText(text) : classifyNonUserText(role, text);
		if (!kind) continue;

		const messageId = String(msg.id ?? `${role}-${turnIndex}`);
		const node: TopologyNode = {
			id: `${sessionId}:${messageId}`,
			sessionId,
			kind,
			messageId,
			turnIndex,
			title: text.split(/\r?\n/)[0]?.slice(0, 200) ?? kind,
			body: compressText(text),
			importance: kind === "user_intent" ? 1 : kind === "evidence" ? 0.85 : 0.7,
			createdAt: typeof msg.timestamp === "string" ? msg.timestamp : new Date().toISOString(),
			metadata: { role },
		};
		nodes.push(node);
		artifacts.push(...artifactMatches(node.id, text).map((a) => ({ ...a, sessionId })));

		// Supersession detection
		if (role === "user" && SUPERSEDE_RE.test(text) && kind === "user_intent") {
			for (let j = nodes.length - 2; j >= 0; j--) {
				const prev = nodes[j]!;
				if (prev.kind !== "user_intent") continue;
				edges.push({
					id: `${node.id}:supersedes:${prev.id}`, sessionId,
					sourceNodeId: node.id, targetNodeId: prev.id,
					relation: "supersedes", weight: 0.9, metadata: {},
				});
				break;
			}
		}

		// Issue tracking: add to open issues for later resolution matching
		if (kind === "issue") {
			openIssues.push(node);
		}

		// Resolution → connect to most similar open issue via resolved_by
		if (kind === "resolution" && openIssues.length > 0) {
			let bestIssue: TopologyNode | undefined;
			let bestScore = 0;
			const resArtifacts = new Set(artifactMatches(node.id, text).map((a) => a.ref.toLowerCase()));
			for (const issue of openIssues) {
				const issueTokens = new Set(tokenizeWords(issue.title + " " + issue.body));
				const resTokens = new Set(tokenizeWords(node.title + " " + node.body));
				let overlap = 0;
				for (const t of resTokens) { if (issueTokens.has(t)) overlap++; }
				const lexicalScore = issueTokens.size > 0 ? overlap / issueTokens.size : 0;
				const issueArtifacts = new Set(artifactMatches(issue.id, issue.body).map((a) => a.ref.toLowerCase()));
				const artifactOverlap = [...resArtifacts].filter((a) => issueArtifacts.has(a)).length;
				const totalScore = 0.5 * lexicalScore + 0.3 * (artifactOverlap > 0 ? 1 : 0) + 0.2 * (1 - Math.abs(issue.turnIndex - node.turnIndex) / 100);
				if (totalScore > bestScore && totalScore > 0.15) {
					bestScore = totalScore;
					bestIssue = issue;
				}
			}
			if (bestIssue) {
				edges.push({
					id: `${bestIssue.id}:resolved_by:${node.id}`, sessionId,
					sourceNodeId: bestIssue.id, targetNodeId: node.id,
					relation: "resolved_by", weight: bestScore, metadata: {},
				});
				openIssues = openIssues.filter((i) => i.id !== bestIssue!.id);
				lastResolution = node;
			}
		}

		// Evidence with "pass" → connect to last resolution via verified_by
		if (kind === "evidence" && lastResolution && /pass/i.test(text)) {
			edges.push({
				id: `${lastResolution.id}:verified_by:${node.id}`, sessionId,
				sourceNodeId: lastResolution.id, targetNodeId: node.id,
				relation: "verified_by", weight: 0.8, metadata: {},
			});
		}

		if (kind === "goal") {
			if (lastGoal) {
				edges.push({
					id: `${node.id}:continues:${lastGoal.id}`, sessionId,
					sourceNodeId: node.id, targetNodeId: lastGoal.id,
					relation: "continues", weight: 0.65, metadata: {},
				});
			}
			lastGoal = node;
		}
		if (kind === "decision" && lastGoal) {
			edges.push({
				id: `${node.id}:depends_on:${lastGoal.id}`, sessionId,
				sourceNodeId: node.id, targetNodeId: lastGoal.id,
				relation: "depends_on", weight: 0.7, metadata: {},
			});
		}
	}

	return { nodes, edges, artifacts };
}
