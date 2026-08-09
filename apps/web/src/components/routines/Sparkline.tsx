/**
 * Run-history sparkline. Renders last-N runs as a row of stacked bars whose
 * height encodes duration (relative to the row's own max) and whose color
 * encodes outcome. Used on the routine list rows and in the editor inspector.
 */
import type { RoutineMetrics } from "@/lib/routines-api";
import { useTranslation } from "react-i18next";

type Status = RoutineMetrics["last30"][number]["status"];

const TONE: Record<Status, string> = {
	success: "bg-success/85",
	failed: "bg-danger/85",
	aborted: "bg-warn/85",
	running: "bg-accent/85",
};

interface Props {
	bars: ReadonlyArray<{ status: Status; durationMs: number | null }>;
	maxBars?: number;
	className?: string;
	height?: "sm" | "md" | "lg";
	emptyHint?: string;
}

export function Sparkline({ bars, maxBars = 30, className, height = "md", emptyHint }: Props) {
	const { t } = useTranslation();
	const hint = emptyHint ?? t("routines.sparkline.noRuns");
	const slice = bars.slice(0, maxBars).reverse(); // newest on the right
	const maxDur = Math.max(1, ...slice.map((b) => b.durationMs ?? 0));
	const heightPx = height === "sm" ? 18 : height === "lg" ? 44 : 28;

	if (slice.length === 0) {
		return (
			<div
				className={`flex items-end gap-[2px] ${className ?? ""}`}
				style={{ height: heightPx }}
				aria-label={hint}
			>
				{Array.from({ length: maxBars }).map((_, i) => (
					<div key={i} className="w-[3px] flex-1 bg-line/40" style={{ height: heightPx * 0.18 }} />
				))}
			</div>
		);
	}

	return (
		<div
			className={`flex items-end gap-[2px] ${className ?? ""}`}
			style={{ height: heightPx }}
			aria-label={t("routines.sparkline.lastRuns", { count: slice.length })}
		>
			{/* Pad with empty bars so the sparkline always shows the same width */}
			{Array.from({ length: Math.max(0, maxBars - slice.length) }).map((_, i) => (
				<div key={`pad-${i}`} className="w-[3px] flex-1 bg-line/40" style={{ height: 2 }} />
			))}
			{slice.map((b, i) => {
				const ratio = b.durationMs ? Math.min(1, b.durationMs / maxDur) : 0.25;
				const h = Math.max(3, heightPx * (0.18 + ratio * 0.82));
				return (
					<div
						key={i}
						className={`w-[3px] flex-1 rounded-[1px] ${TONE[b.status]}`}
						style={{ height: h }}
						title={`${b.status} · ${b.durationMs ? Math.round(b.durationMs / 1000) + "s" : "—"}`}
					/>
				);
			})}
		</div>
	);
}
