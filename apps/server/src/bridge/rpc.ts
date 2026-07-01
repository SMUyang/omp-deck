/**
 * External omp backend via `omp --mode rpc`.
 *
 * Each deck session spawns one omp subprocess. Model listing reuses a shared
 * transport so /api/models responds fast. Session events from the RPC process
 * are forwarded directly to the WS layer — the wire shape is identical to the
 * in-process bridge because both originate from the same SDK event stream.
 *
 * Enable with: OMP_DECK_AGENT_BACKEND=rpc  (default omp binary on PATH)
 *           or: OMP_DECK_OMP_BIN=/path/to/omp
 *
 * Not yet covered (graceful degradation):
 *   - plan-mode enter/exit/respond (throws)
 *   - queue edit/cancel by id (returns false)
 *   - extension custom UI beyond select/confirm/input forwarding
 */
import type {
	AgentMessageJson,
	AgentSessionEventJson,
	ContextUsage,
	ExtUiDialogResponse,
	ImageAttachment,
	ModelInfo,
	ModelRef,
	PendingPlanApprovalWire,
	PlanModeContextWire,
	QueuedPromptWire,
	ServerFrame,
	SessionSnapshot,
	SessionSummary,
} from "@omp-deck/protocol";

import type { DeckSlashResult } from "../deck-slash-commands.ts";
import type {
	AgentBridge,
	CreateSessionOpts,
	EventListener,
	PlanApprovalResponse,
	ResumeSessionOpts,
	SessionHandle,
	SlashDispatchResult,
	RuntimeEnvUpdate,
} from "./types.ts";

import type { RpcCommandBody, RpcEvent } from "./rpc-transport.ts";
import { OmpRpcTransport } from "./rpc-transport.ts";
import * as path from "node:path";
import { getAgentDir } from "@oh-my-pi/pi-coding-agent";
import { logger } from "../log.ts";
import { buildLiveSessionStatusText } from "../session-status.ts";

const log = logger("rpc-bridge");

// ─── RPC response shapes (subset of the omp --mode rpc protocol) ──────

interface RpcModel {
	provider: string;
	id: string;
	name?: string;
	contextWindow?: number;
	input?: string[];
}

interface RpcModelsData {
	models: RpcModel[];
}

interface RpcStateData {
	sessionId: string;
	sessionFile?: string;
	sessionName?: string;
	cwd?: string;
	model?: { provider: string; id: string };
	thinkingLevel?: string;
	isStreaming: boolean;
	messageCount: number;
	queuedMessageCount: number;
	todoPhases: unknown[];
	contextUsage?: ContextUsage;
}

interface RpcMessagesData {
	messages: AgentMessageJson[];
}

interface RpcSubagentSubscriptionResponse {
	level: "off" | "progress" | "events";
}

async function enableSubagentProgress(transport: OmpRpcTransport): Promise<void> {
	try {
		const result = await transport.send<RpcSubagentSubscriptionResponse>({
			type: "set_subagent_subscription",
			level: "progress",
		});
		log.info(`subagent subscription enabled (${result.level})`);
	} catch (err) {
		log.warn("set_subagent_subscription failed", err);
	}
}

// ─── Conversion ───────────────────────────────────────────────────────

function rpcModelToInfo(model: RpcModel, current?: ModelRef): ModelInfo {
	const info: ModelInfo = {
		provider: model.provider,
		id: model.id,
		label: model.name ?? model.id,
		isAvailable: true,
	};
	if (typeof model.contextWindow === "number" && model.contextWindow > 0) {
		info.contextWindow = model.contextWindow;
	}
	if (Array.isArray(model.input) && model.input.length > 0) {
		info.inputModes = model.input.filter(
			(m): m is "text" | "image" => m === "text" || m === "image",
		);
	}
	if (current && current.provider === info.provider && current.id === info.id) {
		info.isCurrent = true;
	}
	return info;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function extractState(value: unknown): RpcStateData {
	if (!isRecord(value)) throw new Error("RPC get_state returned non-object");
	const sessionId = typeof value.sessionId === "string" ? value.sessionId : "";
	if (!sessionId) throw new Error("RPC get_state missing sessionId");
	return {
		sessionId,
		sessionFile: typeof value.sessionFile === "string" ? value.sessionFile : undefined,
		sessionName: typeof value.sessionName === "string" ? value.sessionName : undefined,
		cwd: typeof value.cwd === "string" ? value.cwd : undefined,
		model: isRecord(value.model)
			? {
					provider: String(value.model.provider ?? ""),
					id: String(value.model.id ?? ""),
				}
			: undefined,
		thinkingLevel: typeof value.thinkingLevel === "string" ? value.thinkingLevel : undefined,
		isStreaming: value.isStreaming === true,
		messageCount: typeof value.messageCount === "number" ? value.messageCount : 0,
		queuedMessageCount: typeof value.queuedMessageCount === "number" ? value.queuedMessageCount : 0,
		todoPhases: Array.isArray(value.todoPhases) ? value.todoPhases : [],
		contextUsage: isRecord(value.contextUsage)
			? (value.contextUsage as unknown as ContextUsage) // RPC shape matches SDK ContextUsage
			: undefined,
	};
}

// ─── Disk-based session listing ───────────────────────────────────────

interface SessionHeader {
	readonly id: string;
	readonly cwd: string;
	readonly title?: string;
	readonly timestamp: string;
}

interface SessionSummaryFromJsonlOptions {
	readonly fullPath: string;
	readonly content: string;
	readonly modifiedAt: Date;
	readonly cwdFilter?: string;
}

function parseJsonLine(line: string): Record<string, unknown> | undefined {
	try {
		const parsed: unknown = JSON.parse(line);
		return isRecord(parsed) ? parsed : undefined;
	} catch {
		return undefined;
	}
}

function normalizedTitle(value: unknown): string | null | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.replace(/[\x00-\x1F\x7F]/g, "").trim();
	return trimmed ? trimmed : null;
}

function parseSessionHeader(record: Record<string, unknown>, titleOverride?: string | null): SessionHeader | undefined {
	if (record.type !== "session") return undefined;
	const id = typeof record.id === "string" ? record.id : "";
	const cwd = typeof record.cwd === "string" ? record.cwd : "";
	const timestamp = typeof record.timestamp === "string" ? record.timestamp : "";
	if (!id || !timestamp) return undefined;
	const headerTitle = typeof record.title === "string" ? record.title : undefined;
	const title = titleOverride === null ? undefined : (titleOverride ?? headerTitle);
	return { id, cwd, title, timestamp };
}

function parseSessionHeaderFromJsonl(content: string): SessionHeader | undefined {
	let titleOverride: string | null | undefined;
	let firstNonEmpty = true;
	for (const rawLine of content.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line) continue;
		const record = parseJsonLine(line);
		if (!record) return undefined;
		if (firstNonEmpty && record.type === "title") {
			titleOverride = normalizedTitle(record.title);
			firstNonEmpty = false;
			continue;
		}
		return parseSessionHeader(record, titleOverride);
	}
	return undefined;
}

function countMessageEntries(content: string): number {
	let count = 0;
	for (const rawLine of content.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line) continue;
		const record = parseJsonLine(line);
		if (record?.type === "message") count++;
	}
	return count;
}

export function sessionSummaryFromJsonl(opts: SessionSummaryFromJsonlOptions): SessionSummary | undefined {
	const header = parseSessionHeaderFromJsonl(opts.content);
	if (!header) return undefined;
	if (opts.cwdFilter && header.cwd !== opts.cwdFilter) return undefined;
	return {
		id: header.id,
		path: opts.fullPath,
		cwd: header.cwd,
		title: header.title,
		createdAt: header.timestamp,
		updatedAt: opts.modifiedAt.toISOString(),
		messageCount: countMessageEntries(opts.content),
	};
}

export function resumeCwdFromState(state: Pick<RpcStateData, "cwd">, fallbackCwd: string): string {
	const cwd = state.cwd?.trim();
	return cwd ? cwd : fallbackCwd;
}

const FILLER_TITLE_TOKENS: Record<string, true> = {
	hi: true,
	hii: true,
	hiii: true,
	hiya: true,
	hey: true,
	heya: true,
	hello: true,
	helo: true,
	hullo: true,
	yo: true,
	sup: true,
	wassup: true,
	whatsup: true,
	howdy: true,
	greetings: true,
	thanks: true,
	thank: true,
	thx: true,
	ty: true,
	please: true,
	pls: true,
	plz: true,
	ok: true,
	okay: true,
	k: true,
	kk: true,
	yep: true,
	yes: true,
	yeah: true,
	yup: true,
	nope: true,
	no: true,
	nah: true,
	sure: true,
	cool: true,
	nice: true,
	great: true,
	lol: true,
	lmao: true,
	haha: true,
	test: true,
	testing: true,
	ping: true,
	pong: true,
	hmm: true,
	hmmm: true,
	um: true,
	uh: true,
};

const TITLE_WORD = /[\p{L}\p{N}]+/gu;

function stripCodeBlocks(message: string): string {
	return message.replace(/```[\s\S]*?```/g, " ");
}


function isLowSignalTitleInput(text: string): boolean {
	const tokens = stripCodeBlocks(text).toLowerCase().match(TITLE_WORD);
	if (!tokens) return true;
	return tokens.every((token) => FILLER_TITLE_TOKENS[token] === true || /^\d+$/.test(token));
}

export function deriveAutoSessionName(text: string): string | undefined {
	const firstLine = text.split(/\r?\n/).find((line) => line.trim().length > 0)?.trim() ?? "";
	if (!firstLine || firstLine.startsWith("/") || isLowSignalTitleInput(firstLine)) return undefined;
	const cleaned = firstLine.replace(/[\x00-\x1F\x7F]/g, "").replace(/\s+/g, " ").trim();
	if (!cleaned) return undefined;
	const codePoints = [...cleaned];
	return codePoints.length > 80 ? `${codePoints.slice(0, 77).join("")}…` : cleaned;
}

async function readSessionCwdFromFile(sessionFile: string | undefined): Promise<string | undefined> {
	if (!sessionFile) return undefined;
	try {
		const file = Bun.file(sessionFile);
		const content = await file.text();
		const stat = await file.stat();
		const summary = sessionSummaryFromJsonl({
			fullPath: sessionFile,
			content,
			modifiedAt: stat ? new Date(stat.mtimeMs) : new Date(),
		});
		return summary?.cwd || undefined;
	} catch {
		return undefined;
	}
}

/**
 * List sessions by scanning ~/.omp/agent/sessions on disk.
 * Understands OMP 16's mutable title slot first line, followed by the session header.
 */
async function listSessionsFromDisk(cwdFilter?: string): Promise<SessionSummary[]> {
	const sessionsRoot = path.join(getAgentDir(), "sessions");
	const summaries: SessionSummary[] = [];

	const glob = new Bun.Glob("*/*.jsonl");
	const files = Array.from(glob.scanSync(sessionsRoot));

	for (const relPath of files) {
		const fullPath = path.join(sessionsRoot, relPath);
		try {
			const file = Bun.file(fullPath);
			const content = await file.text();
			const stat = await file.stat();
			const summary = sessionSummaryFromJsonl({
				fullPath,
				content,
				modifiedAt: stat ? new Date(stat.mtimeMs) : new Date(),
				cwdFilter,
			});
			if (summary) summaries.push(summary);
		} catch {
			continue;
		}
	}

	summaries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
	return summaries;
}

// ─── Session handle ───────────────────────────────────────────────────

interface RpcSessionOpts {
	transport: OmpRpcTransport;
	cwd: string;
	state: RpcStateData;
	messages: AgentMessageJson[];
	ompBin: string;
	onDispose: () => void;
}

class RpcSessionHandle implements SessionHandle {
	readonly sessionId: string;
	readonly cwd: string;
	readonly #transport: OmpRpcTransport;
	readonly #listeners = new Set<EventListener>();
	#messages: AgentMessageJson[];
	#state: RpcStateData;
	readonly #ompBin: string;
	#disposed = false;
	#autoTitleInFlight = false;
	readonly #onDispose: () => void;

	constructor(opts: RpcSessionOpts) {
		this.#transport = opts.transport;
		this.cwd = opts.cwd;
		this.#state = opts.state;
		this.#messages = opts.messages;
		this.#ompBin = opts.ompBin;
		this.sessionId = opts.state.sessionId;
		this.#onDispose = opts.onDispose;

		// Forward all RPC events to session listeners
		opts.transport.onEvent((event) => {
			this.#handleEvent(event);
		});
	}

	get sessionFile(): string | undefined {
		return this.#state.sessionFile;
	}

	#handleEvent(event: RpcEvent): void {
		// Update local state cache from events
		const type = event.type;
		if (type === "turn_start") this.#state.isStreaming = true;
		else if (type === "turn_end" || type === "agent_end") this.#state.isStreaming = false;
		else if (type === "session_info_update" && typeof event.title === "string") {
			this.#state.sessionName = event.title;
			this.#emitSessionUpdated();
		}

		this.#emit(event as unknown as AgentSessionEventJson);

		if (type === "turn_end" || type === "agent_end" || type === "compaction_complete") {
			void this.#refreshStateFromRpc();
		}
	}

	#emit(event: AgentSessionEventJson): void {
		for (const listener of this.#listeners) {
			try {
				listener(event);
			} catch (err) {
				log.warn("session listener threw", err);
			}
		}
	}

	async #refreshStateFromRpc(): Promise<void> {
		try {
			const rawState = await this.#transport.send<unknown>({ type: "get_state" });
			const previous = this.#state;
			const state = extractState(rawState);
			this.#state = state;
			if (
				previous.sessionName !== state.sessionName ||
				previous.thinkingLevel !== state.thinkingLevel ||
				previous.model?.provider !== state.model?.provider ||
				previous.model?.id !== state.model?.id
			) {
				this.#emitSessionUpdated();
			}
			if (state.contextUsage) {
				this.#emit({ type: "context_usage", contextUsage: state.contextUsage } as unknown as AgentSessionEventJson);
			}
		} catch (err) {
			log.warn("get_state refresh failed", err);
		}
	}

	async #refreshMessagesFromRpc(): Promise<void> {
		try {
			const rawMessages = await this.#transport.send<RpcMessagesData>({ type: "get_messages" });
			this.#messages = rawMessages.messages ?? [];
		} catch (err) {
			log.warn("get_messages refresh failed", err);
		}
	}

	#emitSessionUpdated(): void {
		this.#emit({ type: "session_updated", snapshot: this.snapshot() } as unknown as AgentSessionEventJson);
	}

	#ensureAutoSessionName(text: string): void {
		if (this.#state.sessionName || this.#autoTitleInFlight) return;
		const name = deriveAutoSessionName(text);
		if (!name) return;
		this.#autoTitleInFlight = true;
		// Fire-and-forget: never blocks or breaks the prompt turn.
		void this.setName(name)
			.catch((err) => {
				log.warn("auto session name write failed", err);
			})
			.finally(() => {
				this.#autoTitleInFlight = false;
			});
	}

	subscribe(listener: EventListener): () => void {
		this.#listeners.add(listener);
		return () => {
			this.#listeners.delete(listener);
		};
	}

	snapshot(): SessionSnapshot {
		return {
			sessionId: this.#state.sessionId,
			sessionFile: this.#state.sessionFile,
			sessionName: this.#state.sessionName,
			cwd: this.cwd,
			model: this.#state.model,
			thinkingLevel: this.#state.thinkingLevel,
			isStreaming: this.#state.isStreaming,
			messages: this.#messages,
			todoPhases: this.#state.todoPhases as Array<Record<string, unknown>>,
			contextUsage: this.#state.contextUsage,
		};
	}

	async prompt(
		text: string,
		opts?: { streamingBehavior?: "steer" | "followUp"; images?: ImageAttachment[] },
	): Promise<void> {
		const command: RpcCommandBody = opts?.streamingBehavior
			? { type: "prompt", message: text, streamingBehavior: opts.streamingBehavior }
			: { type: "prompt", message: text };
		await this.#transport.send(command);
		this.#ensureAutoSessionName(text);
	}

	isStreamingNow(): boolean {
		return this.#state.isStreaming;
	}

	queuedMessageCount(): number {
		return this.#state.queuedMessageCount;
	}

	clearQueue(): { steering: number; followUp: number } {
		// RPC doesn't expose granular queue clear; abort achieves a full reset
		return { steering: 0, followUp: 0 };
	}

	getQueueSnapshot(): QueuedPromptWire[] {
		return [];
	}

	async cancelQueuedById(_id: string): Promise<boolean> {
		return false;
	}

	async editQueuedById(
		_id: string,
		_text: string,
		_images?: ImageAttachment[],
	): Promise<boolean> {
		return false;
	}

	async abort(): Promise<void> {
		await this.#transport.send({ type: "abort" });
	}

	async setName(name: string): Promise<void> {
		await this.#transport.send({ type: "set_session_name", name });
		this.#state.sessionName = name;
		this.#emitSessionUpdated();
	}

	async compact(focus?: string): Promise<void> {
		await this.#transport.send({ type: "compact", customInstructions: focus });
	}

	async setModel(ref: ModelRef): Promise<void> {
		await this.#transport.send({ type: "set_model", provider: ref.provider, modelId: ref.id });
		if (this.#state.model) {
			this.#state.model = { provider: ref.provider, id: ref.id };
		} else {
			this.#state.model = { provider: ref.provider, id: ref.id };
		}
	}

	async dispatchSlashCommand(_text: string): Promise<SlashDispatchResult> {
		return { kind: "fallthrough" };
	}

	async dispatchDeckSlashCommand(text: string): Promise<SlashDispatchResult> {
		if (!text.startsWith("/")) return { kind: "fallthrough" };
		let result: DeckSlashResult | "fallthrough";
		try {
			const { executeDeckSlashCommand } = await import("../deck-slash-commands.ts");
			result = await executeDeckSlashCommand(text, {
				cwd: this.cwd,
				getStatusText: async () => {
					await this.#refreshStateFromRpc();
					await this.#refreshMessagesFromRpc();
					return await buildLiveSessionStatusText({ snapshot: this.snapshot(), ompBin: this.#ompBin });
				},
			});
		} catch (err) {
			const message = `Slash command error: ${String((err as Error).message ?? err)}`;
			log.warn(`deck slash dispatch threw for ${text.slice(0, 40)}: ${String(err)}`);
			this.#emitSyntheticSlashRoundTrip(text, message);
			return { kind: "consumed", output: message };
		}
		if (result === "fallthrough") return { kind: "fallthrough" };
		this.#emitSyntheticSlashRoundTrip(text, result.output || "Done.");
		return { kind: "consumed", output: result.output || "Done." };
	}

	#emitSyntheticSlashRoundTrip(userText: string, assistantText: string | undefined): void {
		const now = Date.now();
		this.#emit({
			type: "message_start",
			message: { role: "user", content: userText, timestamp: now, synthetic: true },
		} as unknown as AgentSessionEventJson);
		if (!assistantText) return;
		this.#emit({
			type: "message_start",
			message: {
				role: "assistant",
				content: [{ type: "text", text: assistantText }],
				timestamp: now,
				synthetic: true,
			},
		} as unknown as AgentSessionEventJson);
	}

	getContextUsage(): ContextUsage | undefined {
		return this.#state.contextUsage;
	}

	async dispose(): Promise<void> {
		if (this.#disposed) return;
		this.#disposed = true;
		this.#listeners.clear();
		this.#transport.kill();
		this.#onDispose();
	}

	async setPlanMode(_enabled: boolean): Promise<void> {
		throw new Error("RPC backend: plan mode not yet implemented");
	}

	getPlanModeContext(): PlanModeContextWire | undefined {
		return undefined;
	}

	getPendingPlanApproval(): PendingPlanApprovalWire | undefined {
		return undefined;
	}

	async respondToPlanApproval(
		_proposalId: string,
		_response: PlanApprovalResponse,
	): Promise<"settled" | "unknown"> {
		return "unknown";
	}
}

// ─── Bridge ───────────────────────────────────────────────────────────

interface RpcAgentBridgeOpts {
	ompBin: string;
	cwd: string;
	idleTimeoutMs?: number;
	autoStartCommand?: string | null;
}

interface ActiveSession {
	handle: RpcSessionHandle;
	subscribers: Set<string>;
	lastActivityAt: number;
	turnInFlight: boolean;
}

export class RpcAgentBridge implements AgentBridge {
	readonly #ompBin: string;
	readonly #cwd: string;
	readonly #sessions = new Map<string, ActiveSession>();
	readonly #sharedTransport: OmpRpcTransport;
	#disposed = false;

	constructor(opts: RpcAgentBridgeOpts) {
		this.#ompBin = opts.ompBin;
		this.#cwd = opts.cwd;
		this.#sharedTransport = new OmpRpcTransport({
			bin: opts.ompBin,
			cwd: opts.cwd,
		});
	}

	private async ensureSharedTransport(): Promise<OmpRpcTransport> {
		if (!this.#sharedTransport.isReady) {
			await this.#sharedTransport.start();
		}
		return this.#sharedTransport;
	}

	async listModels(opts: { sessionId?: string } = {}): Promise<ModelInfo[]> {
		const transport = await this.ensureSharedTransport();
		const data = await transport.send<RpcModelsData>({ type: "get_available_models" });
		const current = opts.sessionId
			? this.#sessions.get(opts.sessionId)?.handle.snapshot().model
			: undefined;
		return data.models.map((m) => rpcModelToInfo(m, current));
	}

	async createSession(opts: CreateSessionOpts): Promise<SessionHandle> {
		const extraArgs: string[] = [];
		if (opts.model) {
			extraArgs.push("--model", `${opts.model.provider}/${opts.model.id}`);
		}

		const transport = new OmpRpcTransport({
			bin: this.#ompBin,
			cwd: opts.cwd,
			extraArgs,
		});
		await transport.start();
		await enableSubagentProgress(transport);

		const rawState = await transport.send<unknown>({ type: "get_state" });
		const state = extractState(rawState);

		let messages: AgentMessageJson[] = [];
		try {
			const rawMessages = await transport.send<RpcMessagesData>({ type: "get_messages" });
			messages = rawMessages.messages ?? [];
		} catch (err) {
			log.warn("get_messages failed on new session", err);
		}

		const handle = new RpcSessionHandle({
			transport,
			cwd: opts.cwd,
			state,
			messages,
			ompBin: this.#ompBin,
			onDispose: () => {
				this.#sessions.delete(state.sessionId);
			},
		});

		this.#sessions.set(state.sessionId, {
			handle,
			subscribers: new Set(),
			lastActivityAt: Date.now(),
			turnInFlight: false,
		});

		log.info(`created RPC session ${state.sessionId} cwd=${opts.cwd}`);
		return handle;
	}

	async resumeSession(opts: ResumeSessionOpts): Promise<SessionHandle> {
		const transport = new OmpRpcTransport({
			bin: this.#ompBin,
			cwd: this.#cwd,
			extraArgs: ["--resume", opts.sessionPath],
		});
		await transport.start();
		await enableSubagentProgress(transport);

		const rawState = await transport.send<unknown>({ type: "get_state" });
		const state = extractState(rawState);

		let messages: AgentMessageJson[] = [];
		try {
			const rawMessages = await transport.send<RpcMessagesData>({ type: "get_messages" });
			messages = rawMessages.messages ?? [];
		} catch (err) {
			log.warn("get_messages failed on resume", err);
		}
		const fileCwd = await readSessionCwdFromFile(state.sessionFile ?? opts.sessionPath);
		const resumedCwd = resumeCwdFromState({ cwd: state.cwd ?? fileCwd }, this.#cwd);

		const handle = new RpcSessionHandle({
			transport,
			cwd: resumedCwd,
			state,
			messages,
			ompBin: this.#ompBin,
			onDispose: () => {
				this.#sessions.delete(state.sessionId);
			},
		});

		this.#sessions.set(state.sessionId, {
			handle,
			subscribers: new Set(),
			lastActivityAt: Date.now(),
			turnInFlight: false,
		});

		log.info(`resumed RPC session ${state.sessionId} from ${opts.sessionPath}`);
		return handle;
	}

	getSession(sessionId: string): SessionHandle | undefined {
		return this.#sessions.get(sessionId)?.handle;
	}

	async listSessions(opts: { cwd?: string }): Promise<SessionSummary[]> {
		return await listSessionsFromDisk(opts.cwd);
	}

	trackSubscriberAdded(sessionId: string, connectionId: string): void {
		const entry = this.#sessions.get(sessionId);
		if (!entry) return;
		entry.subscribers.add(connectionId);
		entry.lastActivityAt = Date.now();
	}

	trackSubscriberRemoved(sessionId: string, connectionId: string): void {
		const entry = this.#sessions.get(sessionId);
		if (!entry) return;
		entry.subscribers.delete(connectionId);
		entry.lastActivityAt = Date.now();
	}

	bumpActivity(sessionId: string): void {
		const entry = this.#sessions.get(sessionId);
		if (!entry) return;
		entry.lastActivityAt = Date.now();
	}

	applyEnvUpdate?(_update: RuntimeEnvUpdate): void {
		// No hot-applied env changes in RPC mode yet
	}

	subscribeUiFrames(
		_sessionId: string,
		_listener: (frame: Extract<ServerFrame, { type: "ext_ui_dialog_open" | "ext_ui_dialog_cancel" }>) => void,
	): () => void {
		return () => {};
	}

	respondToUiDialog(_sessionId: string, _dialogId: string, _response: ExtUiDialogResponse): void {
		// Extension UI dialog forwarding not yet wired
	}

	subscribePlanModeFrames(
		_sessionId: string,
		_listener: (
			frame: Extract<ServerFrame, { type: "plan_mode_changed" | "plan_proposed" | "plan_proposal_resolved" }>,
		) => void,
	): () => void {
		return () => {};
	}

	async respondToPlanApproval(
		_sessionId: string,
		_proposalId: string,
		_response: PlanApprovalResponse,
	): Promise<"settled" | "unknown"> {
		return "unknown";
	}

	async dispose(): Promise<void> {
		if (this.#disposed) return;
		this.#disposed = true;
		this.#sharedTransport.kill();
		const disposals = Array.from(this.#sessions.values()).map((s) =>
			s.handle.dispose().catch((err) => log.warn("dispose failed", err)),
		);
		await Promise.all(disposals);
		this.#sessions.clear();
	}
}
