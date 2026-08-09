import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import type { ContextEvidenceStats } from "@omp-deck/protocol";

import { api } from "@/lib/api";
import { formatTokens } from "@/lib/utils";

/**
 * Global context-replacement savings summary.
 *
 * Quantifies how many tokens the topology context replacement saved across
 * ALL sessions (persisted in context_replacement_events), broken down by
 * mechanism and by session. Mounted once in TopologyView; refetches when the
 * window regains focus so a long-lived tab stays current.
 */
export function ContextSavingsCard() {
	const { t } = useTranslation();
	const [stats, setStats] = useState<ContextEvidenceStats | null>(null);

	useEffect(() => {
		let cancelled = false;
		const load = () => {
			api
				.getContextEvidenceStats()
				.then((s) => {
					if (!cancelled) setStats(s);
				})
				.catch(() => {
					if (!cancelled) setStats(null);
				});
		};
		load();
		const onFocus = () => load();
		window.addEventListener("focus", onFocus);
		return () => {
			cancelled = true;
			window.removeEventListener("focus", onFocus);
		};
	}, []);

	if (!stats || stats.total === 0) return null;

	const mechanismLabel = (m: string): string =>
		m === "auto_compact"
			? t("settings.contextSavings.autoCompact")
			: m === "context_hook"
				? t("settings.contextSavings.contextHook")
				: m;

	return (
		<div className="rounded-md border border-line bg-paper-2 p-3">
			<div className="font-mono text-2xs uppercase tracking-meta text-ink-3">
				{t("settings.contextSavings.title")}
			</div>
			<div className="mt-1 flex items-baseline gap-2">
				<span className="text-2xl font-semibold text-accent">
					{formatTokens(stats.totalSaved)}
				</span>
				<span className="text-2xs text-ink-3">
					{t("settings.contextSavings.savedAcross", { completed: stats.completed, total: stats.total })}
				</span>
			</div>

			{stats.byMechanism.length > 0 ? (
				<div className="mt-2 space-y-1">
					{stats.byMechanism.map((m) => (
						<div
							key={m.mechanism}
							className="flex items-center justify-between font-mono text-2xs"
						>
							<span className="text-ink-2">{mechanismLabel(m.mechanism)}</span>
							<span className="text-ink">
								{formatTokens(m.savedTokens)} · {m.count}×
							</span>
						</div>
					))}
				</div>
			) : null}

			{stats.bySession.length > 0 ? (
				<div className="mt-3 border-t border-line/60 pt-2">
					<div className="font-mono text-2xs uppercase tracking-meta text-ink-4">
						{t("settings.contextSavings.bySession")}
					</div>
					<div className="mt-1 space-y-1">
						{stats.bySession.slice(0, 5).map((s) => (
							<div
								key={s.sessionId}
								className="flex items-center justify-between gap-2 font-mono text-2xs"
							>
								<span className="truncate text-ink-3" title={s.sessionId}>
									{s.sessionId.slice(0, 12)}
								</span>
								<span className="shrink-0 text-ink">
									{formatTokens(s.savedTokens)} · {s.count}×
								</span>
							</div>
						))}
					</div>
				</div>
			) : null}
		</div>
	);
}
