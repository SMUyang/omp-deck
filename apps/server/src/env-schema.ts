import type { EnvRestartTarget, EnvValueType } from "@omp-deck/protocol";

export interface EnvSchemaEntry {
	key: string;
	defaultValue?: string;
	valueType: EnvValueType;
	sensitive: boolean;
	restartRequired: boolean;
	hotApply: boolean;
	restartTarget?: EnvRestartTarget;
	description: string;
	options?: string[];
}

export const ENV_SCHEMA: EnvSchemaEntry[] = [
	{
		key: "OMP_DECK_HOST",
		defaultValue: "127.0.0.1",
		valueType: "string",
		sensitive: false,
		restartRequired: true,
		hotApply: false,
		description: "Backend bind host.",
	},
	{
		key: "OMP_DECK_PORT",
		defaultValue: "8787",
		valueType: "int",
		sensitive: false,
		restartRequired: true,
		hotApply: false,
		description: "Backend HTTP/WebSocket port.",
	},
	{
		key: "OMP_DECK_WEB_PORT",
		defaultValue: "5173",
		valueType: "int",
		sensitive: false,
		restartRequired: true,
		hotApply: false,
		description: "Vite dev server port.",
	},
	{
		key: "OMP_DECK_DEFAULT_CWD",
		valueType: "path",
		sensitive: false,
		restartRequired: false,
		hotApply: true,
		description: "Default cwd for new sessions.",
	},
	{
		key: "OMP_DECK_WORKSPACES",
		valueType: "string",
		sensitive: false,
		restartRequired: false,
		hotApply: true,
		description: "Comma-separated extra workspace roots.",
	},
	{
		key: "OMP_DECK_IDLE_TIMEOUT_MS",
		defaultValue: "300000",
		valueType: "int",
		sensitive: false,
		restartRequired: false,
		hotApply: true,
		description: "Milliseconds before unsubscribed idle sessions are reaped. 0 disables reaping.",
	},
	{
		key: "OMP_DECK_AUTO_START",
		valueType: "string",
		sensitive: false,
		restartRequired: false,
		hotApply: true,
		description: "Prompt fired automatically when a new session opens. Set to `/start` after creating `~/.omp/agent/commands/start.md`. Leave empty to disable (default).",
	},
	{
		key: "OMP_DECK_WEB_DIST",
		valueType: "path",
		sensitive: false,
		restartRequired: true,
		hotApply: false,
		description: "Static web bundle directory for production serving.",
	},
	{
		key: "OMP_DECK_DB_PATH",
		valueType: "path",
		sensitive: false,
		restartRequired: true,
		hotApply: false,
		description: "SQLite database path.",
	},
	{
		key: "OMP_DECK_DB",
		valueType: "path",
		sensitive: false,
		restartRequired: true,
		hotApply: false,
		description: "Legacy SQLite database path alias. Prefer OMP_DECK_DB_PATH.",
	},
	{
		key: "OMP_DECK_DATA_DIR",
		valueType: "path",
		sensitive: false,
		restartRequired: true,
		hotApply: false,
		description: "Directory for deck-managed .env and audit log.",
	},
	{
		key: "OMP_DECK_API_BASE",
		defaultValue: "http://127.0.0.1:8787",
		valueType: "string",
		sensitive: false,
		restartRequired: false,
		hotApply: false,
		description: "Loopback API base used by standalone bridge processes. If unset, bridges derive it from OMP_DECK_HOST and OMP_DECK_PORT.",
	},
	{
		key: "OMP_AGENT_DIR",
		valueType: "path",
		sensitive: false,
		restartRequired: true,
		hotApply: false,
		description: "omp SDK session/auth data directory.",
	},
	{
		key: "LOG_LEVEL",
		defaultValue: "info",
		valueType: "enum",
		options: ["debug", "info", "warn", "error"],
		sensitive: false,
		restartRequired: false,
		hotApply: true,
		description: "Server log threshold.",
	},
	{
		key: "PI_NO_TITLE",
		valueType: "boolean",
		sensitive: false,
		restartRequired: false,
		hotApply: true,
		description: "Disable SDK automatic title generation when set truthy.",
	},
	{
		key: "OMP_MODEL",
		valueType: "string",
		sensitive: false,
		restartRequired: false,
		hotApply: true,
		description: "Default omp SDK model identifier.",
	},
	{
		key: "TELEGRAM_BOT_TOKEN",
		valueType: "string",
		sensitive: true,
		restartRequired: true,
		restartTarget: "telegram-bridge",
		hotApply: false,
		description: "Telegram bot token used by the standalone telegram bridge. Saving it does not start the bridge process.",
	},
	{
		key: "TELEGRAM_ALLOWED_USERS",
		valueType: "string",
		sensitive: false,
		restartRequired: true,
		restartTarget: "telegram-bridge",
		hotApply: false,
		description: "Comma-separated numeric Telegram user IDs allowed to DM this bot. Required; usernames are not accepted.",
	},
	{
		key: "TELEGRAM_BRIDGE_DB_PATH",
		valueType: "path",
		sensitive: false,
		restartRequired: true,
		restartTarget: "telegram-bridge",
		hotApply: false,
		description: "Optional SQLite path for Telegram chat-to-session mappings. Defaults to the deck data directory.",
	},
	...[
		"ANTHROPIC_API_KEY",
		"OPENAI_API_KEY",
		"OPENROUTER_API_KEY",
		"GROQ_API_KEY",
		"GOOGLE_API_KEY",
		"XAI_API_KEY",
	].map((key): EnvSchemaEntry => ({
		key,
		valueType: "string",
		sensitive: true,
		restartRequired: true,
		hotApply: false,
		description: "Provider API key used by the omp SDK. Replace only; never revealed in list responses.",
	})),
	{
		key: "OMP_DECK_MAINTENANCE_GATE_DISABLED",
		valueType: "boolean",
		sensitive: false,
		restartRequired: false,
		hotApply: true,
		description:
			"Disable the maintenance-gate extension for new sessions when truthy. Honored by the deck (skips setting OMP_DECK_ORG_ROOT) and by the installed extension itself when present.",
	},
	{
		key: "OMP_MAINTENANCE_GATE_MIN_OP_MSGS",
		defaultValue: "4",
		valueType: "int",
		sensitive: false,
		restartRequired: false,
		hotApply: true,
		description:
			"Floor: operator messages since the last release event before the gate may fire again.",
	},
	{
		key: "OMP_MAINTENANCE_GATE_MIN_RELEASE_AGE_MS",
		defaultValue: "480000",
		valueType: "int",
		sensitive: false,
		restartRequired: false,
		hotApply: true,
		description: "Floor: wall-clock ms since the last release event before the gate may fire again.",
	},
	{
		key: "OMP_MAINTENANCE_GATE_FIRE_FLOOR_MS",
		defaultValue: "1500000",
		valueType: "int",
		sensitive: false,
		restartRequired: false,
		hotApply: true,
		description: "Floor: wall-clock ms between consecutive fires (cross-session via disk state).",
	},
	{
		key: "OMP_DECK_ORG_ROOT",
		valueType: "path",
		sensitive: false,
		restartRequired: false,
		hotApply: true,
		description:
			"Deck-session org root the maintenance-gate uses to anchor captures. Set automatically by the server to ~/kb unless overridden or disabled.",
	},
	{
		key: "CPA_USAGE_BASE_URL",
		valueType: "string",
		sensitive: false,
		restartRequired: false,
		hotApply: true,
		description:
			"Base URL of the CLIProxyAPI usage collector, e.g. https://api.hyanapi.xyz/collector. Required for CPA usage to appear in the Status panel.",
	},
	{
		key: "CPA_USAGE_USERNAME",
		valueType: "string",
		sensitive: false,
		restartRequired: false,
		hotApply: true,
		description: "Basic-auth username for the CPA usage collector (e.g. \"cpa\").",
	},
	{
		key: "CPA_USAGE_PASSWORD",
		valueType: "string",
		sensitive: true,
		restartRequired: false,
		hotApply: true,
		description:
			"Basic-auth password for the CPA usage collector. Server-side only; never exposed to the browser, logs, or error messages.",
	},
	{
		key: "CPA_USAGE_TIMEOUT_MS",
		defaultValue: "10000",
		valueType: "int",
		sensitive: false,
		restartRequired: false,
		hotApply: true,
		description: "Per-request timeout in milliseconds for CPA collector fetches.",
	},
];

export const ENV_SCHEMA_BY_KEY = new Map(ENV_SCHEMA.map((entry) => [entry.key, entry]));

export function validateEnvValue(entry: EnvSchemaEntry, value: string): string | undefined {
	if (entry.valueType === "int") {
		const n = Number.parseInt(value, 10);
		if (!Number.isFinite(n) || String(n) !== value.trim()) return "Expected an integer";
		if (n < 0) return "Expected a non-negative integer";
	}
	if (entry.valueType === "boolean") {
		const lower = value.trim().toLowerCase();
		if (!["", "0", "1", "true", "false", "yes", "no", "on", "off"].includes(lower)) {
			return "Expected on/off, true/false, 1/0, or empty";
		}
	}
	if (entry.valueType === "enum" && entry.options && !entry.options.includes(value.trim())) {
		return `Expected one of: ${entry.options.join(", ")}`;
	}
	return undefined;
}
