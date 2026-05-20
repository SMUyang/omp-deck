/**
 * Shared transport types between omp-deck server and web.
 *
 * The server embeds @oh-my-pi/pi-coding-agent SDK and re-emits its
 * AgentSessionEvent stream into ServerFrames. To avoid type drift,
 * we keep payloads structurally typed via `unknown`-ish records on the
 * web side and import the real SDK types on the server side.
 *
 * This package is dep-free on purpose — it's the contract.
 */

// ─────────────────────────────────────────────────────────────────────────────
// REST shapes
// ─────────────────────────────────────────────────────────────────────────────

export interface ModelRef {
	provider: string;
	id: string;
}

export interface SessionSummary {
	id: string;
	path: string;
	cwd: string;
	title?: string;
	createdAt: string;
	updatedAt: string;
	messageCount: number;
}

export interface WorkspaceEntry {
	cwd: string;
	label: string;
	sessionCount: number;
}

export interface CreateSessionRequest {
	cwd: string;
	resumeFromPath?: string;
	model?: ModelRef;
	/** Do not fire the configured auto-start prompt when this creates a fresh session. */
	suppressAutoStart?: boolean;
}

export interface CreateSessionResponse {
	sessionId: string;
	sessionFile?: string;
	cwd: string;
}

export interface ListSessionsQuery {
	cwd?: string;
}

export interface ListSessionsResponse {
	sessions: SessionSummary[];
}

export interface ListWorkspacesResponse {
	workspaces: WorkspaceEntry[];
	defaultCwd: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Settings / managed environment
// ─────────────────────────────────────────────────────────────────────────────

export type EnvValueType = "string" | "int" | "path" | "enum" | "boolean";
export type EnvValueSource = "process-env" | "env-file" | "default" | "unset";
export type EnvRestartTarget = "server" | "telegram-bridge";

export interface EnvEntry {
	key: string;
	masked: string;
	isSet: boolean;
	source: EnvValueSource;
	defaultValue?: string;
	valueType: EnvValueType;
	sensitive: boolean;
	restartRequired: boolean;
	hotApply: boolean;
	description: string;
	options?: string[];
	restartTarget?: EnvRestartTarget;
}

export interface ListEnvSettingsResponse {
	entries: EnvEntry[];
	envFilePath: string;
	dataDir: string;
	restartRequired: boolean;
}

export interface PatchEnvSettingsRequest {
	updates: Record<string, string | null>;
}

export interface PatchEnvSettingsResponse extends ListEnvSettingsResponse {
	appliedHot: string[];
}

export interface RevealEnvValueResponse {
	key: string;
	value: string;
	masked: string;
	isSet: boolean;
	source: EnvValueSource;
}

export interface RestartServerResponse {
	ok: boolean;
	pid?: number;
	message: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Bridge supervisor (long-running auxiliary processes the deck owns)
// ─────────────────────────────────────────────────────────────────────────────

export type BridgeName = "telegram";
export type BridgeStatus = "running" | "stopped" | "starting" | "crashed";

export interface BridgeInfo {
	name: BridgeName;
	label: string;
	status: BridgeStatus;
	pid?: number;
	startedAt?: string;
	stoppedAt?: string;
	exitCode?: number;
	exitSignal?: string;
	crashCount: number;
	missingEnv: string[];
	requiredEnv: string[];
	lastError?: string;
}

export interface ListBridgesResponse {
	bridges: BridgeInfo[];
}

export interface BridgeLogLine {
	stream: "stdout" | "stderr";
	text: string;
	timestamp: string;
}

export interface BridgeLogsResponse {
	name: BridgeName;
	lines: BridgeLogLine[];
}

export interface ModelInfo {
	provider: string;
	id: string;
	label: string;
	role?: string;
	contextWindow?: number;
	/** Provider has resolvable auth (api key set, oauth credentials present, or keyless). */
	isAvailable: boolean;
	/** True for the model active in the requesting session. */
	isCurrent?: boolean;
	/** Optional UX hint: input modalities the provider supports for this model. */
	inputModes?: Array<"text" | "image">;
}

export interface ListModelsResponse {
	models: ModelInfo[];
	active?: ModelRef;
}

export interface SetSessionModelRequest {
	model: ModelRef;
}


// ─────────────────────────────────────────────────────────────────────────────
// Marketplace (SDK plugin catalog browsing + install/uninstall)
// ─────────────────────────────────────────────────────────────────────────────

export interface MarketplaceSource {
	name: string;
	sourceType: "github" | "git" | "url" | "local";
	sourceUri: string;
	updatedAt: string;
}

export interface MarketplacePluginCapabilities {
	commands?: boolean;
	agents?: boolean;
	hooks?: boolean;
	mcpServers?: boolean;
	lspServers?: boolean;
}

export interface MarketplaceCatalogEntry {
	id: string; // "name@marketplace"
	name: string;
	marketplace: string;
	description?: string;
	version?: string;
	author?: string;
	homepage?: string;
	keywords?: string[];
	category?: string;
	tags?: string[];
	capabilities: MarketplacePluginCapabilities;
	installed?: {
		scope: "user" | "project";
		version: string;
		installedAt: string;
		enabled?: boolean;
	};
}

export interface InstalledPluginInfo {
	id: string;
	name: string;
	marketplace: string;
	scope: "user" | "project";
	version: string;
	installedAt: string;
	installPath: string;
	enabled?: boolean;
	shadowedBy?: "project";
}

export interface ListMarketplaceResponse {
	sources: MarketplaceSource[];
	catalog: MarketplaceCatalogEntry[];
	installed: InstalledPluginInfo[];
}

export interface InstallPluginRequest {
	name: string;
	marketplace: string;
	scope?: "user" | "project";
	force?: boolean;
}

export interface InstallPluginResponse {
	ok: boolean;
	installed: InstalledPluginInfo;
}

export interface UninstallPluginRequest {
	id: string; // "name@marketplace"
	scope?: "user" | "project";
}

export interface AddMarketplaceRequest {
	source: string; // url, github "owner/repo", git+url, or absolute local path
}

// ─────────────────────────────────────────────────────────────────────────────
// Skills (skill-level enumeration over installed marketplace plugins)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parsed SKILL.md frontmatter. `name` falls back to the directory name when
 * the file omits an explicit `name:` field, matching the omp SDK's loader.
 */
export interface SkillFrontmatter {
	name: string;
	description?: string;
	model?: string;
	triggers?: string[];
	tags?: string[];
}

/**
 * Skill enumerated from `<plugin>/skills/<dirName>/SKILL.md`. Owning plugin
 * scope + enabled state are echoed onto each skill so the UI can render
 * inheritance without a second lookup.
 */
export interface SkillSummary {
	/** Composite ID stable across reads: `<pluginId>/<dirName>`. */
	id: string;
	pluginId: string;
	pluginName: string;
	marketplace: string;
	scope: "user" | "project";
	/** Absolute path to SKILL.md on disk. UI keeps this opaque. */
	skillPath: string;
	/** Directory under `<plugin>/skills/` (URL-safe segment for detail route). */
	dirName: string;
	frontmatter: SkillFrontmatter;
	/** Inherited from the owning plugin; skills toggle with the plugin. */
	enabled: boolean;
}

export interface ListSkillsResponse {
	skills: SkillSummary[];
	/** Echo of installed plugins so the UI can render plugin-level chrome. */
	plugins: InstalledPluginInfo[];
}
// ─────────────────────────────────────────────────────────────────────────────
// WebSocket frames
// ─────────────────────────────────────────────────────────────────────────────

/** Sanitized SDK message — passthrough of @oh-my-pi/pi-coding-agent AgentMessage. */
export type AgentMessageJson = Record<string, unknown> & {
	role: "user" | "assistant" | "tool" | "system" | "custom" | string;
	content: unknown;
};

/** Sanitized SDK event — passthrough of AgentSessionEvent. */
export type AgentSessionEventJson = Record<string, unknown> & {
	type: string;
};

/**
 * Context-window utilization for an in-process agent session. Mirrors the
 * SDK's `ContextUsage` shape but is defined here so the protocol package owns
 * the canonical type the deck UI consumes.
 *
 * `tokens` and `percent` are nullable because the SDK can't reliably report
 * fresh numbers immediately after compaction — the next assistant response
 * is what supplies the post-compaction usage. While in that hole the deck
 * UI should render a "—%" / "calculating" affordance, not a 0%.
 */
export interface ContextUsage {
	tokens: number | null;
	contextWindow: number;
	percent: number | null;
}

/** Snapshot delivered when a client subscribes to an existing session. */
export interface SessionSnapshot {
	sessionId: string;
	sessionFile?: string;
	sessionName?: string;
	cwd: string;
	model?: ModelRef;
	thinkingLevel?: string;
	isStreaming: boolean;
	messages: AgentMessageJson[];
	todoPhases: Array<Record<string, unknown>>;
	/**
	 * Current context-window utilization, mirroring the SDK's
	 * `session.getContextUsage()`. Absent when the model has no declared
	 * context window. `tokens` is `null` immediately after compaction (before
	 * the next assistant response provides fresh usage data); `percent` is
	 * `null` in the same case.
	 */
	contextUsage?: ContextUsage;
}

/**
 * Image attachment for prompt frames — matches the SDK's ImageContent shape.
 * `data` is the raw base64-encoded image payload (no data: URL prefix).
 */
export interface ImageAttachment {
	type: "image";
	data: string;
	mimeType: string;
}

/** Client → Server. */
export type ClientFrame =
	| { type: "ping" }
	| { type: "subscribe"; sessionId: string }
	| { type: "unsubscribe"; sessionId: string }
	| {
			type: "prompt";
			sessionId: string;
			text: string;
			images?: ImageAttachment[];
			streamingBehavior?: "steer" | "followUp";
	  }
	| { type: "abort"; sessionId: string };

/** Server → Client. */
export type ServerFrame =
	| { type: "hello"; connectionId: string }
	| { type: "pong" }
	| { type: "subscribed"; sessionId: string; snapshot: SessionSnapshot }
	| { type: "unsubscribed"; sessionId: string }
	| { type: "session_event"; sessionId: string; event: AgentSessionEventJson }
	| { type: "session_disposed"; sessionId: string }
	/** Broadcast frame: any kanban-task mutation occurred. Clients refetch. */
	| { type: "tasks_changed" }
	/** Broadcast frame: skill catalog or enabled-state changed. Clients refetch. */
	| { type: "skills_changed" }
	/** OAuth: SDK has produced the consent URL; client opens it in a new tab. */
	| {
			type: "oauth_consent";
			flowId: string;
			provider: string;
			url: string;
			instructions?: string;
		}
	/** OAuth: SDK status update (e.g. "Waiting for browser authentication…"). */
	| { type: "oauth_progress"; flowId: string; provider: string; message: string }
	/** OAuth: SDK is asking the user a free-form question (enterprise URL, etc). */
	| {
			type: "oauth_prompt";
			flowId: string;
			provider: string;
			promptId: string;
			message: string;
			placeholder?: string;
		}
	/** OAuth: login resolved successfully; client should refetch providers + models. */
	| { type: "oauth_complete"; flowId: string; provider: string }
	/** OAuth: login rejected (timeout, port collision, state mismatch, user cancel). */
	| { type: "oauth_failed"; flowId: string; provider: string; message: string }
	/** Broadcast: model registry availability changed (post-login / post-revoke). */
	| { type: "models_changed" }
	| { type: "error"; sessionId?: string; error: string };

// ─────────────────────────────────────────────────────────────────────────────
// Tool-call rendering hints (used by the web app to pick a renderer)
// ─────────────────────────────────────────────────────────────────────────────

export const KNOWN_TOOLS = [
	"read",
	"write",
	"edit",
	"bash",
	"search",
	"find",
	"lsp",
	"task",
	"web_search",
	"eval",
	"generate_image",
	"todo_write",
	"browser",
	"ast_edit",
	"ast_grep",
] as const;

export type KnownTool = (typeof KNOWN_TOOLS)[number];

// ─────────────────────────────────────────────────────────────────────────────
// Tasks (kanban)
// ─────────────────────────────────────────────────────────────────────────────

export interface TaskState {
	id: string;
	name: string;
	color: string;
	position: number;
	isDefault: boolean;
}

export interface Task {
	id: string;
	/** Monotonic deck-wide display number. Render as `T-${displayId}`. */
	displayId: number;
	title: string;
	body: string;
	stateId: string;
	orderInState: number;
	cwd?: string;
	createdAt: string;
	updatedAt: string;
	archivedAt?: string;
}

export interface CreateTaskRequest {
	title: string;
	body?: string;
	stateId?: string;
	cwd?: string;
}

export interface UpdateTaskRequest {
	title?: string;
	body?: string;
	stateId?: string;
	orderInState?: number;
	cwd?: string;
	archived?: boolean;
}

export interface ListTasksResponse {
	tasks: Task[];
	states: TaskState[];
}

export interface CreateTaskStateRequest {
	name: string;
	color?: string;
	position?: number;
}

export interface UpdateTaskStateRequest {
	name?: string;
	color?: string;
	position?: number;
}

/** Body for the "move task" convenience endpoint (kanban drop). */
export interface MoveTaskRequest {
	stateId: string;
	/** New 0-based index inside the destination column. */
	index: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Inbox
// ─────────────────────────────────────────────────────────────────────────────

export type InboxKind =
	| "email"
	| "ticket"
	| "idea"
	| "decision"
	| "investigation"
	| "capture";

export interface InboxItem {
	id: string;
	kind: InboxKind;
	title: string;
	body: string;
	source?: string;
	createdAt: string;
	processedAt?: string;
}

export interface CreateInboxItemRequest {
	kind: InboxKind;
	title: string;
	body?: string;
	source?: string;
}

export interface UpdateInboxItemRequest {
	title?: string;
	body?: string;
	kind?: InboxKind;
	source?: string;
	processed?: boolean;
}

export interface ListInboxResponse {
	items: InboxItem[];
}

/**
 * Promote an inbox item into a task.
 *
 * The server copies the item's `title` and `body` onto a new task in the
 * destination state (or the user's default state when omitted) and, unless
 * `markProcessed: false`, marks the source item processed so it stops
 * cluttering the unprocessed list.
 */
export interface PromoteInboxItemRequest {
	stateId?: string;
	markProcessed?: boolean;
}

export interface PromoteInboxItemResponse {
	task: Task;
	inbox: InboxItem;
}

// ─────────────────────────────────────────────────────────────────────────────
// Routines (cron)
// ─────────────────────────────────────────────────────────────────────────────

export type RoutineActionKind = "bash" | "prompt" | "script";

export interface Routine {
	id: string;
	name: string;
	description: string;
	cron: string;
	actionKind: RoutineActionKind;
	actionBody: string;
	actionCwd?: string;
	enabled: boolean;
	createdAt: string;
	updatedAt: string;
	lastRunAt?: string;
	nextRunAt?: string;
}

export interface CreateRoutineRequest {
	name: string;
	description?: string;
	cron: string;
	actionKind: RoutineActionKind;
	actionBody: string;
	actionCwd?: string;
	enabled?: boolean;
}

export interface UpdateRoutineRequest {
	name?: string;
	description?: string;
	cron?: string;
	actionKind?: RoutineActionKind;
	actionBody?: string;
	actionCwd?: string;
	enabled?: boolean;
}

export interface RoutineRun {
	id: string;
	routineId: string;
	startedAt: string;
	endedAt?: string;
	exitCode?: number;
	stdoutExcerpt: string;
	stderrExcerpt: string;
	error?: string;
	trigger: "cron" | "manual";
}

export interface ListRoutinesResponse {
	routines: Routine[];
}

export interface ListRoutineRunsResponse {
	runs: RoutineRun[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Slash commands (discovered from ~/.omp/agent/commands/ + project overrides)
// ─────────────────────────────────────────────────────────────────────────────

export type SlashCommandScope = "user" | "project" | "builtin" | "deck";

export interface SlashSubcommand {
	name: string;
	description: string;
	usage?: string;
}

export interface SlashCommand {
	name: string; // basename without .md, or "<builtin>" / "<builtin> <subcommand>"
	scope: SlashCommandScope;
	description?: string;
	argumentHint?: string;
	/** Builtin parents carry their full subcommand inventory for richer pickers. */
	subcommands?: SlashSubcommand[];
}

export interface ListSlashCommandsResponse {
	commands: SlashCommand[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Filesystem path completion (composer `@filepath` mentions)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Single match entry from the path-completion endpoint. Server returns paths
 * *relative to the queried `cwd`* so the composer can insert them verbatim
 * without re-resolving against the workspace root.
 */
export interface FilePathMatch {
	/** Path relative to the queried cwd, using forward slashes. */
	path: string;
	/** Basename, surfaced for emphasis rendering in the picker. */
	name: string;
	/** True if the entry is a directory — picker can render a trailing slash. */
	isDir: boolean;
}

export interface ListFilePathsResponse {
	matches: FilePathMatch[];
	/** `true` when the underlying file list was served from a cached snapshot. */
	cached: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Auth providers / OAuth login flow (driven from Settings → Providers)
// ─────────────────────────────────────────────────────────────────────────────

export type ProviderAuthState = "oauth" | "api-key" | "unconfigured";

export interface ProviderInfo {
	id: string;
	name: string;
	state: ProviderAuthState;
	/** Number of credentials stored for the provider (1 typical; >1 for round-robin). */
	count: number;
}

export interface ListProvidersResponse {
	providers: ProviderInfo[];
}

/**
 * `POST /api/auth/oauth/:provider/start` response. The deck blocks the
 * response until the SDK fires `onAuth`, so by the time the client sees
 * this it has a real consent URL to open. WS frames keyed by `flowId`
 * deliver subsequent state transitions.
 */
export interface StartOAuthResponse {
	flowId: string;
	url: string;
	instructions?: string;
}

/** Client → deck: paste the redirect URL or raw `code` from the browser. */
export interface OAuthManualCodeRequest {
	code: string;
}

/** Client → deck: reply to a mid-flow `onPrompt` request from the SDK. */
export interface OAuthPromptReplyRequest {
	promptId: string;
	answer: string;
}
