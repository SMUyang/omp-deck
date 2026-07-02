import type {
	SessionContextArtifact,
	SessionContextEdge,
	SessionContextNode,
	SessionContextPackResponse,
	SessionContextRawRef,
} from "@omp-deck/protocol";

export interface ExtractInput {
	sessionId: string;
	content: string;
}

export interface ExtractedSessionContext {
	nodes: SessionContextNode[];
	edges: SessionContextEdge[];
	artifacts: SessionContextArtifact[];
}

export interface RenderPackInput extends ExtractedSessionContext {
	sessionId: string;
	query: string;
	budget: number;
}

const FILE_RE = /(?:^|\s)([\w./~@-]+\.(?:ts|tsx|js|jsx|json|md|sql|yaml|yml|sh|ps1))(?:\b|$)/g;
const COMMIT_RE = /\b[0-9a-f]{7,40}\b/g;
const TEST_COMMAND_RE = /\b(?:bun|npm|pnpm|yarn)\s+(?:test|run)[^\n]*/g;

function parseJsonLine(line: string): Record<string, unknown> | undefined {
	try {
		const parsed = JSON.parse(line) as unknown;
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined;
	} catch {
		return undefined;
	}
}

function textFromContent(value: unknown): string {
	if (typeof value === "string") return value;
	if (Array.isArray(value)) {
		return value
			.map((item) => {
				if (typeof item === "string") return item;
				if (!item || typeof item !== "object") return "";
				const obj = item as Record<string, unknown>;
				return typeof obj.text === "string" ? obj.text : "";
			})
			.filter(Boolean)
			.join("\n");
	}
	return "";
}

function messageParts(
	record: Record<string, unknown>,
	lineNumber: number,
): { id: string; role: string; text: string; timestamp: string } | undefined {
	if (record.type !== "message") return undefined;
	const message = record.message;
	if (!message || typeof message !== "object") return undefined;
	const msg = message as Record<string, unknown>;
	const role = typeof msg.role === "string" ? msg.role : "unknown";
	const text = textFromContent(msg.content);
	if (!text.trim()) return undefined;
	const idValue = record.id;
	const id = typeof idValue === "string" && idValue.trim() ? idValue : `line-${lineNumber}`;
	const timestampValue = record.timestamp;
	const timestamp = typeof timestampValue === "string" ? timestampValue : new Date(0).toISOString();
	return { id, role, text, timestamp };
}

function compressText(text: string): string {
	return text
		.replace(/\s+/g, " ")
		.replace(/\b(?:I think|I should|Maybe|Now|Next)\b[:,]?\s*/gi, "")
		.trim()
		.slice(0, 1200);
}

function makeNode(input: {
	sessionId: string;
	kind: SessionContextNode["kind"];
	messageId: string;
	turnIndex: number;
	title: string;
	body: string;
	importance: number;
	createdAt: string;
	metadata?: Record<string, unknown>;
}): SessionContextNode {
	return {
		id: `${input.sessionId}:${input.kind}:${input.turnIndex}:${input.messageId}`,
		sessionId: input.sessionId,
		kind: input.kind,
		title: input.title.slice(0, 120),
		body: input.body,
		compressedBody: compressText(input.body),
		importance: input.importance,
		createdAt: input.createdAt,
		sourceMessageId: input.messageId,
		sourceTurnIndex: input.turnIndex,
		metadata: input.metadata ?? {},
	};
}

function classifyUserText(text: string): SessionContextNode["kind"] {
	if (/希望|不是|而是|纠正|改成|不要|必须|must|should|instead/i.test(text)) return "user_intent";
	return "goal";
}

function classifyNonUserText(role: string, text: string): SessionContextNode["kind"] | undefined {
	if (role === "tool") {
		// Strip benign zero-count summaries ("0 fail", "0 failures", "0 errors") so only
		// genuine failure/error signals remain. This lets a mixed report like
		// "Unit: 0 failures\nE2E: exit 1 error" still surface as an issue.
		const stripped = text.replace(/\b0\s+(?:fails?|failures?|errors?)\b/gi, "");
		// Stem-aware matchers catch inflected forms: fail, failure(s), failed, error(s).
		const hasFailure =
			/\bfail(?:ures?|ed)?\b/i.test(stripped) ||
			/\berrors?\b/i.test(stripped) ||
			/\bexit\s*[12]\b/i.test(stripped);
		if (hasFailure) return "issue";
		// Benign tool output: passing tests, status codes, HTTP responses without failure words.
		if (/\b(?:pass|HTTP|status:)\b/i.test(text)) return "evidence";
	}
	if (/\b(?:decision|recommend|architecture|选择|推荐|决定)\b/i.test(text)) return "decision";
	return undefined;
}

function artifactMatches(sessionId: string, nodeId: string, text: string): SessionContextArtifact[] {
	const artifacts: SessionContextArtifact[] = [];
	for (const match of text.matchAll(FILE_RE)) {
		const ref = match[1];
		if (!ref) continue;
		artifacts.push({ id: `${nodeId}:file:${artifacts.length}`, sessionId, nodeId, kind: "file", ref, label: ref, metadata: {} });
	}
	for (const match of text.matchAll(COMMIT_RE)) {
		const ref = match[0];
		artifacts.push({ id: `${nodeId}:commit:${artifacts.length}`, sessionId, nodeId, kind: "commit", ref, label: ref.slice(0, 12), metadata: {} });
	}
	for (const match of text.matchAll(TEST_COMMAND_RE)) {
		const ref = match[0];
		artifacts.push({ id: `${nodeId}:test:${artifacts.length}`, sessionId, nodeId, kind: "test", ref, label: ref, metadata: {} });
	}
	return artifacts;
}

export function extractSessionContextFromJsonl(input: ExtractInput): ExtractedSessionContext {
	const nodes: SessionContextNode[] = [];
	const edges: SessionContextEdge[] = [];
	const artifacts: SessionContextArtifact[] = [];
	let lastGoal: SessionContextNode | undefined;
	let lastIssue: SessionContextNode | undefined;
	let turnIndex = 0;

	const lines = input.content.split(/\r?\n/);
	for (let lineNumber = 0; lineNumber < lines.length; lineNumber++) {
		const line = (lines[lineNumber] ?? "").trim();
		if (!line) continue;
		const record = parseJsonLine(line);
		if (!record) continue;
		const message = messageParts(record, lineNumber);
		if (!message) continue;
		turnIndex += 1;

		const kind = message.role === "user" ? classifyUserText(message.text) : classifyNonUserText(message.role, message.text);
		if (!kind) continue;
		const node = makeNode({
			sessionId: input.sessionId,
			kind,
			messageId: message.id,
			turnIndex,
			title: message.text.split(/\r?\n/)[0] ?? kind,
			body: message.text,
			importance: kind === "user_intent" ? 1 : kind === "evidence" ? 0.85 : 0.7,
			createdAt: message.timestamp,
			metadata: { role: message.role },
		});
		nodes.push(node);
		artifacts.push(...artifactMatches(input.sessionId, node.id, message.text));

		if (kind === "goal") lastGoal = node;
		if (kind === "issue") lastIssue = node;
		if (kind === "user_intent" && lastGoal) {
			edges.push({
				id: `${node.id}:supersedes:${lastGoal.id}`,
				sessionId: input.sessionId,
				sourceNodeId: node.id,
				targetNodeId: lastGoal.id,
				relation: "supersedes",
				weight: 1,
				evidenceMessageId: message.id,
				metadata: {},
			});
		}
		if (kind === "evidence" && lastIssue) {
			edges.push({
				id: `${lastIssue.id}:verified_by:${node.id}`,
				sessionId: input.sessionId,
				sourceNodeId: lastIssue.id,
				targetNodeId: node.id,
				relation: "verified_by",
				weight: 0.9,
				evidenceMessageId: message.id,
				metadata: {},
			});
		}
	}

	return { nodes, edges, artifacts };
}

function scoreNode(node: SessionContextNode, query: string): number {
	const q = query.trim().toLowerCase();
	let score = node.importance;
	if (q && `${node.title}\n${node.body}`.toLowerCase().includes(q)) score += 2;
	if (node.kind === "user_intent" || node.kind === "constraint") score += 1.5;
	if (node.kind === "issue" || node.kind === "evidence") score += 1;
	return score;
}

function byKinds(nodes: SessionContextNode[], kinds: SessionContextNode["kind"][]): SessionContextNode[] {
	const wanted = new Set(kinds);
	return nodes.filter((node) => wanted.has(node.kind));
}

function rawRefsFor(nodes: SessionContextNode[], artifacts: SessionContextArtifact[]): SessionContextRawRef[] {
	const refs: SessionContextRawRef[] = [];
	for (const node of nodes) {
		refs.push({ messageId: node.sourceMessageId, turnIndex: node.sourceTurnIndex, label: `${node.kind}: ${node.title}` });
	}
	for (const artifact of artifacts.slice(0, 20)) {
		refs.push({ artifactId: artifact.id, label: `${artifact.kind}: ${artifact.label}` });
	}
	return refs;
}

export function renderSessionContextPack(input: RenderPackInput): SessionContextPackResponse {
	const ranked = [...input.nodes].sort((a, b) => scoreNode(b, input.query) - scoreNode(a, input.query));
	let remaining = Math.max(500, input.budget);
	const selected: SessionContextNode[] = [];
	for (const node of ranked) {
		const cost = node.compressedBody.length + node.title.length + 64;
		if (selected.length > 0 && cost > remaining) continue;
		selected.push(node);
		remaining -= cost;
		if (remaining < 0) {
			// The mandatory anchor (first selected node) exceeded the budget: keep it and
			// stop so `remaining` never goes negative, which would otherwise suppress every
			// later node. Clamping to 0 keeps omitted counts coherent.
			remaining = 0;
			break;
		}
	}
	const selectedIds = new Set(selected.map((node) => node.id));
	const artifacts = input.artifacts.filter((artifact) => !artifact.nodeId || selectedIds.has(artifact.nodeId));
	const summary = selected.slice(0, 8).map((node) => `${node.kind}: ${node.compressedBody}`).join("\n");
	return {
		sessionId: input.sessionId,
		query: input.query,
		budget: input.budget,
		summary,
		goals: byKinds(selected, ["goal", "user_intent"]),
		constraints: byKinds(selected, ["constraint"]),
		decisions: byKinds(selected, ["decision"]),
		issues: byKinds(selected, ["issue"]),
		resolutions: byKinds(selected, ["resolution"]),
		artifacts,
		evidence: byKinds(selected, ["evidence"]),
		openTodos: byKinds(selected, ["todo_state"]),
		rawRefs: rawRefsFor(selected, artifacts),
		omitted: {
			nodeCount: input.nodes.length - selected.length,
			edgeCount: input.edges.filter((edge) => !selectedIds.has(edge.sourceNodeId) || !selectedIds.has(edge.targetNodeId)).length,
			reason: selected.length < input.nodes.length ? "budget" : "none",
		},
	};
}
