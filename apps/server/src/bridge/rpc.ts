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
 *   - slash-command dispatch (falls through to prompt)
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

import { OmpRpcTransport, type RpcEvent } from "./rpc-transport.ts";
import * as path from "node:path";
import { getAgentDir } from "@oh-my-pi/pi-coding-agent";
import { logger } from "../log.ts";

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

function parseSessionHeader(firstLine: string): SessionHeader | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(firstLine);
	} catch {
		return null;
	}
	if (!isRecord(parsed) || parsed.type !== "session") return null;
	const id = typeof parsed.id === "string" ? parsed.id : "";
	const cwd = typeof parsed.cwd === "string" ? parsed.cwd : "";
	const timestamp = typeof parsed.timestamp === "string" ? parsed.timestamp : "";
	if (!id || !timestamp) return null;
	const title = typeof parsed.title === "string" ? parsed.title : undefined;
	return { id, cwd, title, timestamp };
}

/**
 * List sessions by scanning ~/.omp/agent/sessions on disk.
 * Reads only the first line (session header) of each JSONL file,
 * so it's fast and version-agnostic — no embedded SDK needed.
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
			const text = await file.text();
			const nlIdx = text.indexOf("\n");
			const firstLine = nlIdx === -1 ? text : text.slice(0, nlIdx);
			const header = parseSessionHeader(firstLine);
			if (!header) continue;

			if (cwdFilter && header.cwd !== cwdFilter) continue;

			const stat = await file.stat();
			const createdAt = header.timestamp;
			const updatedAt = stat
				? new Date(stat.mtimeMs).toISOString()
				: createdAt;

			// Approximate message count: total non-empty lines minus header line
			const messageCount = Math.max(0, text.split("\n").filter(Boolean).length - 1);

			summaries.push({
				id: header.id,
				path: fullPath,
				cwd: header.cwd,
				title: header.title,
				createdAt,
				updatedAt,
				messageCount,
			});
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
	onDispose: () => void;
}

class RpcSessionHandle implements SessionHandle {
	readonly sessionId: string;
	readonly cwd: string;
	readonly #transport: OmpRpcTransport;
	readonly #listeners = new Set<EventListener>();
	readonly #messages: AgentMessageJson[];
	#state: RpcStateData;
	#disposed = false;
	readonly #onDispose: () => void;

	constructor(opts: RpcSessionOpts) {
		this.#transport = opts.transport;
		this.cwd = opts.cwd;
		this.#state = opts.state;
		this.#messages = opts.messages;
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

		// Forward to WS layer
		const json = event as unknown as AgentSessionEventJson;
		for (const listener of this.#listeners) {
			try {
				listener(json);
			} catch (err) {
				log.warn("session listener threw", err);
			}
		}
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
		const command: Record<string, unknown> = { type: "prompt", message: text };
		if (opts?.streamingBehavior) {
			command.streamingBehavior = opts.streamingBehavior;
		}
		await this.#transport.send(command);
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

	async dispatchDeckSlashCommand(_text: string): Promise<SlashDispatchResult> {
		return { kind: "fallthrough" };
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

		const rawState = await transport.send<unknown>({ type: "get_state" });
		const state = extractState(rawState);

		let messages: AgentMessageJson[] = [];
		try {
			const rawMessages = await transport.send<RpcMessagesData>({ type: "get_messages" });
			messages = rawMessages.messages ?? [];
		} catch (err) {
			log.warn("get_messages failed on resume", err);
		}

		const handle = new RpcSessionHandle({
			transport,
			cwd: state.sessionFile ? opts.sessionPath : this.#cwd,
			state,
			messages,
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
