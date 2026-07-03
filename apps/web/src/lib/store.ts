import { create } from "zustand";
import { subscribeWithSelector } from "zustand/middleware";

import type {
	AgentSessionEventJson,
	CreateWorkspaceRequest,
	CreateWorkspaceResponse,
	ExtUiDialogResponse,
	ListSessionsResponse,
	ListWorkspacesResponse,
	NotificationLevel,
	PendingPlanApprovalWire,
	PlanModeContextWire,
	SessionSummary,
	ServerFrame,
	WorkspaceEntry,
} from "@omp-deck/protocol";

/**
 * In-app notification record. Mirrors the wire frame plus client-side
 * metadata: `receivedAtMs` for ordering, `deliveredOs` so the OS-level
 * Notification renderer only fires once per item.
 */
export interface NotificationItem {
	id: string;
	level: NotificationLevel;
	title: string;
	body?: string;
	sound?: boolean;
	source?: string;
	actionUrl?: string;
	timestamp: string;
	receivedAtMs: number;
	deliveredOs: boolean;
	dismissed: boolean;
}

/** Max notifications retained in the in-app queue. Older items fall off. */
const MAX_NOTIFICATIONS = 50;

import { api } from "./api";
import { applyEvent, initSession } from "./reducer";
import type { SessionUi } from "./types";
import { WsClient, type WsStatus } from "./ws";

export const STATUS_PANEL_STORAGE_KEY = "omp-deck:status-panel-open";

interface BoolStorage {
	getItem(key: string): string | null;
}

interface SessionTitleSnapshot {
	sessionId: string;
	sessionName?: string;
}


function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sessionUpdatedSnapshot(event: AgentSessionEventJson): SessionTitleSnapshot | undefined {
	if (event.type !== "session_updated" || !isRecord(event.snapshot)) return undefined;
	const sessionId = event.snapshot.sessionId;
	const sessionName = event.snapshot.sessionName;
	if (typeof sessionId !== "string" || typeof sessionName !== "string") return undefined;
	return { sessionId, sessionName };
}

export function applySessionSummarySnapshot(
	sessions: SessionSummary[],
	snapshot: SessionTitleSnapshot,
): SessionSummary[] {
	const title = snapshot.sessionName?.trim();
	if (!title) return sessions;
	let changed = false;
	const next = sessions.map((session) => {
		if (session.id !== snapshot.sessionId || session.title === title) return session;
		changed = true;
		return { ...session, title };
	});
	return changed ? next : sessions;
}

export function workspaceStateFromResponse(resp: ListWorkspacesResponse): { workspaces: WorkspaceEntry[]; defaultCwd: string } {
	return { workspaces: resp.workspaces, defaultCwd: resp.defaultCwd };
}

export function selectedWorkspaceAfterDelete(selectedCwd: string, remaining: WorkspaceEntry[]): string {
	return selectedCwd && !remaining.some((workspace) => workspace.cwd === selectedCwd) ? "" : selectedCwd;
}

export function getInitialStatusPanelOpen(storage: BoolStorage | undefined, desktop: boolean): boolean {
	if (!desktop) return false;
	const raw = storage?.getItem(STATUS_PANEL_STORAGE_KEY) ?? null;
	if (raw === null) return true;
	return raw === "1";
}

function readBool(key: string, fallback: boolean): boolean {
	if (typeof localStorage === "undefined") return fallback;
	const raw = localStorage.getItem(key);
	if (raw === null) return fallback;
	return raw === "1";
}

/** Matches the Tailwind `lg` breakpoint (1024px) used by `Layout`. Below this
 * width the sidebar and inspector behave as overlay drawers, so persisting
 * "open" state would auto-open them on every mobile load and bury the main
 * content under a backdrop.  */
function isDesktopViewport(): boolean {
	return typeof window !== "undefined" && window.matchMedia("(min-width: 1024px)").matches;
}

/** Chrome panel state is only persisted on desktop. On mobile we always start
 * with the panel closed and never write back, so toggling on a phone does not
 * pollute the desktop preference. */
function readChromeOpen(key: string, desktopFallback: boolean): boolean {
	if (!isDesktopViewport()) return false;
	return readBool(key, desktopFallback);
}

interface StoreState {
	ws: WsClient | null;
	wsStatus: WsStatus;
	connectionId?: string;

	workspaces: WorkspaceEntry[];
	defaultCwd: string;
	sessions: SessionSummary[];

	activeId?: string;
	sessionsById: Record<string, SessionUi>;

	// Track subscriptions to avoid duplicate subscribe messages.
	subscribed: Set<string>;

	/**
	 * Tool-card view state. `allCollapsed` is the bulk default; `perCard` holds
	 * user overrides (key = toolCallId, value = isOpen). On bulk toggle we clear
	 * `perCard` so the new default applies to every card uniformly.
	 */
	toolView: {
		allCollapsed: boolean;
		perCard: Record<string, boolean>;
	};

	/** Composer pre-fill used by `Open in chat` from the Tasks view. */
	pendingDraft?: { text: string };

	/** Shared chrome state — each view can open/close the inspector and sidebar. */
	sidebarOpen: boolean;
	inspectorOpen: boolean;

	/**
	 * Monotonic counter bumped every time the server broadcasts a `tasks_changed`
	 * frame (any kanban mutation, whether triggered by the deck UI, a deck slash
	 * command, or an agent calling the REST API). Views that own a local tasks
	 * cache (e.g. TasksView) subscribe to this counter and refetch when it
	 * changes — keeps the kanban view live without polling.
	 */
	tasksChangeCounter: number;

	/**
	 * Mirror of {@link tasksChangeCounter} for the skill catalog. Bumped on every
	 * `skills_changed` frame (plugin install / uninstall / enable / disable, or
	 * a SKILL.md mutation under the plugins cache dir). Drives live refetch in
	 * `SkillsView` without polling.
	 */
	skillsChangeCounter: number;

	/**
	 * Counter for `kb_changed` broadcasts. Bumped on any mutation under the
	 * watched kb root; `KbView` watches it and refetches the current file +
	 * tree. Same pattern as `tasksChangeCounter` / `skillsChangeCounter`.
	 */
	kbChangeCounter: number;

	/**
	 * Per-session open extension-UI dialog (currently used by the SDK `ask`
	 * tool, but the channel is shape-typed to cover any extension dialog).
	 * At most one dialog per session is open at a time because the SDK awaits
	 * each `ctx.ui.*` call serially; if a second open arrives it replaces the
	 * first (the server-side bridge already cancelled the predecessor before
	 * sending the new one). Cleared on `ext_ui_dialog_cancel` and on local
	 * response submission.
	 */
	pendingDialogs: Record<string, Extract<ServerFrame, { type: "ext_ui_dialog_open" }>>;

	/**
	 * Latest heartbeat the server has broadcast. `lastHeartbeatAt` is the
	 * client's local Date.now() at the moment we received the frame, NOT the
	 * server's `timestamp` — the gap drives the connection indicator and must
	 * be measured in the client's clock.
	 */
	heartbeat: {
		lastReceivedAtMs: number;
		serverStartedAt: string;
		pid: number;
		uptimeSecs: number;
		buildSha: string | null;
		version: string;
	} | null;

	/**
	 * In-app notification queue. Each `notification` frame is appended; the
	 * notification renderer pops from here when delivering an OS notification
	 * + audio cue, and a small toast surface reads from here too. Capped at
	 * MAX_NOTIFICATIONS via prune; oldest fall off.
	 */
	notifications: NotificationItem[];

	// ─── Actions ─────────────────────────────────────────────────────────
	bootstrap(): Promise<void>;
	connect(): void;
	disconnect(): void;
	refreshWorkspaces(): Promise<void>;
	createWorkspace(opts: CreateWorkspaceRequest): Promise<WorkspaceEntry>;
	deleteWorkspace(id: string): Promise<void>;
	refreshSessions(cwd?: string): Promise<void>;
	createSession(opts: { cwd: string; resumeFromPath?: string }): Promise<string>;
	selectSession(id: string): void;
	sendPrompt(text: string, images?: import("@omp-deck/protocol").ImageAttachment[]): void;
	abort(): void;
	/** Drop every queued (followUp / steering) prompt for the active session.
	 *  Server echoes a `queue_cleared` session event that reconciles
	 *  `queuedPrompts` in the reducer. */
	clearQueue(): void;
	/** Cancel a single queued prompt by its server-assigned id. Server echoes
	 *  a `queue_state` session event with the new ordered queue. */
	cancelQueued(queuedId: string): void;
	/** Edit a queued prompt's text (and optionally images) in place. */
	editQueued(queuedId: string, text: string, images?: import("@omp-deck/protocol").ImageAttachment[]): void;
	disposeSession(id: string): Promise<void>;
	renameSession(id: string, name: string): Promise<void>;
	toggleAllToolCards(): void;
	setToolCardOpen(id: string, open: boolean): void;
	setPendingDraft(draft: { text: string } | undefined): void;
	setSidebarOpen(open: boolean): void;
	setInspectorOpen(open: boolean): void;
	/** Send a dialog response over the WS and clear it locally. */
	respondToExtUiDialog(sessionId: string, dialogId: string, response: ExtUiDialogResponse): void;
	/**
	 * Toggle plan mode on the active session (T-105). Idempotent on the wire;
	 * server emits `plan_mode_changed` which the reducer mirrors back.
	 */
	setPlanMode(enabled: boolean): void;
	/**
	 * Reply to a `plan_proposed` card. Optimistically clears
	 * `pendingPlanApproval` so the UI hides immediately; the server emits
	 * `plan_proposal_resolved`, and on `error` (stale proposalId) the next
	 * `plan_proposed` replay on subscribe will restore it.
	 */
	respondToPlanApproval(args: {
		sessionId: string;
		proposalId: string;
		approved: boolean;
		finalPath?: string;
		editedContent?: string;
	}): void;
	/** Mark a notification as delivered to the OS so the renderer only fires once. */
	markNotificationDelivered(id: string): void;
	/** Hide an in-app toast for a notification (does not affect an already-delivered OS notif). */
	dismissNotification(id: string): void;
}

export const useStore = create<StoreState>()(
	subscribeWithSelector((set, get) => ({
		ws: null,
		wsStatus: "closed",
		workspaces: [],
		defaultCwd: "",
		sessions: [],
		sessionsById: {},
		subscribed: new Set<string>(),
		toolView: { allCollapsed: false, perCard: {} },
		tasksChangeCounter: 0,
		skillsChangeCounter: 0,
		kbChangeCounter: 0,
		pendingDialogs: {},
		heartbeat: null,
		notifications: [],
		// Hydrate chrome state from localStorage at module init so first render
		// matches the user's last preference — but only on desktop. On mobile the
		// panels are overlay drawers and always start closed.
		sidebarOpen: readChromeOpen("omp-deck:sidebar-open", true),
		inspectorOpen: getInitialStatusPanelOpen(typeof localStorage === "undefined" ? undefined : localStorage, isDesktopViewport()),

		async bootstrap() {
			get().connect();
			await Promise.all([get().refreshWorkspaces(), get().refreshSessions()]);
		},

		connect() {
			if (get().ws) return;
			const ws = new WsClient();
			ws.onStatus((status) => set({ wsStatus: status }));
			ws.subscribe((frame) => handleFrame(frame, set, get));
			ws.connect();
			set({ ws });
		},

		disconnect() {
			get().ws?.dispose();
			set({ ws: null, wsStatus: "closed" });
		},

		async refreshWorkspaces() {
			try {
				const resp: ListWorkspacesResponse = await api.listWorkspaces();
				set(workspaceStateFromResponse(resp));
			} catch (err) {
				console.warn("listWorkspaces failed", err);
			}
		},

		async createWorkspace(opts) {
			const resp: CreateWorkspaceResponse = await api.createWorkspace(opts);
			set(workspaceStateFromResponse(resp));
			return resp.workspace;
		},

		async deleteWorkspace(id) {
			const resp = await api.deleteWorkspace(id);
			set(workspaceStateFromResponse(resp));
		},

		async refreshSessions(cwd?: string) {
			try {
				const resp: ListSessionsResponse = await api.listSessions(cwd);
				set({ sessions: resp.sessions });
			} catch (err) {
				console.warn("listSessions failed", err);
			}
		},

		async createSession(opts) {
			const created = await api.createSession({
				cwd: opts.cwd,
				...(opts.resumeFromPath ? { resumeFromPath: opts.resumeFromPath } : {}),
			});
			// Subscribe immediately; reducer will hydrate from the `subscribed` snapshot.
			get().ws?.send({ type: "subscribe", sessionId: created.sessionId });
			get().subscribed.add(created.sessionId);
			set({ activeId: created.sessionId });
			// Background-refresh sidebar to reflect the new entry.
			void get().refreshSessions();
			void get().refreshWorkspaces();
			return created.sessionId;
		},

		selectSession(id: string) {
			set({ activeId: id });
			if (!get().subscribed.has(id)) {
				get().ws?.send({ type: "subscribe", sessionId: id });
				get().subscribed.add(id);
			}
		},

		sendPrompt(text, images) {
			const id = get().activeId;
			if (!id) return;
			const frame: Parameters<NonNullable<StoreState["ws"]>["send"]>[0] = images && images.length > 0
				? { type: "prompt", sessionId: id, text, images }
				: { type: "prompt", sessionId: id, text };
			get().ws?.send(frame);
		},

		abort() {
			const id = get().activeId;
			if (!id) return;
			get().ws?.send({ type: "abort", sessionId: id });
		},

		clearQueue() {
			const id = get().activeId;
			if (!id) return;
			get().ws?.send({ type: "clear_queue", sessionId: id });
		},

		cancelQueued(queuedId: string) {
			const id = get().activeId;
			if (!id) return;
			get().ws?.send({ type: "cancel_queued", sessionId: id, queuedId });
		},

		editQueued(queuedId, text, images) {
			const id = get().activeId;
			if (!id) return;
			const frame: Parameters<NonNullable<StoreState["ws"]>["send"]>[0] = images && images.length > 0
				? { type: "edit_queued", sessionId: id, queuedId, text, images }
				: { type: "edit_queued", sessionId: id, queuedId, text };
			get().ws?.send(frame);
		},

		async disposeSession(id: string) {
			await api.disposeSession(id);
			set((s) => {
				const next = { ...s.sessionsById };
				delete next[id];
				return {
					sessionsById: next,
					sessions: s.sessions.filter((session) => session.id !== id),
					activeId: s.activeId === id ? undefined : s.activeId,
				};
			});
			void get().refreshWorkspaces();
		},

		async renameSession(id, name) {
			// Re-throw on failure so the caller (ChatHeader) can keep the input
			// open + surface the error. Silently swallowing makes Windows-EPERM
			// failures from the SDK's atomic-rename journal save look like the
			// UI is broken when it's actually the FS rejecting the rename
			// because the journal file is held open by the live session.
			await api.renameSession(id, name);
			set((s) => {
				const existing = s.sessionsById[id];
				const next = existing
					? { ...s.sessionsById, [id]: { ...existing, sessionName: name } }
					: s.sessionsById;
				const sessions = s.sessions.map((r) => (r.id === id ? { ...r, title: name } : r));
				return { sessionsById: next, sessions };
			});
		},

		toggleAllToolCards() {
			set((s) => ({
				toolView: { allCollapsed: !s.toolView.allCollapsed, perCard: {} },
			}));
		},

		setToolCardOpen(id, open) {
			set((s) => ({
				toolView: {
					allCollapsed: s.toolView.allCollapsed,
					perCard: { ...s.toolView.perCard, [id]: open },
				},
			}));
		},

		setPendingDraft(draft) {
			set({ pendingDraft: draft });
		},

		setSidebarOpen(open) {
			// Only persist on desktop so toggling on mobile (where the panel is an
			// ephemeral overlay) doesn't auto-open it the next time the user lands
			// on the page from a wider screen.
			if (isDesktopViewport()) {
				try {
					localStorage.setItem("omp-deck:sidebar-open", open ? "1" : "0");
				} catch {}
			}
			set({ sidebarOpen: open });
		},

		setInspectorOpen(open) {
			if (isDesktopViewport()) {
				try {
					localStorage.setItem(STATUS_PANEL_STORAGE_KEY, open ? "1" : "0");
				} catch {}
			}
			set({ inspectorOpen: open });
		},

		respondToExtUiDialog(sessionId, dialogId, response) {
			// Clear local state first — the dialog modal closes immediately —
			// then send the response over the WS so the SDK call settles.
			set((s) => {
				const current = s.pendingDialogs[sessionId];
				if (!current || current.dialogId !== dialogId) return {};
				const next = { ...s.pendingDialogs };
				delete next[sessionId];
				return { pendingDialogs: next };
			});
			get().ws?.send({
				type: "ext_ui_dialog_response",
				sessionId,
				dialogId,
				...response,
			});
		},

		setPlanMode(enabled) {
			const id = get().activeId;
			if (!id) return;
			get().ws?.send({ type: "set_plan_mode", sessionId: id, enabled });
		},

		respondToPlanApproval({ sessionId, proposalId, approved, finalPath, editedContent }) {
			// Optimistically clear the local approval card so the UI hides
			// immediately. Server emits `plan_proposal_resolved`; if the
			// proposalId is stale (sibling tab won the race), the bridge's
			// own replay-on-subscribe will restore the next pending proposal
			// (if any) without us having to roll back here.
			set((s) => {
				const prev = s.sessionsById[sessionId];
				if (!prev || !prev.pendingPlanApproval) return {};
				if (prev.pendingPlanApproval.proposalId !== proposalId) return {};
				return {
					sessionsById: {
						...s.sessionsById,
						[sessionId]: { ...prev, pendingPlanApproval: undefined },
					},
				};
			});
			get().ws?.send({
				type: "plan_response",
				sessionId,
				proposalId,
				approved,
				...(finalPath !== undefined ? { finalPath } : {}),
				...(editedContent !== undefined ? { editedContent } : {}),
			});
		},

		markNotificationDelivered(id) {
			set((s) => {
				const i = s.notifications.findIndex((n) => n.id === id);
				if (i < 0 || s.notifications[i]?.deliveredOs) return {};
				const next = s.notifications.slice();
				const target = next[i];
				if (!target) return {};
				next[i] = { ...target, deliveredOs: true };
				return { notifications: next };
			});
		},

		dismissNotification(id) {
			set((s) => {
				const i = s.notifications.findIndex((n) => n.id === id);
				if (i < 0 || s.notifications[i]?.dismissed) return {};
				const next = s.notifications.slice();
				const target = next[i];
				if (!target) return {};
				next[i] = { ...target, dismissed: true };
				return { notifications: next };
			});
		},
	})),
);

function handleFrame(
	frame: ServerFrame,
	set: (partial: Partial<StoreState> | ((s: StoreState) => Partial<StoreState>)) => void,
	get: () => StoreState,
): void {
	switch (frame.type) {
		case "hello":
			set({ connectionId: frame.connectionId });
			// Re-subscribe to any previously-active sessions.
			for (const id of get().subscribed) {
				get().ws?.send({ type: "subscribe", sessionId: id });
			}
			return;

		case "subscribed":
			set((s) => ({
				sessionsById: {
					...s.sessionsById,
					[frame.sessionId]: initSession(frame.snapshot),
				},
			}));
			return;

		case "unsubscribed":
			get().subscribed.delete(frame.sessionId);
			return;

		case "session_event": {
			set((s) => {
				const prev = s.sessionsById[frame.sessionId];
				if (!prev) return {};
				const next = applyEvent(prev, frame.event);
				const snapshot = sessionUpdatedSnapshot(frame.event);
				return {
					sessionsById: { ...s.sessionsById, [frame.sessionId]: next },
					...(snapshot ? { sessions: applySessionSummarySnapshot(s.sessions, snapshot) } : {}),
				};
			});
			return;
		}

		case "tasks_changed":
			set((s) => ({ tasksChangeCounter: s.tasksChangeCounter + 1 }));
			return;

		case "skills_changed":
			set((s) => ({ skillsChangeCounter: s.skillsChangeCounter + 1 }));
			return;

		case "kb_changed":
			set((s) => ({ kbChangeCounter: s.kbChangeCounter + 1 }));
			return;

		case "ext_ui_dialog_open":
			set((s) => ({
				pendingDialogs: { ...s.pendingDialogs, [frame.sessionId]: frame },
			}));
			return;

		case "ext_ui_dialog_cancel":
			set((s) => {
				const current = s.pendingDialogs[frame.sessionId];
				if (!current || current.dialogId !== frame.dialogId) return {};
				const next = { ...s.pendingDialogs };
				delete next[frame.sessionId];
				return { pendingDialogs: next };
			});
			return;

		case "plan_mode_changed":
			set((s) => {
				const prev = s.sessionsById[frame.sessionId];
				if (!prev) return {};
				const planMode: PlanModeContextWire | undefined = frame.enabled
					? { enabled: true, planFilePath: frame.planFilePath ?? "local://PLAN.md" }
					: undefined;
				// On exit, also drop any unresolved approval card — the bridge
				// has already rejected its standing handler, so leaving the
				// card visible would let the user click into a 409.
				const pendingPlanApproval = frame.enabled ? prev.pendingPlanApproval : undefined;
				return {
					sessionsById: {
						...s.sessionsById,
						[frame.sessionId]: { ...prev, planMode, pendingPlanApproval },
					},
				};
			});
			return;

		case "plan_proposed":
			set((s) => {
				const prev = s.sessionsById[frame.sessionId];
				if (!prev) return {};
				const pending: PendingPlanApprovalWire = {
					proposalId: frame.proposalId,
					planFilePath: frame.planFilePath,
					planContent: frame.planContent,
					suggestedTitle: frame.suggestedTitle,
					suggestedFinalPath: frame.suggestedFinalPath,
				};
				return {
					sessionsById: {
						...s.sessionsById,
						[frame.sessionId]: { ...prev, pendingPlanApproval: pending },
					},
				};
			});
			return;

		case "plan_proposal_resolved":
			set((s) => {
				const prev = s.sessionsById[frame.sessionId];
				if (!prev?.pendingPlanApproval) return {};
				if (prev.pendingPlanApproval.proposalId !== frame.proposalId) return {};
				return {
					sessionsById: {
						...s.sessionsById,
						[frame.sessionId]: { ...prev, pendingPlanApproval: undefined },
					},
				};
			});
			return;

		case "session_disposed":
			set((s) => {
				const nextSessions = { ...s.sessionsById };
				delete nextSessions[frame.sessionId];
				const nextDialogs = { ...s.pendingDialogs };
				delete nextDialogs[frame.sessionId];
				return {
					sessionsById: nextSessions,
					pendingDialogs: nextDialogs,
					activeId: s.activeId === frame.sessionId ? undefined : s.activeId,
				};
			});
			return;

		case "error":
			set((s) => {
				const id = frame.sessionId;
				if (!id) return {};
				const prev = s.sessionsById[id];
				if (!prev) return {};
				return {
					sessionsById: {
						...s.sessionsById,
						[id]: { ...prev, lastError: frame.error },
					},
				};
			});
			return;

		case "heartbeat":
			set(() => ({
				heartbeat: {
					lastReceivedAtMs: Date.now(),
					serverStartedAt: frame.serverStartedAt,
					pid: frame.pid,
					uptimeSecs: frame.uptimeSecs,
					buildSha: frame.buildSha,
					version: frame.version,
				},
			}));
			return;

		case "notification":
			set((s) => {
				// Dedupe by id: server may re-send on reconnect.
				if (s.notifications.some((n) => n.id === frame.id)) return {};
				const item: NotificationItem = {
					id: frame.id,
					level: frame.level,
					title: frame.title,
					timestamp: frame.timestamp,
					receivedAtMs: Date.now(),
					deliveredOs: false,
					dismissed: false,
				};
				if (frame.body !== undefined) item.body = frame.body;
				if (frame.sound !== undefined) item.sound = frame.sound;
				if (frame.source !== undefined) item.source = frame.source;
				if (frame.actionUrl !== undefined) item.actionUrl = frame.actionUrl;
				const next = [...s.notifications, item];
				// Cap retention; oldest fall off.
				if (next.length > MAX_NOTIFICATIONS) next.splice(0, next.length - MAX_NOTIFICATIONS);
				return { notifications: next };
			});
			return;

		case "pong":
		default:
			return;
	}
}

// Selectors ────────────────────────────────────────────────────────────────
export const selectActiveSession = (s: StoreState): SessionUi | undefined =>
	s.activeId ? s.sessionsById[s.activeId] : undefined;
