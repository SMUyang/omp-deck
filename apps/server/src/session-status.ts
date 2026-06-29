import type { AgentMessageJson, SessionSnapshot } from "@omp-deck/protocol";

import { logger } from "./log.ts";

const log = logger("session-status");

interface UsageCostObject {
	total?: unknown;
}

interface UsageRollup {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	cost: number;
}

interface ProviderUsageAmount {
	used?: unknown;
	limit?: unknown;
	remaining?: unknown;
	usedFraction?: unknown;
	remainingFraction?: unknown;
	unit?: unknown;
}

interface ProviderUsageWindow {
	label?: unknown;
	resetsAt?: unknown;
}

interface ProviderUsageLimit {
	label?: unknown;
	status?: unknown;
	amount?: unknown;
	window?: unknown;
}

interface ProviderUsageReport {
	provider?: unknown;
	limits?: unknown;
	notes?: unknown;
}

export interface ProviderUsageJson {
	generatedAt?: unknown;
	reports?: unknown;
}

export interface BuildSessionStatusOptions {
	snapshot: SessionSnapshot;
	providerUsageJson?: ProviderUsageJson;
	providerUsageError?: string;
}

export interface BuildLiveSessionStatusOptions {
	snapshot: SessionSnapshot;
	ompBin: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function numberOrZero(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function numberOrUndefined(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function usageCost(value: unknown): number {
	if (!isRecord(value)) return 0;
	const cost = value.cost;
	if (isRecord(cost)) return numberOrZero((cost as UsageCostObject).total);
	return numberOrZero(cost);
}

function extractMessageUsage(message: AgentMessageJson): UsageRollup | undefined {
	const raw = message.usage;
	if (!isRecord(raw)) return undefined;
	return {
		input: numberOrZero(raw.input),
		output: numberOrZero(raw.output),
		cacheRead: numberOrZero(raw.cacheRead),
		cacheWrite: numberOrZero(raw.cacheWrite),
		totalTokens: numberOrZero(raw.totalTokens),
		cost: usageCost(raw),
	};
}

function rollupUsage(messages: readonly AgentMessageJson[]): UsageRollup {
	const total: UsageRollup = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: 0,
	};
	for (const message of messages) {
		const usage = extractMessageUsage(message);
		if (!usage) continue;
		total.input += usage.input;
		total.output += usage.output;
		total.cacheRead += usage.cacheRead;
		total.cacheWrite += usage.cacheWrite;
		total.totalTokens += usage.totalTokens;
		total.cost += usage.cost;
	}
	return total;
}

function formatTokens(value: number): string {
	if (!Number.isFinite(value)) return "0";
	if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}m`;
	if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
	return String(value);
}

function formatPercent(value: number): string {
	return `${(value * 100).toFixed(1)}%`;
}

function formatDuration(ms: number): string {
	const minutes = Math.max(1, Math.round(ms / 60_000));
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.round(minutes / 60);
	if (hours < 48) return `${hours}h`;
	return `${Math.round(hours / 24)}d`;
}

function reportProvider(report: ProviderUsageReport): string | undefined {
	return typeof report.provider === "string" && report.provider ? report.provider : undefined;
}

function reportLimits(report: ProviderUsageReport): ProviderUsageLimit[] {
	if (!Array.isArray(report.limits)) return [];
	return report.limits.filter(isRecord) as ProviderUsageLimit[];
}

function limitAmount(limit: ProviderUsageLimit): ProviderUsageAmount | undefined {
	return isRecord(limit.amount) ? (limit.amount as ProviderUsageAmount) : undefined;
}

function limitWindow(limit: ProviderUsageLimit): ProviderUsageWindow | undefined {
	return isRecord(limit.window) ? (limit.window as ProviderUsageWindow) : undefined;
}

function formatLimitAmount(amount: ProviderUsageAmount | undefined): string {
	if (!amount) return "usage unavailable";
	const unit = typeof amount.unit === "string" ? amount.unit : "units";
	const used = numberOrUndefined(amount.used);
	const limit = numberOrUndefined(amount.limit);
	const remaining = numberOrUndefined(amount.remaining);
	const usedFraction = numberOrUndefined(amount.usedFraction);
	const remainingFraction = numberOrUndefined(amount.remainingFraction);
	if (used !== undefined && limit !== undefined) {
		const remainingText = remaining !== undefined ? `, ${remaining.toFixed(2)} ${unit} left` : "";
		return `${used.toFixed(2)} / ${limit.toFixed(2)} ${unit}${remainingText}`;
	}
	if (usedFraction !== undefined) {
		const left = remainingFraction !== undefined ? `, ${formatPercent(remainingFraction)} left` : "";
		return `${formatPercent(usedFraction)} used${left}`;
	}
	return "usage unavailable";
}

function formatLimitLine(limit: ProviderUsageLimit): string {
	const label = typeof limit.label === "string" && limit.label ? limit.label : "Usage limit";
	const status = typeof limit.status === "string" && limit.status ? ` [${limit.status}]` : "";
	const window = limitWindow(limit);
	const windowLabel = typeof window?.label === "string" && window.label ? ` — ${window.label}` : "";
	const resetsAt = numberOrUndefined(window?.resetsAt);
	const reset = resetsAt && resetsAt > Date.now() ? `, resets in ${formatDuration(resetsAt - Date.now())}` : "";
	return `- ${label}${status}${windowLabel}: ${formatLimitAmount(limitAmount(limit))}${reset}`;
}

export function renderProviderUsageJson(json: ProviderUsageJson | undefined, currentProvider?: string): string {
	if (!json || !Array.isArray(json.reports) || json.reports.length === 0) {
		return "Provider usage unavailable.";
	}
	const reports = json.reports.filter(isRecord) as ProviderUsageReport[];
	const sorted = [...reports].sort((left, right) => {
		const leftProvider = reportProvider(left) ?? "";
		const rightProvider = reportProvider(right) ?? "";
		if (currentProvider && leftProvider === currentProvider && rightProvider !== currentProvider) return -1;
		if (currentProvider && rightProvider === currentProvider && leftProvider !== currentProvider) return 1;
		return leftProvider.localeCompare(rightProvider);
	});
	const lines: string[] = [];
	for (const report of sorted) {
		const provider = reportProvider(report) ?? "unknown";
		lines.push(provider);
		const notes = Array.isArray(report.notes) ? report.notes.filter((n): n is string => typeof n === "string") : [];
		for (const note of notes) lines.push(`- ${note}`);
		const limits = reportLimits(report);
		if (limits.length === 0) {
			lines.push("- no limits reported");
			continue;
		}
		for (const limit of limits.slice(0, 4)) lines.push(formatLimitLine(limit));
	}
	return lines.join("\n");
}

async function isBunScript(command: string): Promise<boolean> {
	try {
		const firstLine = (await Bun.file(command).slice(0, 256).text()).split(/\r?\n/, 1)[0] ?? "";
		return /^#!.*\bbun\b/.test(firstLine);
	} catch {
		return false;
	}
}

export async function buildOmpUsageCommand(ompBin: string): Promise<string[]> {
	if (!(await isBunScript(ompBin))) return [ompBin, "usage", "--json"];
	if (process.platform === "win32") return ["bun", ompBin, "usage", "--json"];
	return ["env", "-S", "bun", ompBin, "usage", "--json"];
}

export async function fetchProviderUsageJson(ompBin: string): Promise<ProviderUsageJson> {
	const proc = Bun.spawn(await buildOmpUsageCommand(ompBin), {
		stdout: "pipe",
		stderr: "pipe",
		env: { ...process.env, NO_COLOR: "1" },
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	if (exitCode !== 0) {
		throw new Error(stderr.trim() || `omp usage --json exited ${exitCode}`);
	}
	const parsed = JSON.parse(stdout) as unknown;
	if (!isRecord(parsed)) throw new Error("omp usage --json returned non-object JSON");
	return parsed as ProviderUsageJson;
}

export async function buildLiveSessionStatusText(options: BuildLiveSessionStatusOptions): Promise<string> {
	let providerUsageJson: ProviderUsageJson | undefined;
	let providerUsageError: string | undefined;
	try {
		providerUsageJson = await fetchProviderUsageJson(options.ompBin);
	} catch (err) {
		providerUsageError = err instanceof Error ? err.message : String(err);
		log.warn("provider usage fetch failed", err);
	}
	return await buildSessionStatusText({
		snapshot: options.snapshot,
		providerUsageJson,
		providerUsageError,
	});
}

export async function buildSessionStatusText(options: BuildSessionStatusOptions): Promise<string> {
	const { snapshot } = options;
	const usage = rollupUsage(snapshot.messages);
	const model = snapshot.model ? `${snapshot.model.provider}/${snapshot.model.id}` : "unknown";
	const context = snapshot.contextUsage;
	const contextTokens = context ? numberOrUndefined(context.tokens) : undefined;
	const contextPercent = context ? numberOrUndefined(context.percent) : undefined;
	const contextWindow = context ? numberOrUndefined(context.contextWindow) : undefined;
	const contextText = !context
		? "unavailable"
		: contextTokens !== undefined && contextPercent !== undefined && contextWindow !== undefined
			? `${formatTokens(contextTokens)} / ${formatTokens(contextWindow)} tokens (${contextPercent.toFixed(1)}%)`
			: `${formatTokens(contextWindow ?? 0)} window, usage refresh pending`;
	const providerUsage = options.providerUsageError
		? `Provider usage unavailable: ${options.providerUsageError}`
		: renderProviderUsageJson(options.providerUsageJson, snapshot.model?.provider);
	return [
		"Status",
		"",
		"Session",
		`- model: ${model}`,
		`- cwd: ${snapshot.cwd}`,
		`- session: ${snapshot.sessionId}`,
		`- streaming: ${snapshot.isStreaming ? "yes" : "no"}`,
		"",
		"Context",
		`- ${contextText}`,
		"",
		"Chat usage",
		`- ${formatTokens(usage.totalTokens)} tokens (in ${formatTokens(usage.input)}, out ${formatTokens(usage.output)}, cache ${formatTokens(usage.cacheRead + usage.cacheWrite)})`,
		`- $${usage.cost.toFixed(6)}`,
		"",
		"Provider usage",
		providerUsage,
	].join("\n");
}
