import { Plus } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { Routine } from "@omp-deck/protocol";

interface Props {
	routines: Routine[];
	onNew: () => void;
	onFireClick?: (routineId: string) => void;
}

/** Deck-native summary header retained for compatibility; RoutinesView now renders its own header inline. */
export function RoutinesMasthead({ routines, onNew }: Props) {
	const { t } = useTranslation();
	const enabled = routines.filter((r) => r.enabled).length;
	const pipelines = routines.filter((r) => r.specVersion === 1).length;
	return (
		<header className="flex h-12 shrink-0 items-center gap-3 border-b border-line px-3">
			<div>
				<div className="meta">{t("routines.routinesMasthead.title")}</div>
				<div className="font-mono text-2xs text-ink-3">
					{t("routines.routinesMasthead.summary", {
						total: routines.length,
						enabled,
						pipelines,
					})}
				</div>
			</div>
			<button type="button" onClick={onNew} className="btn-primary ml-auto h-7 px-2 text-xs">
				<Plus className="h-3.5 w-3.5" />
				{t("routines.routinesMasthead.newRoutine")}
			</button>
		</header>
	);
}
