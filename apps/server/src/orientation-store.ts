/**
 * Orientation store
 *
 * Three artifacts shape every deck session: the prelude (system-prompt block
 * prepended at session create), the `/start` command (first user message
 * fired on session boot), and the maintenance-gate config (when/how the
 * gate nudges the agent to capture work). This module is the single
 * source of truth for reading + writing all three from outside the bridge.
 *
 * Persistence:
 *   - Prelude override → `<dataDir>/prelude.md` (deck-managed file). Absence
 *     means "fall back to DEFAULT_PRELUDE shipped in this module".
 *   - /start command   → `~/.omp/agent/commands/start.md` (the same file the
 *     omp SDK re-reads every time `/start` fires; we don't shadow it).
 *   - Maintenance-gate → managed env file via `env-store.ts`. We just project
 *     the relevant keys here.
 *
 * Read on each call rather than caching — these artifacts change infrequently
 * and the cost is one stat + small read per `createAgentSession`.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { GateKnob, GateValueSource, TopologyContextInjectionState, TopologyRerankConfig } from "@omp-deck/protocol";

import { normalizeDeckApiOrigin, isLoopbackApiOrigin } from "./api-base.ts";
import { getDataDir, readManagedEnvFile } from "./env-store.ts";

/**
 * System-prompt block prepended to every omp session created or resumed via
 * this bridge. Tells the agent omp-deck exists, where to find its REST API,
 * and how the kanban / cron / inbox surfaces are shaped — so it can read and
 * mutate them via `bash` + `curl` without needing the user to re-explain.
 *
 * Imperatives belong in the orchestrator (`/start.md`), NOT here — see
 * `kb://system/imperatives-belong-in-orchestrator-not-prelude.md`. This file
 * is reference material; the orchestrator drives the turn.
 */
export const DEFAULT_PRELUDE = `# omp-deck context

You are running inside an omp-deck session. omp-deck is a local web UI for
the omp coding agent that also exposes a kanban, cron scheduler, and inbox
over HTTP on the loopback interface.

Local API base: http://127.0.0.1:8787/api  (use the \`bash\` tool with \`curl\`).

## Knowledge base
A local llm-wiki at \`~/kb/\` is the deck's long-form memory; the cockpit's \`/kb\` view consumes it. The canonical orientation reads (\`working-voice\`, \`deck-orientation\`, \`projects-hub\`, \`org-system-hub\` — all under \`kb://system/\`) are wired into the \`/start\` slash command and fire on session boot. Re-read any of them directly when you need to re-anchor mid-session.

KB read: \`GET /api/kb/file?path=system/<name>.md\` · search: \`GET /api/kb/search?q=…\` · backlinks: \`GET /api/kb/backlinks?path=…\`. The harness also resolves \`kb://\` URIs directly via the read tool.

## Tasks (kanban)
- GET    /api/tasks                 → { tasks, states }
- POST   /api/tasks                 { title, body?, stateId?, cwd? }
- PATCH  /api/tasks/:id             { title?, body?, stateId?, cwd?, archived? }
- DELETE /api/tasks/:id
- POST   /api/tasks/:id/move        { stateId, index }
- GET/POST/PATCH/DELETE /api/task-states  (kanban columns; user-configurable)
- States are user-defined; default seed is backlog / active / blocked / done.
  Always fetch /api/task-states before assuming column ids.

## Routines (cron scheduler)
- GET    /api/routines              → { routines }
- POST   /api/routines              { name, cron, actionKind, actionBody, actionCwd?, enabled? }
- PATCH  /api/routines/:id          { …same fields, all optional }
- DELETE /api/routines/:id
- POST   /api/routines/:id/run      → fire now (out of schedule)
- GET    /api/routines/:id/runs?limit=N
- actionKind ∈ { "bash", "script", "prompt" }. \`prompt\` runs \`omp -p\` headless.

## Inbox
- GET    /api/inbox?kind=&includeProcessed=
- POST   /api/inbox                 { kind, title, body?, source? }
- PATCH  /api/inbox/:id             { kind?, title?, body?, source?, processed? }
- DELETE /api/inbox/:id
- kind ∈ { email, ticket, idea, decision, investigation, capture }

## Conventions
- All timestamps ISO-8601 UTC.
- IDs are app-generated strings; do not synthesize them.
- When the user asks about "tasks", "routines", or "inbox" without qualifier,
  they mean these REST surfaces — not files on disk.
- Before mutating, GET the current state. After mutating, briefly confirm.

## Creating things
Each mutation surface above has a preferred path. Use these when the user asks to "make a task / routine / inbox item":
- **Task** → \`POST /api/tasks\`. First \`GET /api/task-states\` — column ids are user-configurable, never hardcode \`s_backlog\`. Rich markdown body: \`## Why\` / \`## Scope\` / \`## Surface area\` / \`## Acceptance\` / \`## Out of scope\` sections make the task self-contained for the next picker-up.
- **Routine** → \`POST /api/routines\` with \`specVersion: 1\` + \`specYaml: <string>\`. **First read \`kb://system/routine-authoring-guide.md\`** — anatomy + step types + templating + worked example + gotchas (Windows ~32KB cmdline cap, \`$_\` stripping in PowerShell, state stickiness). Templates in \`apps/server/src/templates/*.yaml\`; V1 schema in \`packages/protocol/src/index.ts\` (\`RoutineSpec\`). Always create with \`enabled: false\` — user enables manually after spec review.
- **Inbox** → \`POST /api/inbox\`. Pick \`kind\` by intent (idea / decision / investigation / capture / ticket / email — see deck-orientation.md for the routing contract). Always set \`source\` to a stable id (\`chat\`, \`routine:<name>\`, \`agent:<id>\`); anonymous captures rot.

Skills that compose with these: \`skill://create-skill\`, \`skill://handoff\`, \`skill://grill-me\`, \`skill://prototype\`, \`skill://diagnose\`, \`skill://zoom-out\`. Use \`read skill://<name>\` to load any skill's full instructions.
`;

// ─── prelude ───────────────────────────────────────────────────────────────

export function getPreludeFilePath(): string {
	return path.join(getDataDir(), "prelude.md");
}

export function readPreludeOverride(): string | null {
	const p = getPreludeFilePath();
	try {
		return readFileSync(p, "utf8");
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw err;
	}
}

/** `null` clears the override; the next read returns DEFAULT_PRELUDE. */
export function writePreludeOverride(value: string | null): void {
	const p = getPreludeFilePath();
	if (value === null) {
		try {
			unlinkSync(p);
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
		}
		return;
	}
	mkdirSync(path.dirname(p), { recursive: true });
	writeFileSync(p, value, "utf8");
}

/** Effective text the bridge prepends to every session's system prompt. */
export function getEffectivePrelude(): string {
	return readPreludeOverride() ?? DEFAULT_PRELUDE;
}

// ─── /start command ────────────────────────────────────────────────────────

function getAgentDir(): string {
	const agentDir = process.env.OMP_AGENT_DIR?.trim();
	if (agentDir) return agentDir;
	const home = process.env.HOME?.trim() || process.env.USERPROFILE?.trim() || os.homedir();
	return path.join(home, ".omp", "agent");
}

export function getStartCommandPath(): string {
	return path.join(getAgentDir(), "commands", "start.md");
}

export interface StartCommand {
	path: string;
	exists: boolean;
	description: string;
	body: string;
}

export function readStartCommand(): StartCommand {
	const p = getStartCommandPath();
	let raw = "";
	let exists = false;
	try {
		raw = readFileSync(p, "utf8");
		exists = true;
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
	}
	const { description, body } = splitFrontmatter(raw);
	return { path: p, exists, description, body };
}

export function writeStartCommand(description: string, body: string): void {
	const p = getStartCommandPath();
	mkdirSync(path.dirname(p), { recursive: true });
	const desc = description.trim();
	const text = desc
		? `---\ndescription: ${desc}\n---\n${body.startsWith("\n") ? body.slice(1) : body}`
		: body;
	writeFileSync(p, text, "utf8");
}

/**
 * Minimal frontmatter parser — only extracts the `description:` scalar. The
 * omp SDK supports more fields, but the deck UI only surfaces description;
 * any other frontmatter the user adds will be lost on save. The `/start`
 * command body in practice only carries `description:`, so this is fine.
 */
function splitFrontmatter(text: string): { description: string; body: string } {
	if (!text.startsWith("---\n")) return { description: "", body: text };
	const end = text.indexOf("\n---", 4);
	if (end < 0) return { description: "", body: text };
	const yaml = text.slice(4, end);
	const rest = text.slice(end + 4).replace(/^\r?\n/, "");
	const match = /^description:\s*(.*)$/m.exec(yaml);
	const description = match ? match[1]!.trim().replace(/^["']|["']$/g, "") : "";
	return { description, body: rest };
}

// ─── maintenance-gate ──────────────────────────────────────────────────────

export const MAINTENANCE_GATE_DEFAULTS = {
	minOpMsgs: 4,
	minReleaseAgeMs: 8 * 60_000,
	fireFloorMs: 25 * 60_000,
} as const;

export const MAINTENANCE_GATE_ENV_KEYS = {
	disabled: "OMP_DECK_MAINTENANCE_GATE_DISABLED",
	minOpMsgs: "OMP_MAINTENANCE_GATE_MIN_OP_MSGS",
	minReleaseAgeMs: "OMP_MAINTENANCE_GATE_MIN_RELEASE_AGE_MS",
	fireFloorMs: "OMP_MAINTENANCE_GATE_FIRE_FLOOR_MS",
	orgRoot: "OMP_DECK_ORG_ROOT",
} as const;


export const TOPOLOGY_RERANK_ENV_KEYS = {
	enabled: "OMP_DECK_TOPOLOGY_RERANK_ENABLED",
	rerankModelRole: "OMP_DECK_TOPOLOGY_RERANK_ROLE",
	provider: "OMP_DECK_TOPOLOGY_RERANK_PROVIDER",
	httpBaseUrl: "OMP_DECK_TOPOLOGY_RERANK_HTTP_BASE_URL",
	httpEndpointPath: "OMP_DECK_TOPOLOGY_RERANK_HTTP_ENDPOINT_PATH",
	httpTimeoutMs: "OMP_DECK_TOPOLOGY_RERANK_HTTP_TIMEOUT_MS",
	httpConfidenceThreshold: "OMP_DECK_TOPOLOGY_RERANK_HTTP_CONFIDENCE_THRESHOLD",
	httpMinCandidateNodes: "OMP_DECK_TOPOLOGY_RERANK_HTTP_MIN_CANDIDATE_NODES",
	httpMinContextPercent: "OMP_DECK_TOPOLOGY_RERANK_HTTP_MIN_CONTEXT_PERCENT",
	httpAuthHeaderName: "OMP_DECK_TOPOLOGY_RERANK_HTTP_AUTH_HEADER_NAME",
	httpProtocol: "OMP_DECK_TOPOLOGY_RERANK_HTTP_PROTOCOL",
	httpModel: "OMP_DECK_TOPOLOGY_RERANK_HTTP_MODEL",
	minContextPercent: "OMP_DECK_TOPOLOGY_RERANK_MIN_CONTEXT_PERCENT",
	minCandidateNodes: "OMP_DECK_TOPOLOGY_RERANK_MIN_CANDIDATE_NODES",
	localConfidenceBelow: "OMP_DECK_TOPOLOGY_RERANK_LOCAL_CONFIDENCE_BELOW",
	timeoutMs: "OMP_DECK_TOPOLOGY_RERANK_TIMEOUT_MS",
} as const;

export type TopologyRerankProvider = "model_role" | "http";

export const TOPOLOGY_RERANK_DEFAULTS = {
	enabled: true,
	rerankModelRole: "topology_query_reranker",
	provider: "model_role" as TopologyRerankProvider,
	httpBaseUrl: "",
	httpEndpointPath: "/v1/topology/rerank",
	httpTimeoutMs: 30_000,
	httpConfidenceThreshold: 0.72,
	httpMinCandidateNodes: 16,
	httpMinContextPercent: 12,
	httpAuthHeaderName: "Authorization",
	httpProtocol: "deck-internal",
	httpModel: "BAAI/bge-reranker-v2-m3",
	minContextPercent: 12,
	minCandidateNodes: 16,
	localConfidenceBelow: 0.72,
	timeoutMs: 30_000,
} as const;

export const TOPOLOGY_CONTEXT_DEFAULTS = {
	apiBase: "http://127.0.0.1:8787",
	maxFocusChars: 50_000,
	timeoutMs: 1500,
} as const;

export const TOPOLOGY_CONTEXT_ENV_KEYS = {
	enabled: "OMP_DECK_TOPOLOGY_CONTEXT_ENABLED",
	apiBase: "OMP_DECK_API_BASE",
	maxFocusChars: "OMP_DECK_TOPOLOGY_CONTEXT_MAX_FOCUS_CHARS",
	timeoutMs: "OMP_DECK_TOPOLOGY_CONTEXT_TIMEOUT_MS",
} as const;

export interface MaintenanceGateState {
	enabled: boolean;
	disabledRaw: string | null;
	disabledSource: GateValueSource;
	knobs: {
		minOpMsgs: GateKnob;
		minReleaseAgeMs: GateKnob;
		fireFloorMs: GateKnob;
	};
	orgRoot: string | null;
	orgRootSource: GateValueSource;
	/** Whether the installed extension copy still exists on disk. */
	installedExtensionPresent: boolean;
	installedExtensionPath: string;
	/** Server-side render of the at-turn-end reminder so the UI can preview it. */
	preview: { deckMode: string; flatFileMode: string };
}

export function readMaintenanceGateState(): MaintenanceGateState {
	const file = readManagedEnvFile();
	const resolve = (key: string): { rawValue: string | null; source: GateValueSource } => {
		const processValue = process.env[key];
		const fileValue = file.values.get(key);
		if (processValue !== undefined && processValue !== fileValue) {
			return { rawValue: processValue, source: "process-env" };
		}
		if (fileValue !== undefined) return { rawValue: fileValue, source: "env-file" };
		if (processValue !== undefined) return { rawValue: processValue, source: "process-env" };
		return { rawValue: null, source: "unset" };
	};
	const intKnob = (key: string, def: number): GateKnob => {
		const { rawValue, source } = resolve(key);
		if (rawValue === null || rawValue === "") {
			return { value: def, default: def, rawValue: null, source: "default" };
		}
		const n = Number(rawValue);
		if (!Number.isSafeInteger(n) || n <= 0) {
			return { value: def, default: def, rawValue, source };
		}
		return { value: n, default: def, rawValue, source };
	};

	const disabled = resolve(MAINTENANCE_GATE_ENV_KEYS.disabled);
	const orgRoot = resolve(MAINTENANCE_GATE_ENV_KEYS.orgRoot);
	const enabled = !isTruthy(disabled.rawValue);

	const installedExtensionPath = path.join(
		getAgentDir(),
		"extensions",
		"maintenance-gate",
		"index.ts",
	);

	return {
		enabled,
		disabledRaw: disabled.rawValue,
		disabledSource: disabled.source,
		knobs: {
			minOpMsgs: intKnob(MAINTENANCE_GATE_ENV_KEYS.minOpMsgs, MAINTENANCE_GATE_DEFAULTS.minOpMsgs),
			minReleaseAgeMs: intKnob(
				MAINTENANCE_GATE_ENV_KEYS.minReleaseAgeMs,
				MAINTENANCE_GATE_DEFAULTS.minReleaseAgeMs,
			),
			fireFloorMs: intKnob(
				MAINTENANCE_GATE_ENV_KEYS.fireFloorMs,
				MAINTENANCE_GATE_DEFAULTS.fireFloorMs,
			),
		},
		orgRoot: orgRoot.rawValue,
		orgRootSource: orgRoot.source,
		installedExtensionPresent: existsSync(installedExtensionPath),
		installedExtensionPath,
		preview: {
			deckMode: renderMaintenanceReminder("deck"),
			flatFileMode: renderMaintenanceReminder("flat-file"),
		},
	};
}


export function readTopologyContextInjectionState(): TopologyContextInjectionState {
	const file = readManagedEnvFile();
	const resolve = (key: string): { rawValue: string | null; source: GateValueSource } => {
		const processValue = process.env[key];
		const fileValue = file.values.get(key);
		if (processValue !== undefined && processValue !== fileValue) {
			return { rawValue: processValue, source: "process-env" };
		}
		if (fileValue !== undefined) return { rawValue: fileValue, source: "env-file" };
		if (processValue !== undefined) return { rawValue: processValue, source: "process-env" };
		return { rawValue: null, source: "unset" };
	};
	const intKnob = (key: string, def: number): GateKnob => {
		const { rawValue, source } = resolve(key);
		if (rawValue === null || rawValue === "") {
			return { value: def, default: def, rawValue: null, source: "default" };
		}
		const n = Number(rawValue);
		if (!Number.isSafeInteger(n) || n <= 0) {
			return { value: def, default: def, rawValue, source };
		}
		return { value: n, default: def, rawValue, source };
	};

	const enabled = resolve(TOPOLOGY_CONTEXT_ENV_KEYS.enabled);
	const apiBase = resolve(TOPOLOGY_CONTEXT_ENV_KEYS.apiBase);
	const installedExtensionPath = path.join(
		getAgentDir(),
		"extensions",
		"topology-context",
		"index.ts",
	);
	const bundledExtensionPath = resolveBundledTopologyContextExtensionPath();
	const installedHash = hashFileIfExists(installedExtensionPath);
	const bundledHash = bundledExtensionPath ? hashFileIfExists(bundledExtensionPath) : null;
	const installedExtensionPresent = installedHash !== null;
	const bundledExtensionPresent = bundledHash !== null;
	const installStatus = !installedExtensionPresent
		? "missing"
		: installedHash === bundledHash && bundledHash !== null
			? "current"
			: "user-owned-or-outdated";
	const hasExplicitApiBase = apiBase.rawValue !== null && apiBase.rawValue.trim().length > 0;
	let apiBaseValue: string = TOPOLOGY_CONTEXT_DEFAULTS.apiBase;
	let apiBaseParseOk = true;
	if (hasExplicitApiBase) {
		try {
			apiBaseValue = normalizeDeckApiOrigin(apiBase.rawValue ?? "");
		} catch {
			apiBaseParseOk = false;
			apiBaseValue = apiBase.rawValue?.trim() ?? "";
		}
	}
	const isEnabled = isTruthy(enabled.rawValue);
	let inactiveReason: TopologyContextInjectionState["inactiveReason"];
	if (!isEnabled) inactiveReason = "disabled";
	else if (!hasExplicitApiBase) inactiveReason = "missing_api_base";
	else if (!apiBaseParseOk || !isLoopbackApiOrigin(apiBaseValue)) inactiveReason = "invalid_api_base";
	else if (!installedExtensionPresent) inactiveReason = "extension_missing";

	return {
		enabled: isEnabled,
		enabledRaw: enabled.rawValue,
		enabledSource: enabled.source,
		active: inactiveReason === undefined,
		...(inactiveReason ? { inactiveReason } : {}),
		apiBase: {
			value: apiBaseValue,
			default: TOPOLOGY_CONTEXT_DEFAULTS.apiBase,
			rawValue: apiBase.rawValue,
			source: apiBase.rawValue === null || apiBase.rawValue === "" ? "default" : apiBase.source,
		},
		maxFocusChars: intKnob(TOPOLOGY_CONTEXT_ENV_KEYS.maxFocusChars, TOPOLOGY_CONTEXT_DEFAULTS.maxFocusChars),
		timeoutMs: intKnob(TOPOLOGY_CONTEXT_ENV_KEYS.timeoutMs, TOPOLOGY_CONTEXT_DEFAULTS.timeoutMs),
		installedExtensionPresent,
		installedExtensionPath,
		bundledExtensionPresent,
		bundledExtensionPath: bundledExtensionPath ?? "",
		installedHash,
		bundledHash,
		installStatus,
	};
}


export function readTopologyRerankConfig(): TopologyRerankConfig {
	const file = readManagedEnvFile();
	const resolve = (key: string): { rawValue: string | null; source: GateValueSource } => {
		const processValue = process.env[key];
		const fileValue = file.values.get(key);
		if (processValue !== undefined && processValue !== fileValue) {
			return { rawValue: processValue, source: "process-env" };
		}
		if (fileValue !== undefined) return { rawValue: fileValue, source: "env-file" };
		if (processValue !== undefined) return { rawValue: processValue, source: "process-env" };
		return { rawValue: null, source: "unset" };
	};
	const intKnob = (key: string, def: number): GateKnob => {
		const { rawValue, source } = resolve(key);
		if (rawValue === null || rawValue === "") {
			return { value: def, default: def, rawValue: null, source: "default" };
		}
		const n = Number(rawValue);
		if (!Number.isSafeInteger(n) || n <= 0) {
			return { value: def, default: def, rawValue, source };
		}
		return { value: n, default: def, rawValue, source };
	};
	const nonNegativeKnob = (key: string, def: number): GateKnob => {
		const { rawValue, source } = resolve(key);
		if (rawValue === null || rawValue === "") {
			return { value: def, default: def, rawValue: null, source: "default" };
		}
		const n = Number(rawValue);
		if (!Number.isFinite(n) || n < 0) {
			return { value: def, default: def, rawValue, source };
		}
		return { value: n, default: def, rawValue, source };
	};

	const floatKnob = (key: string, def: number): { value: number; default: number; rawValue: string | null; source: GateValueSource } => {
		const { rawValue, source } = resolve(key);
		if (rawValue === null || rawValue === "") {
			return { value: def, default: def, rawValue: null, source: "default" };
		}
		const n = Number(rawValue);
		if (!Number.isFinite(n)) {
			return { value: def, default: def, rawValue, source };
		}
		return { value: Math.min(1, Math.max(0, n)), default: def, rawValue, source };
	};

	const stringKnob = (key: string, def: string) => {
		const { rawValue, source } = resolve(key);
		if (rawValue === null || rawValue === "") {
			return { value: def, default: def, rawValue: null, source: "default" };
		}
		const knob: { value: string; default: string; rawValue: string; source: GateValueSource } = { value: rawValue, default: def, rawValue, source };
		return knob as unknown as GateKnob;
	};
	const providerKnob = () => {
		const { rawValue, source } = resolve(TOPOLOGY_RERANK_ENV_KEYS.provider);
		if (rawValue !== "model_role" && rawValue !== "http") {
			const knob: { value: TopologyRerankProvider; default: TopologyRerankProvider; rawValue: string | null; source: GateValueSource } = { value: "model_role", default: "model_role", rawValue, source: "default" };
			return knob as unknown as GateKnob;
		}
		const knob: { value: TopologyRerankProvider; default: TopologyRerankProvider; rawValue: string; source: GateValueSource } = { value: rawValue, default: "model_role", rawValue, source };
		return knob as unknown as GateKnob;
	};

	const enabled = resolve(TOPOLOGY_RERANK_ENV_KEYS.enabled);
	const role = resolve(TOPOLOGY_RERANK_ENV_KEYS.rerankModelRole);

	return {
		enabled: enabled.rawValue !== null ? isTruthy(enabled.rawValue) : TOPOLOGY_RERANK_DEFAULTS.enabled,
		enabledRaw: enabled.rawValue,
		enabledSource: enabled.rawValue !== null ? enabled.source : "default",
		rerankModelRole: (role.rawValue && role.rawValue.trim()) ? role.rawValue.trim() : TOPOLOGY_RERANK_DEFAULTS.rerankModelRole,
		rerankModelRoleRaw: role.rawValue,
		rerankModelRoleSource: role.rawValue ? role.source : "default",
		minContextPercent: nonNegativeKnob(TOPOLOGY_RERANK_ENV_KEYS.minContextPercent, TOPOLOGY_RERANK_DEFAULTS.minContextPercent),
		minCandidateNodes: intKnob(TOPOLOGY_RERANK_ENV_KEYS.minCandidateNodes, TOPOLOGY_RERANK_DEFAULTS.minCandidateNodes),
		localConfidenceBelow: floatKnob(TOPOLOGY_RERANK_ENV_KEYS.localConfidenceBelow, TOPOLOGY_RERANK_DEFAULTS.localConfidenceBelow),
		timeoutMs: intKnob(TOPOLOGY_RERANK_ENV_KEYS.timeoutMs, TOPOLOGY_RERANK_DEFAULTS.timeoutMs),
		provider: providerKnob() as unknown as import("@omp-deck/protocol").TopologyRerankProviderKnob,
		http: {
			baseUrl: stringKnob(TOPOLOGY_RERANK_ENV_KEYS.httpBaseUrl, TOPOLOGY_RERANK_DEFAULTS.httpBaseUrl) as unknown as import("@omp-deck/protocol").TopologyRerankStringKnob,
			endpointPath: stringKnob(TOPOLOGY_RERANK_ENV_KEYS.httpEndpointPath, TOPOLOGY_RERANK_DEFAULTS.httpEndpointPath) as unknown as import("@omp-deck/protocol").TopologyRerankStringKnob,
			protocol: stringKnob(TOPOLOGY_RERANK_ENV_KEYS.httpProtocol, TOPOLOGY_RERANK_DEFAULTS.httpProtocol) as unknown as import("@omp-deck/protocol").TopologyRerankHttpProtocolKnob,
			model: stringKnob(TOPOLOGY_RERANK_ENV_KEYS.httpModel, TOPOLOGY_RERANK_DEFAULTS.httpModel) as unknown as import("@omp-deck/protocol").TopologyRerankStringKnob,
			timeoutMs: intKnob(TOPOLOGY_RERANK_ENV_KEYS.httpTimeoutMs, TOPOLOGY_RERANK_DEFAULTS.httpTimeoutMs),
			confidenceThreshold: floatKnob(TOPOLOGY_RERANK_ENV_KEYS.httpConfidenceThreshold, TOPOLOGY_RERANK_DEFAULTS.httpConfidenceThreshold),
			minCandidateNodes: intKnob(TOPOLOGY_RERANK_ENV_KEYS.httpMinCandidateNodes, TOPOLOGY_RERANK_DEFAULTS.httpMinCandidateNodes),
			minContextPercent: nonNegativeKnob(TOPOLOGY_RERANK_ENV_KEYS.httpMinContextPercent, TOPOLOGY_RERANK_DEFAULTS.httpMinContextPercent),
			authHeaderName: stringKnob(TOPOLOGY_RERANK_ENV_KEYS.httpAuthHeaderName, TOPOLOGY_RERANK_DEFAULTS.httpAuthHeaderName) as unknown as import("@omp-deck/protocol").TopologyRerankStringKnob,
		},
	};
}


function resolveBundledTopologyContextExtensionPath(): string | null {
	const override = process.env.OMP_DECK_STARTER_EXTENSIONS_DIR;
	const candidates = [
		...(override ? [override] : []),
		path.resolve(import.meta.dir, "..", "..", "..", "starter-extensions"),
		path.resolve(import.meta.dir, "..", "..", "starter-extensions"),
		path.resolve(import.meta.dir, "..", "starter-extensions"),
		path.resolve(process.cwd(), "starter-extensions"),
	];
	for (const candidate of candidates) {
		const extensionPath = path.join(candidate, "topology-context", "index.ts");
		if (existsSync(extensionPath)) return extensionPath;
	}
	return null;
}

function hashFileIfExists(filePath: string): string | null {
	try {
		if (!existsSync(filePath)) return null;
		return createHash("sha256").update(readFileSync(filePath)).digest("hex");
	} catch {
		return null;
	}
}

function isTruthy(value: string | null | undefined): boolean {
	if (!value) return false;
	const lower = value.trim().toLowerCase();
	return ["1", "true", "yes", "on"].includes(lower);
}

/**
 * Server-side mirror of the maintenance-gate extension's `buildReminder()`.
 * Lives here so the deck UI can preview both profiles without reaching into
 * the installed extension. If `starter-extensions/maintenance-gate/index.ts`
 * changes the row table, update both sides — they are intentionally a
 * format contract (see kb://system/format-contracts-not-register-contracts).
 */
export function renderMaintenanceReminder(profile: "deck" | "flat-file"): string {
	const deckMode = profile === "deck";
	const rows: [string, string][] = deckMode
		? [
				["Reusable insight or pattern", "→ `kb://system/<topic>.md`"],
				[
					"Project status changed",
					"→ `POST /api/inbox` with `kind: \"capture\"` describing the change; daily briefing reconciles into `kb://system/projects-hub.md`",
				],
				["New task identified", "→ `POST /api/tasks`"],
				[
					"Question worth preserving",
					"→ `POST /api/inbox` with `kind: \"capture\"` (or `kind: \"investigation\"` if you intend to follow up)",
				],
				["Feature idea / future project", "→ `POST /api/inbox` with `kind: \"idea\"`"],
				["Decision needed", "→ `POST /api/inbox` with `kind: \"decision\"`"],
				["Bug to investigate", "→ `POST /api/inbox` with `kind: \"investigation\"`"],
				["Quick unsorted capture", "→ `POST /api/inbox` with `kind: \"capture\"`"],
				[
					"New capability learned",
					"→ create a skill at `.omp/skills/<name>/SKILL.md` (project) or `~/.omp/agent/skills/<name>/SKILL.md` (user)",
				],
			]
		: [
				["Reusable insight or pattern", "→ `knowledge/<subfolder>/<topic>.md`"],
				["Project status changed", "→ update `context/current-state.md`"],
				["New task identified", "→ `tasks/<name>.md`"],
				["Question worth preserving", "→ `queries/<question>.md`"],
				["Feature idea / future project", "→ `inbox/ideas/<item>.md`"],
				["Decision needed", "→ `inbox/decisions/<item>.md`"],
				["Bug to investigate", "→ `inbox/investigations/<item>.md`"],
				["Quick unsorted capture", "→ `inbox/captures/<item>.md`"],
				[
					"New capability learned",
					"→ create a skill at `.omp/skills/<name>/SKILL.md` (project) or `~/.omp/agent/skills/<name>/SKILL.md` (user)",
				],
			];
	const releaseClause = deckMode
		? "invoking any of the REST endpoints below (or writing to one of the listed paths)"
		: "writing to any of the paths below";

	return [
		"---",
		"",
		"## Maintenance check",
		"",
		`Did this segment of work produce any of the signals below? Capture **now** — ${releaseClause} releases this check automatically. If nothing applies, state the literal phrase "No maintenance needed" to release.`,
		"",
		"| Signal | Action if present |",
		"|--------|-------------------|",
		...rows.map(([signal, action]) => `| ${signal} | ${action} |`),
		"",
		"Be aggressive about capture — lost insights are unrecoverable.",
		"",
		"---",
	].join("\n");
}
