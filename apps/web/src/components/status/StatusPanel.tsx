import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
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
	providerUsageRequest ??= api
		.getProviderUsage()
		.then((res) => {
			providerUsageCache = res;
			return res;
		})
		.catch((err) => {
			// Propagate the failure to the caller; the slot is cleared in
			// finally so a later mount re-fetches instead of reusing a
			// permanently rejected promise.
			throw err;
		})
		.finally(() => {
			providerUsageRequest = undefined;
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
			return {
				available: false,
				generatedAt: Date.now(),
				error: message,
			};
		})
		.finally(() => {
			cpaUsageRequest = undefined;
		});
	return cpaUsageRequest;
}

function formatPercent(value: number): string {
	return `${(value * 100).toFixed(1)}%`;
}

function formatContext(session: SessionUi, t?: TFunction): string {
	const usage = session.contextUsage;
	if (!usage) return t ? t("core.statusPanel.contextUnavailable") : "unavailable";
	if (typeof usage.tokens === "number" && typeof usage.percent === "number") {
		return `${formatTokens(usage.tokens)} / ${formatTokens(usage.contextWindow)} · ${usage.percent.toFixed(1)}%`;
	}
	return t
		? t("core.statusPanel.refreshPending", { window: formatTokens(usage.contextWindow) })
		: `${formatTokens(usage.contextWindow)} window · refresh pending`;
}

function formatLimitSummary(limit: ProviderUsageLimitWire, t?: TFunction): string {
	if (typeof limit.usedFraction === "number") {
		const parts = [
			t
				? t("core.statusPanel.percentUsed", { percent: formatPercent(limit.usedFraction) })
				: `${formatPercent(limit.usedFraction)} used`,
		];
		if (typeof limit.remainingFraction === "number")
			parts.push(
				t
					? t("core.statusPanel.percentLeft", { percent: formatPercent(limit.remainingFraction) })
					: `${formatPercent(limit.remainingFraction)} left`,
			);
		return parts.join(" · ");
	}
	if (typeof limit.used === "number" && typeof limit.limit === "number") {
		const unit = limit.unit ?? (t ? t("core.statusPanel.units") : "units");
		const parts = [
			t
				? t("core.statusPanel.limitFraction", { used: limit.used.toFixed(2), limit: limit.limit.toFixed(2), unit })
				: `${limit.used.toFixed(2)} / ${limit.limit.toFixed(2)} ${unit}`,
		];
		if (typeof limit.remaining === "number")
			parts.push(
				t
					? t("core.statusPanel.unitsLeft", { remaining: limit.remaining.toFixed(2) })
					: `${limit.remaining.toFixed(2)} left`,
			);
		return parts.join(" · ");
	}
	return t ? t("core.statusPanel.usageUnavailable") : "usage unavailable";
}

function topAggregateLabels(aggregates: CpaUsageAggregate[], label: (a: CpaUsageAggregate) => string): string[] {
	return [...aggregates]
		.sort((a, b) => b.n - a.n)
		.slice(0, 3)
		.map((a) => `${label(a)} · ${a.n.toLocaleString()}`);
}

function buildCpaWindows(cpaUsage: CpaUsageResponse, t?: TFunction): CpaWindowViewModel[] {
	const windows = cpaUsage.windows;
	if (!windows) return [];
	const out: CpaWindowViewModel[] = [];
	for (const [label, key] of CPA_WINDOW_ORDER) {
		const win: CpaUsageWindow | undefined = windows[key];
		if (!win) continue;
		const tt = win.totals;
		out.push({
			label,
			requests: t
				? t("core.statusPanel.requests", { n: tt.requests.toLocaleString() })
				: `${tt.requests.toLocaleString()} requests`,
			errors: t
				? t("core.statusPanel.errors", { n: tt.errors.toLocaleString(), percent: formatPercent(tt.error_rate) })
				: `${tt.errors.toLocaleString()} errors · ${formatPercent(tt.error_rate)}`,
			tokens: t
				? t("core.statusPanel.tokens", { n: formatTokens(tt.total_tokens) })
				: `${formatTokens(tt.total_tokens)} tokens`,
			topModels: topAggregateLabels(win.per_model, (a) => a.model ?? (t ? t("core.statusPanel.unknown") : "unknown")),
			topApiKeys: topAggregateLabels(win.per_api_key, (a) => a.key_id ?? a.account ?? (t ? t("core.statusPanel.keyLabel") : "key")),
		});
	}
	return out;
}

const CPA_DESCRIPTION_EN = "CLIProxyAPI request usage, not remaining quota.";
const CPA_LOADING_EN = "Loading CPA usage…";
const CPA_UNAVAILABLE_EN = "CPA usage unavailable.";

function buildCpaUsageViewModel(cpaUsage: CpaUsageResponse | undefined, t?: TFunction): CpaUsageViewModel {
	if (!cpaUsage) {
		return {
			description: t ? t("core.statusPanel.cpaDescription") : CPA_DESCRIPTION_EN,
			loadingLabel: t ? t("core.statusPanel.cpaLoading") : CPA_LOADING_EN,
			windows: [],
		};
	}
	if (!cpaUsage.available) {
		return {
			description: t ? t("core.statusPanel.cpaDescription") : CPA_DESCRIPTION_EN,
			error: cpaUsage.error ?? (t ? t("core.statusPanel.cpaUnavailable") : CPA_UNAVAILABLE_EN),
			windows: [],
		};
	}
	return {
		description: t ? t("core.statusPanel.cpaDescription") : CPA_DESCRIPTION_EN,
		error: cpaUsage.error,
		windows: buildCpaWindows(cpaUsage, t),
	};
}

export function buildStatusPanelViewModel(
	session: SessionUi,
	providerUsage: ProviderUsageResponse | undefined,
	cpaUsage: CpaUsageResponse | undefined,
	t?: TFunction,
): StatusPanelViewModel {
	const providerSections = (providerUsage?.reports ?? []).map((report) => ({
		title: report.provider,
		notes: report.notes ?? [],
		limits: report.limits.map((limit) => ({
			label: limit.label,
			summary: formatLimitSummary(limit, t),
			status: limit.status,
			window: limit.windowLabel,
		})),
	}));
	return {
		sessionRows: [
			{ label: "id", value: shortId(session.sessionId), title: session.sessionId },
			...(session.sessionName ? [{ label: t ? t("core.statusPanel.name") : "name", value: session.sessionName }] : []),
			{ label: t ? t("core.statusPanel.cwd") : "cwd", value: shortPath(session.cwd, 34), title: session.cwd },
			...(session.model ? [{ label: t ? t("core.statusPanel.model") : "model", value: `${session.model.provider}/${session.model.id}` }] : []),
			{ label: t ? t("core.statusPanel.state") : "state", value: session.status },
		],
		contextLine: formatContext(session, t),
		chatLine: t
			? t("core.statusPanel.chatLine", { tokens: formatTokens(session.usage.totalTokens), turns: session.turnCount })
			: `${formatTokens(session.usage.totalTokens)} tokens · ${session.turnCount} turns`,
		costLine: t
			? t("core.statusPanel.costLine", {
					cost: formatCost(session.usage.cost),
					input: formatTokens(session.usage.input),
					output: formatTokens(session.usage.output),
				})
			: `${formatCost(session.usage.cost)} · in ${formatTokens(session.usage.input)} / out ${formatTokens(session.usage.output)}`,
		providerSections,
		providerError: providerUsage?.error,
		cpaUsage: buildCpaUsageViewModel(cpaUsage, t),
	};
}

export function StatusPanel() {
	const { t } = useTranslation();
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
		() => (session ? buildStatusPanelViewModel(session, providerUsage, cpaUsage, t) : undefined),
		[session, providerUsage, cpaUsage, t],
	);
	if (!session || !vm) {
		return <div className="px-4 py-6 font-mono text-2xs uppercase tracking-meta text-ink-3">{t("core.statusPanel.noSession")}</div>;
	}
	return (
		<div className="flex flex-col">
			<PanelSection title={t("core.statusPanel.status")}>
				{vm.sessionRows.map((row) => (
					<KV key={row.label} k={row.label} v={row.value} title={row.title} />
				))}
			</PanelSection>
			<PanelSection title={t("core.statusPanel.context")}>
				<div className="font-mono text-sm text-ink">{vm.contextLine}</div>
			</PanelSection>
			<PanelSection title={t("core.statusPanel.chatUsage")}>
				<div className="font-mono text-sm text-ink">{vm.chatLine}</div>
				<div className="mt-1 font-mono text-2xs text-ink-3">{vm.costLine}</div>
			</PanelSection>
			<PanelSection title={t("core.statusPanel.cpaUsage")}>
				<div className="font-mono text-2xs text-ink-3">{vm.cpaUsage.description}</div>
				{cpaLoading ? <div className="font-mono text-2xs text-ink-3">{vm.cpaUsage.loadingLabel}</div> : null}
				{vm.cpaUsage.error ? <div className="text-xs text-danger">{vm.cpaUsage.error}</div> : null}
				{!cpaLoading && !vm.cpaUsage.error && vm.cpaUsage.windows.length === 0 ? (
					<div className="font-mono text-2xs text-ink-3">{t("core.statusPanel.noCpaWindows")}</div>
				) : null}
				<div className="space-y-2">
					{vm.cpaUsage.windows.map((win) => (
						<div key={win.label} className="rounded-md border border-line bg-paper-2/60 p-2">
							<div className="mb-1 font-mono text-xs font-semibold text-ink">{win.label}</div>
							<div className="font-mono text-2xs text-ink">{win.requests}</div>
							<div className="font-mono text-2xs text-ink-3">{win.errors}</div>
							<div className="font-mono text-2xs text-ink-3">{win.tokens}</div>
							{win.topModels.length > 0 ? (
								<div className="mt-1 font-mono text-2xs text-ink-3">{t("core.statusPanel.topModels", { models: win.topModels.join(", ") })}</div>
							) : null}
							{win.topApiKeys.length > 0 ? (
								<div className="font-mono text-2xs text-ink-3">{t("core.statusPanel.topApiKeys", { keys: win.topApiKeys.join(", ") })}</div>
							) : null}
						</div>
					))}
				</div>
			</PanelSection>
			<PanelSection title={t("core.statusPanel.providerUsage")}>
				{loading ? <div className="font-mono text-2xs text-ink-3">{t("core.statusPanel.loadingUsage")}</div> : null}
				{vm.providerError ? <div className="text-xs text-danger">{vm.providerError}</div> : null}
				{!loading && !vm.providerError && vm.providerSections.length === 0 ? (
					<div className="font-mono text-2xs text-ink-3">{t("core.statusPanel.noProviderUsage")}</div>
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
