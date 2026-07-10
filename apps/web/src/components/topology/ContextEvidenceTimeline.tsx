import { useState } from "react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type {
	ContextReplacementEvent,
	ContextReplacementStatus,
	ContextReplacementMechanism,
} from "@omp-deck/protocol";
import {
	ChevronDown,
	ChevronRight,
	AlertTriangle,
	CheckCircle,
	Clock,
	Loader,
	XCircle,
	Zap,
	ArrowRightLeft,
	Wrench,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { formatTokens } from "@/lib/utils";

// ── Props ────────────────────────────────────────────────────────────────────

export interface ContextEvidenceTimelineProps {
	events: ContextReplacementEvent[];
	loading: boolean;
	error?: string;
	sessionId?: string;
	className?: string;
}

// ── Status lifecycle order (display order, bottom = newest) ──────────────────

export const STATUS_ORDER: ContextReplacementStatus[] = [
	"constructed",
	"handler_returned",
	"compact_requested",
	"compact_completed",
	"usage_drop_observed",
	"provider_payload_observed",
	"failed",
	"timed_out",
];

// ── Pure helpers (exported for tests) ────────────────────────────────────────
export function getStatusLabel(status: ContextReplacementStatus, t: (k: string) => string): string {
	const key = `topologyWorkspace.evidence.status.${status}`;
	return t(key);
}

export function getStatusColor(status: ContextReplacementStatus): { bg: string; text: string } {
	switch (status) {
		case "provider_payload_observed":
			return { bg: "bg-success/10 border-success/30", text: "text-success" };
		case "failed":
		case "timed_out":
			return { bg: "bg-danger/10 border-danger/30", text: "text-danger" };
		case "compact_completed":
			return { bg: "bg-accent/10 border-accent/30", text: "text-accent" };
		case "usage_drop_observed":
			return { bg: "bg-thinking/10 border-thinking/30", text: "text-thinking" };
		case "compact_requested":
			return { bg: "bg-thinking/10 border-thinking/30", text: "text-thinking" };
		default:
			return { bg: "bg-ink-3/10 border-ink-3/30", text: "text-ink-3" };
	}
}

export function getMechanismLabel(mechanism: ContextReplacementMechanism, t: (k: string) => string): string {
	return t(`topologyWorkspace.evidence.mechanism.${mechanism}`);
}

export interface TokenDelta {
	saved: string | null;
	percent: string | null;
	isNull: boolean;
}

export function formatTokenDelta(event: ContextReplacementEvent): TokenDelta {
	const nullResult: TokenDelta = { saved: null, percent: null, isNull: true };
	if (event.beforeTokens === null || event.afterTokens === null) return nullResult;
	const saved = event.savedTokens ?? Math.max(0, event.beforeTokens - event.afterTokens);
	const pct = event.savedPercent ?? (event.beforeTokens > 0
		? Math.round((saved / event.beforeTokens) * 10_000) / 100
		: 0);
	return {
		saved: formatTokens(saved),
		percent: `${pct}%`,
		isNull: false,
	};
}

export function isProviderConfirmed(event: ContextReplacementEvent): boolean {
	return event.status === "provider_payload_observed";
}

// ── Sub-components ───────────────────────────────────────────────────────────

function StatusBadge({ status, t }: { status: ContextReplacementStatus; t: (k: string) => string }) {
	const color = getStatusColor(status);
	const label = getStatusLabel(status, t);
	const icon = getStatusIcon(status);

	return (
		<span
			className={cn(
				"inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-2xs font-medium",
				color.bg,
				color.text,
			)}
		>
			{icon}
			{label}
		</span>
	);
}

function getStatusIcon(status: ContextReplacementStatus): ReactNode {
	switch (status) {
		case "provider_payload_observed":
			return <CheckCircle className="h-3 w-3" />;
		case "failed":
			return <XCircle className="h-3 w-3" />;
		case "timed_out":
			return <Clock className="h-3 w-3" />;
		case "compact_requested":
		case "compact_completed":
			return <ArrowRightLeft className="h-3 w-3" />;
		case "usage_drop_observed":
			return <Zap className="h-3 w-3" />;
		case "handler_returned":
			return <Wrench className="h-3 w-3" />;
		default:
			return null;
	}
}

function MechanismBadge({ mechanism, t }: { mechanism: ContextReplacementMechanism; t: (k: string) => string }) {
	return (
		<span className="inline-flex items-center gap-1 rounded border border-line/60 bg-paper-2 px-1.5 py-0.5 text-2xs text-ink-3">
			{getMechanismLabel(mechanism, t)}
		</span>
	);
}

function TokenDisplay({ event, t }: { event: ContextReplacementEvent; t: (k: string, opts?: Record<string, unknown>) => string }) {
	const delta = formatTokenDelta(event);

	return (
		<div className="space-y-0.5">
			<div className="flex items-center gap-2 text-xs">
				<span className="text-ink-3">
					{event.beforeTokens !== null ? formatTokens(event.beforeTokens) : "—"}
				</span>
				<span className="text-ink-4">→</span>
				<span className="text-ink-3">
					{event.afterTokens !== null ? formatTokens(event.afterTokens) : "—"}
				</span>
				{event.beforePercent !== null && (
					<span className="text-2xs text-ink-4">
						({event.beforePercent}% → {event.afterPercent ?? "—"}%)
					</span>
				)}
			</div>
			{delta.isNull ? (
				<span className="text-2xs italic text-ink-4">{t("topologyWorkspace.evidence.unreported")}</span>
			) : (
				<span
					className={cn(
						"text-xs font-medium",
						(delta.saved === "0" || delta.saved === "0") ? "text-ink-3" : "text-success",
					)}
				>
					{t("topologyWorkspace.evidence.savedTokens", { count: delta.saved })} ({delta.percent})
				</span>
			)}
		</div>
	);
}

function FocusEstimate({ event, t }: { event: ContextReplacementEvent; t: (k: string, opts?: Record<string, unknown>) => string }) {
	return (
		<div className="flex items-center gap-1.5 text-2xs text-ink-4">
			<span className="rounded bg-paper-2 px-1 py-0.5 font-mono">
				{t("topologyWorkspace.evidence.focusEstimatedTokens", { count: formatTokens(event.focusEstimatedTokens) })}
			</span>
			<span className="text-ink-4/60">({event.focusEstimateMethod})</span>
		</div>
	);
}

function FocusPreview({ event, t }: { event: ContextReplacementEvent; t: (k: string) => string }) {
	const [expanded, setExpanded] = useState(false);

	return (
		<div className="space-y-1">
			<button
				type="button"
				onClick={() => setExpanded(!expanded)}
				className="flex items-center gap-1 text-2xs text-ink-3 hover:text-ink-2 transition-colors"
			>
				{expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
				{t("topologyWorkspace.evidence.focusContext")}
			</button>
			{expanded && (
				<pre className="max-h-32 overflow-y-auto rounded border border-line/60 bg-paper-2 p-2 text-2xs font-mono text-ink-2 whitespace-pre-wrap break-all">
					{event.focusPreview}
				</pre>
			)}
		</div>
	);
}

function ErrorDetail({ event }: { event: ContextReplacementEvent }) {
	if (!event.errorMessage) return null;
	return (
		<div className="flex items-start gap-1.5 rounded border border-danger/20 bg-danger/5 p-2 text-2xs text-danger">
			<AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
			<span className="break-all">{event.errorMessage}</span>
		</div>
	);
}

function formatTime(iso: string): string {
	try {
		const d = new Date(iso);
		return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
	} catch {
		return iso;
	}
}

// ── Main component ───────────────────────────────────────────────────────────

export function ContextEvidenceTimeline({
	events,
	loading,
	error,
	sessionId,
	className,
}: ContextEvidenceTimelineProps) {
	const { t } = useTranslation();

	// ── No session selected ───────────────────────────────────────────────
	if (!sessionId) {
		return (
			<div className={cn("flex flex-col items-center justify-center gap-2 p-6 text-center", className)}>
				<div className="text-ink-4 text-sm">{t("topologyWorkspace.evidence.selectSession")}</div>
			</div>
		);
	}

	// ── Loading ───────────────────────────────────────────────────────────
	if (loading) {
		return (
			<div className={cn("flex flex-col gap-3 p-4", className)}>
				{Array.from({ length: 3 }).map((_, i) => (
					<div key={i} className="animate-pulse space-y-2 rounded-lg border border-line bg-paper p-3">
						<div className="h-4 w-24 rounded bg-paper-3" />
						<div className="h-3 w-48 rounded bg-paper-3" />
						<div className="h-3 w-32 rounded bg-paper-3" />
					</div>
				))}
			</div>
		);
	}

	// ── Error ─────────────────────────────────────────────────────────────
	if (error) {
		return (
			<div className={cn("flex flex-col items-center gap-2 p-6 text-center", className)}>
				<AlertTriangle className="h-6 w-6 text-danger" />
				<div className="text-sm text-danger font-medium">{t("topologyWorkspace.evidence.failedToLoad")}</div>
				<div className="text-xs text-ink-4 break-all max-w-md">{error}</div>
			</div>
		);
	}

	// ── Empty ─────────────────────────────────────────────────────────────
	if (events.length === 0) {
		return (
			<div className={cn("flex flex-col items-center justify-center gap-2 p-6 text-center", className)}>
				<div className="text-ink-3 text-sm">{t("topologyWorkspace.evidence.empty")}</div>
				<div className="text-ink-4 text-2xs">{t("topologyWorkspace.evidence.emptyHint")}</div>
			</div>
		);
	}

	// ── Timeline ──────────────────────────────────────────────────────────
	return (
		<div className={cn("flex flex-col gap-2 p-3", className)}>
			<h3 className="text-xs font-semibold uppercase tracking-meta text-ink-3 mb-1">
				{t("topologyWorkspace.evidence.title")}
			</h3>

			<div className="relative ml-3 space-y-0 border-l-2 border-line pl-5">
				{events.map((event) => {
					const isConfirmed = isProviderConfirmed(event);

					return (
						<div
							key={event.id}
							className={cn(
								"relative rounded-lg border p-3",
								isConfirmed
									? "border-success/20 bg-success/5"
									: event.status === "failed" || event.status === "timed_out"
										? "border-danger/20 bg-danger/5"
										: "border-line bg-paper",
							)}
						>
							{/* Timeline dot */}
							<div
								className={cn(
									"absolute -left-[1.625rem] top-4 h-2.5 w-2.5 rounded-full border-2 border-paper",
									isConfirmed
										? "bg-success"
										: event.status === "failed" || event.status === "timed_out"
											? "bg-danger"
											: event.status === "compact_completed" || event.status === "usage_drop_observed"
												? "bg-accent"
												: "bg-ink-3",
								)}
							/>

							{/* Header row */}
							<div className="flex flex-wrap items-center gap-1.5 mb-2">
								<StatusBadge status={event.status} t={t} />
								<MechanismBadge mechanism={event.mechanism} t={t} />
								<span className="text-2xs text-ink-4 ml-auto">{formatTime(event.createdAt)}</span>
							</div>

							{/* Provider role (only when confirmed) */}
							{event.providerRole && (
								<div className="mb-1.5 text-2xs text-ink-3">
									{t("topologyWorkspace.evidence.providerLabel")}{" "}
									<span className="font-mono text-ink-2">{event.providerRole}</span>
								</div>
							)}

							{/* Token delta */}
							<TokenDisplay event={event} t={t} />

							{/* Focus estimate (separate, never folded into saved) */}
							<div className="mt-1.5">
								<FocusEstimate event={event} t={t} />
							</div>

							{/* Focus preview */}
							<div className="mt-1.5">
								<FocusPreview event={event} t={t} />
							</div>

							{/* Error detail */}
							{(event.status === "failed" || event.status === "timed_out") && (
								<div className="mt-2">
									<ErrorDetail event={event} />
								</div>
							)}

							{/* Retry count */}
							{event.retryCount > 0 && (
								<div className="mt-1 text-2xs text-ink-4">
									{event.retryCount === 1
										? t("topologyWorkspace.evidence.retried", { count: event.retryCount })
										: t("topologyWorkspace.evidence.retried_plural", { count: event.retryCount })}
								</div>
							)}
						</div>
					);
				})}
			</div>
		</div>
	);
}
