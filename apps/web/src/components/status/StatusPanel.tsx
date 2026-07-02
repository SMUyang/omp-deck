import { useEffect, useMemo, useState } from "react";
import type {
	CpaUsageAggregate,
	CpaUsageResponse,
	CpaUsageWindow,
	ProviderUsageLimitWire,
	ProviderUsageResponse,
} from "@omp-deck/protocol";

import { api } from "@/lib/api";
import { selectActiveSession, useStore } from "@/lib/store";
import type { SessionUi } from "@/lib/types";
import { formatCost, formatTokens, shortPath } from "@/lib/utils";

type CpaWindowLabel = "1h" | "24h" | "7d";

interface CpaWindowViewModel {
	label: CpaWindowLabel;
	requests: string;
	errors: string;
	tokens: string;
	topModels: string[];
	topApiKeys: string[];
}

interface CpaUsageViewModel {
	description: string;
	loadingLabel?: string;
	error?: string;
	windows: CpaWindowViewModel[];
}

interface StatusPanelViewModel {
	sessionRows: Array<{ label: string; value: string; title?: string }>;
	contextLine: string;
	chatLine: string;
	costLine: string;
	providerSections: Array<{
		title: string;
		notes: string[];
		limits: Array<{ label: string; summary: string; status?: string; window?: string }>;
	}>;
	providerError?: string;
	cpaUsage: CpaUsageViewModel;
}

const CPA_DESCRIPTION = "CLIProxyAPI request usage, not remaining quota.";
const CPA_LOADING_LABEL = "Loading CPA usage…";
const CPA_WINDOW_ORDER: ReadonlyArray<[CpaWindowLabel, "h1" | "h24" | "d7"]> = [
	["1h", "h1"],
	["24h", "h24"],
	["7d", "d7"],
];

let providerUsageCache: ProviderUsageResponse | undefined;
let providerUsageRequest: Promise<ProviderUsageResponse> | undefined;
let cpaUsageCache: CpaUsageResponse | undefined;
let cpaUsageRequest: Promise<CpaUsageResponse> | undefined;

function loadProviderUsage(): Promise<ProviderUsageResponse> {
	providerUsageRequest ??= api.getProviderUsage().then((res) => {
		providerUsageCache = res;
		return res;
	});
	return providerUsageRequest;
}

function loadCpaUsage(): Promise<CpaUsageResponse> {
	cpaUsageRequest ??= api
		.getCpaUsage()
		.then((res) => {
			cpaUsageCache = res;
			return res;
		})
		.catch((err): CpaUsageResponse => {
			const message = err instanceof Error ? err.message : String(err);
			const fallback: CpaUsageResponse = {
				available: false,
				generatedAt: Date.now(),
				error: message,
			};
			cpaUsageCache = fallback;
			return fallback;
		});
	return cpaUsageRequest;
}

function formatPercent(value: number): string {
	return `${(value * 100).toFixed(1)}%`;
}

function formatContext(session: SessionUi): string {
	const usage = session.contextUsage;
	if (!usage) return "unavailable";
	if (typeof usage.tokens === "number" && typeof usage.percent === "number") {
		return `${formatTokens(usage.tokens)} / ${formatTokens(usage.contextWindow)} · ${usage.percent.toFixed(1)}%`;
	}
	return `${formatTokens(usage.contextWindow)} window · refresh pending`;
}

function formatLimitSummary(limit: ProviderUsageLimitWire): string {
	if (typeof limit.usedFraction === "number") {
		const parts = [`${formatPercent(limit.usedFraction)} used`];
		if (typeof limit.remainingFraction === "number") parts.push(`${formatPercent(limit.remainingFraction)} left`);
		return parts.join(" · ");
	}
	if (typeof limit.used === "number" && typeof limit.limit === "number") {
		const unit = limit.unit ?? "units";
		const parts = [`${limit.used.toFixed(2)} / ${limit.limit.toFixed(2)} ${unit}`];
		if (typeof limit.remaining === "number") parts.push(`${limit.remaining.toFixed(2)} left`);
		return parts.join(" · ");
	}
	return "usage unavailable";
}

function topAggregateLabels(aggregates: CpaUsageAggregate[], label: (a: CpaUsageAggregate) => string): string[] {
	return [...aggregates]
		.sort((a, b) => b.n - a.n)
		.slice(0, 3)
		.map((a) => `${label(a)} · ${a.n.toLocaleString()}`);
}

function buildCpaWindows(cpaUsage: CpaUsageResponse): CpaWindowViewModel[] {
	const windows = cpaUsage.windows;
	if (!windows) return [];
	const out: CpaWindowViewModel[] = [];
	for (const [label, key] of CPA_WINDOW_ORDER) {
		const win: CpaUsageWindow | undefined = windows[key];
		if (!win) continue;
		const t = win.totals;
		out.push({
			label,
			requests: `${t.requests.toLocaleString()} requests`,
			errors: `${t.errors.toLocaleString()} errors · ${formatPercent(t.error_rate)}`,
			tokens: `${formatTokens(t.total_tokens)} tokens`,
			topModels: topAggregateLabels(win.per_model, (a) => a.model ?? "unknown"),
			topApiKeys: topAggregateLabels(win.per_api_key, (a) => a.key_id ?? a.account ?? "key"),
		});
	}
	return out;
}

function buildCpaUsageViewModel(cpaUsage?: CpaUsageResponse): CpaUsageViewModel {
	if (!cpaUsage) {
		return { description: CPA_DESCRIPTION, loadingLabel: CPA_LOADING_LABEL, windows: [] };
	}
	if (!cpaUsage.available) {
		return {
			description: CPA_DESCRIPTION,
			error: cpaUsage.error ?? "CPA usage unavailable.",
			windows: [],
		};
	}
	return {
		description: CPA_DESCRIPTION,
		error: cpaUsage.error,
		windows: buildCpaWindows(cpaUsage),
	};
}

export function buildStatusPanelViewModel(
	session: SessionUi,
	providerUsage?: ProviderUsageResponse,
	cpaUsage?: CpaUsageResponse,
): StatusPanelViewModel {
	const providerSections = (providerUsage?.reports ?? []).map((report) => ({
		title: report.provider,
		notes: report.notes ?? [],
		limits: report.limits.map((limit) => ({
			label: limit.label,
			summary: formatLimitSummary(limit),
			status: limit.status,
			window: limit.windowLabel,
		})),
	}));
	return {
		sessionRows: [
			{ label: "id", value: shortId(session.sessionId), title: session.sessionId },
			...(session.sessionName ? [{ label: "name", value: session.sessionName }] : []),
			{ label: "cwd", value: shortPath(session.cwd, 34), title: session.cwd },
			...(session.model ? [{ label: "model", value: `${session.model.provider}/${session.model.id}` }] : []),
			{ label: "state", value: session.status },
		],
		contextLine: formatContext(session),
		chatLine: `${formatTokens(session.usage.totalTokens)} tokens · ${session.turnCount} turns`,
		costLine: `${formatCost(session.usage.cost)} · in ${formatTokens(session.usage.input)} / out ${formatTokens(session.usage.output)}`,
		providerSections,
		providerError: providerUsage?.error,
		cpaUsage: buildCpaUsageViewModel(cpaUsage),
	};
}

export function StatusPanel() {
	const session = useStore(selectActiveSession);
	const [providerUsage, setProviderUsage] = useState<ProviderUsageResponse | undefined>(providerUsageCache);
	const [loading, setLoading] = useState(providerUsageCache === undefined);
	const [cpaUsage, setCpaUsage] = useState<CpaUsageResponse | undefined>(cpaUsageCache);
	const [cpaLoading, setCpaLoading] = useState(cpaUsageCache === undefined);

	useEffect(() => {
		let cancelled = false;
		if (providerUsageCache === undefined) setLoading(true);
		void loadProviderUsage()
			.then((res) => {
				if (!cancelled) setProviderUsage(res);
			})
			.catch((err) => {
				if (!cancelled) setProviderUsage({ reports: [], error: err instanceof Error ? err.message : String(err) });
			})
			.finally(() => {
				if (!cancelled) setLoading(false);
			});
		return () => {
			cancelled = true;
		};
	}, []);

	useEffect(() => {
		let cancelled = false;
		if (cpaUsageCache === undefined) setCpaLoading(true);
		void loadCpaUsage()
			.then((res) => {
				if (!cancelled) setCpaUsage(res);
			})
			.finally(() => {
				if (!cancelled) setCpaLoading(false);
			});
		return () => {
			cancelled = true;
		};
	}, []);

	const vm = useMemo(
		() => (session ? buildStatusPanelViewModel(session, providerUsage, cpaUsage) : undefined),
		[session, providerUsage, cpaUsage],
	);
	if (!session || !vm) {
		return <div className="px-4 py-6 font-mono text-2xs uppercase tracking-meta text-ink-3">No session selected</div>;
	}
	return (
		<div className="flex flex-col">
			<PanelSection title="Status">
				{vm.sessionRows.map((row) => (
					<KV key={row.label} k={row.label} v={row.value} title={row.title} />
				))}
			</PanelSection>
			<PanelSection title="Context">
				<div className="font-mono text-sm text-ink">{vm.contextLine}</div>
			</PanelSection>
			<PanelSection title="Chat usage">
				<div className="font-mono text-sm text-ink">{vm.chatLine}</div>
				<div className="mt-1 font-mono text-2xs text-ink-3">{vm.costLine}</div>
			</PanelSection>
			<PanelSection title="CPA usage">
				<div className="font-mono text-2xs text-ink-3">{vm.cpaUsage.description}</div>
				{cpaLoading ? <div className="font-mono text-2xs text-ink-3">{vm.cpaUsage.loadingLabel}</div> : null}
				{vm.cpaUsage.error ? <div className="text-xs text-danger">{vm.cpaUsage.error}</div> : null}
				{!cpaLoading && !vm.cpaUsage.error && vm.cpaUsage.windows.length === 0 ? (
					<div className="font-mono text-2xs text-ink-3">No CPA usage windows reported.</div>
				) : null}
				<div className="space-y-2">
					{vm.cpaUsage.windows.map((win) => (
						<div key={win.label} className="rounded-md border border-line bg-paper-2/60 p-2">
							<div className="mb-1 font-mono text-xs font-semibold text-ink">{win.label}</div>
							<div className="font-mono text-2xs text-ink">{win.requests}</div>
							<div className="font-mono text-2xs text-ink-3">{win.errors}</div>
							<div className="font-mono text-2xs text-ink-3">{win.tokens}</div>
							{win.topModels.length > 0 ? (
								<div className="mt-1 font-mono text-2xs text-ink-3">models: {win.topModels.join(", ")}</div>
							) : null}
							{win.topApiKeys.length > 0 ? (
								<div className="font-mono text-2xs text-ink-3">keys: {win.topApiKeys.join(", ")}</div>
							) : null}
						</div>
					))}
				</div>
			</PanelSection>
			<PanelSection title="Provider usage">
				{loading ? <div className="font-mono text-2xs text-ink-3">Loading usage…</div> : null}
				{vm.providerError ? <div className="text-xs text-danger">{vm.providerError}</div> : null}
				{!loading && !vm.providerError && vm.providerSections.length === 0 ? (
					<div className="font-mono text-2xs text-ink-3">No provider usage reported.</div>
				) : null}
				<div className="space-y-3">
					{vm.providerSections.map((section) => (
						<div key={section.title} className="rounded-md border border-line bg-paper-2/60 p-2">
							<div className="mb-1 font-mono text-xs font-semibold text-ink">{section.title}</div>
							{section.notes.map((note) => (
								<div key={note} className="mb-1 text-2xs text-ink-3">{note}</div>
							))}
							<div className="space-y-2">
								{section.limits.map((limit) => (
									<div key={`${limit.label}-${limit.window ?? ""}`}>
										<div className="flex items-center gap-2 text-xs text-ink">
											<span className="truncate">{limit.label}</span>
											{limit.status ? <span className="rounded bg-paper-3 px-1 font-mono text-2xs text-ink-3">{limit.status}</span> : null}
										</div>
										<div className="font-mono text-2xs text-ink-3">{limit.summary}{limit.window ? ` · ${limit.window}` : ""}</div>
									</div>
								))}
							</div>
						</div>
					))}
				</div>
			</PanelSection>
		</div>
	);
}

function PanelSection({ title, children }: { title: string; children: React.ReactNode }) {
	return (
		<section className="border-b border-line px-4 py-4">
			<div className="meta mb-2">{title}</div>
			<div className="space-y-1.5">{children}</div>
		</section>
	);
}

function KV({ k, v, title }: { k: string; v: string; title?: string }) {
	return (
		<div className="grid grid-cols-[56px_1fr] gap-2 font-mono text-2xs">
			<span className="text-ink-3">{k}</span>
			<span className="truncate text-ink" title={title ?? v}>{v}</span>
		</div>
	);
}

function shortId(id: string): string {
	if (id.length <= 12) return id;
	return `${id.slice(0, 6)}…${id.slice(-4)}`;
}
