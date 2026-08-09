import { Power, Zap } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { Routine } from "@omp-deck/protocol";

import type { RoutineMetrics } from "@/lib/routines-api";
import { cn } from "@/lib/utils";

interface Props {
	routine: Routine;
	index: number;
	metrics?: RoutineMetrics;
	onOpen: (r: Routine) => void;
	onToggleEnabled: (r: Routine) => void;
	onRunNow: (r: Routine) => void;
}

/** Deck-native routine list row retained for compatibility. */
export function RoutineRow({ routine, metrics, onOpen, onToggleEnabled, onRunNow }: Props) {
	const { t } = useTranslation();
	const okPct = metrics && metrics.total > 0 ? Math.round(metrics.successRate30d * 100) : undefined;
	return (
		<li>
			<button type="button" onClick={() => onOpen(routine)} className="flex w-full items-center gap-3 px-3 py-3 text-left hover:bg-paper-3/60">
				<span className={cn("h-2.5 w-2.5 shrink-0 rounded-full", routine.enabled ? "bg-success" : "bg-line-strong")} />
				<div className="min-w-0 flex-1">
					<div className="flex items-baseline gap-2">
						<span className="truncate text-sm font-medium text-ink">{routine.name}</span>
						<span className="chip bg-paper-3 text-ink-3">{routine.specVersion === 1 ? t("routines.routineRow.pipeline") : routine.actionKind}</span>
						{okPct !== undefined ? <span className="meta">{t("routines.routineRow.percentOk", { pct: okPct })}</span> : null}
					</div>
					<div className="mt-1 flex flex-wrap gap-2 font-mono text-2xs text-ink-3">
						{routine.cron ? <span>{routine.cron}</span> : <span>{t("routines.routineRow.manual")}</span>}
						{routine.nextRunAt ? <span>{t("routines.routineRow.nextRun", { date: new Date(routine.nextRunAt).toLocaleString() })}</span> : null}
					</div>
				</div>
				<div className="flex shrink-0 items-center gap-1" onClick={(e) => e.stopPropagation()} role="group">
					<button type="button" onClick={() => onRunNow(routine)} className="btn-ghost h-7 px-2 text-2xs">
						<Zap className="h-3.5 w-3.5" />
						{t("routines.routineRow.run")}
					</button>
					<button type="button" onClick={() => onToggleEnabled(routine)} className={cn("btn-ghost h-7 px-2 text-2xs", routine.enabled && "text-success")}>
						<Power className="h-3.5 w-3.5" />
						{routine.enabled ? t("routines.routineRow.on") : t("routines.routineRow.off")}
					</button>
				</div>
			</button>
		</li>
	);
}

export function useRoutineMetrics(): Record<string, RoutineMetrics> {
	return {};
}
