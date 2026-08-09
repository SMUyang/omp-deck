import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Power, RefreshCcw, Trash2, Zap } from "lucide-react";
import { Link } from "react-router-dom";
import type { Routine, RoutineRun } from "@omp-deck/protocol";

import { routinesApi, type RoutineMetrics } from "@/lib/routines-api";

interface Props {
	routine: Routine | undefined;
	onChange: (updated: Routine) => void;
	onDeleted: (id: string) => void;
	onError: (msg: string) => void;
}

export function EditorInspector({ routine, onChange, onDeleted, onError }: Props) {
	const { t } = useTranslation();
	const [runs, setRuns] = useState<RoutineRun[]>([]);
	const [metrics, setMetrics] = useState<RoutineMetrics | undefined>();
	const [busy, setBusy] = useState<string | undefined>();

	useEffect(() => {
		if (!routine) {
			setRuns([]);
			setMetrics(undefined);
			return;
		}
		const routineId = routine.id;
		let cancelled = false;
		async function load(): Promise<void> {
			try {
				const [runRes, metricsRes] = await Promise.all([
					routinesApi.runs(routineId, 10),
					routinesApi.metrics(routineId),
				]);
				if (cancelled) return;
				setRuns(runRes.runs);
				setMetrics(metricsRes);
			} catch (e) {
				if (!cancelled) onError(String(e));
			}
		}
		void load();
		return () => {
			cancelled = true;
		};
	}, [routine, onError]);

	async function refresh(): Promise<void> {
		if (!routine) return;
		setBusy("refresh");
		try {
			const [runRes, metricsRes] = await Promise.all([
				routinesApi.runs(routine.id, 10),
				routinesApi.metrics(routine.id),
			]);
			setRuns(runRes.runs);
			setMetrics(metricsRes);
		} catch (e) {
			onError(String(e));
		} finally {
			setBusy(undefined);
		}
	}

	async function runNow(): Promise<void> {
		if (!routine) return;
		setBusy("run");
		try {
			await routinesApi.runNow(routine.id);
			await new Promise((r) => setTimeout(r, 800));
			await refresh();
		} catch (e) {
			onError(String(e));
		} finally {
			setBusy(undefined);
		}
	}

	async function toggle(): Promise<void> {
		if (!routine) return;
		setBusy("toggle");
		try {
			const updated = await routinesApi.update(routine.id, { enabled: !routine.enabled });
			onChange(updated);
		} catch (e) {
			onError(String(e));
		} finally {
			setBusy(undefined);
		}
	}

	async function remove(): Promise<void> {
		if (!routine) return;
		if (!confirm(t("routines.editorInspector.confirmDelete", { name: routine.name }))) return;
		setBusy("delete");
		try {
			await routinesApi.remove(routine.id);
			onDeleted(routine.id);
		} catch (e) {
			onError(String(e));
		} finally {
			setBusy(undefined);
		}
	}

	if (!routine) {
		return (
			<div className="p-3">
				<div className="meta mb-2">{t("routines.editorInspector.inspector")}</div>
				<p className="text-xs leading-relaxed text-ink-3">
					{t("routines.editorInspector.emptyHint")}
				</p>
			</div>
		);
	}

	return (
		<div className="flex h-full flex-col overflow-y-auto">
			<section className="border-b border-line p-3">
				<div className="meta mb-2">{t("routines.editorInspector.status")}</div>
				<div className="flex items-center justify-between text-sm">
					<span className="text-ink-2">{t("routines.editorInspector.enabled")}</span>
					<span className="font-mono text-2xs text-ink-3">{routine.enabled ? t("routines.editorInspector.yes") : t("routines.editorInspector.no")}</span>
				</div>
				{routine.nextRunAt ? (
					<div className="mt-1 flex items-center justify-between text-sm">
						<span className="text-ink-2">{t("routines.editorInspector.next")}</span>
						<span className="font-mono text-2xs text-ink-3">{new Date(routine.nextRunAt).toLocaleString()}</span>
					</div>
				) : null}
				{metrics ? (
					<div className="mt-1 flex items-center justify-between text-sm">
						<span className="text-ink-2">{t("routines.editorInspector.successRate")}</span>
						<span className="font-mono text-2xs text-ink-3">{Math.round(metrics.successRate30d * 100)}%</span>
					</div>
				) : null}
			</section>

			<section className="border-b border-line p-3">
				<div className="mb-2 flex items-center justify-between">
					<div className="meta">{t("routines.editorInspector.recentRuns")}</div>
					<button type="button" onClick={() => void refresh()} disabled={busy === "refresh"} className="btn-ghost h-6 w-6 p-0" aria-label={t("routines.editorInspector.refreshRuns")}>
						<RefreshCcw className="h-3 w-3" />
					</button>
				</div>
				<ul className="space-y-1">
					{runs.length === 0 ? (
						<li className="font-mono text-2xs text-ink-3">{t("routines.editorInspector.noRuns")}</li>
					) : (
						runs.map((run) => <RunMini key={run.id} routineId={routine.id} run={run} />)
					)}
				</ul>
			</section>

			<section className="border-b border-line p-3">
				<div className="meta mb-2">{t("routines.editorInspector.actions")}</div>
				<div className="space-y-1.5">
					<button type="button" onClick={() => void runNow()} disabled={busy === "run"} className="btn-ghost h-7 w-full justify-start text-xs">
						<Zap className="h-3.5 w-3.5" />
						{t("routines.editorInspector.runNow")}
					</button>
					<button type="button" onClick={() => void toggle()} disabled={busy === "toggle"} className="btn-ghost h-7 w-full justify-start text-xs">
						<Power className="h-3.5 w-3.5" />
						{routine.enabled ? t("routines.editorInspector.disable") : t("routines.editorInspector.enable")}
					</button>
					<button type="button" onClick={() => void remove()} disabled={busy === "delete"} className="btn-ghost h-7 w-full justify-start text-xs text-danger">
						<Trash2 className="h-3.5 w-3.5" />
						{t("routines.editorInspector.delete")}
					</button>
				</div>
			</section>

			<section className="p-3">
				<div className="meta mb-2">{t("routines.editorInspector.reference")}</div>
				<div className="space-y-1 font-mono text-2xs text-ink-3">
					<div>{t("routines.editorInspector.stepsReference")} run / agent / http / write / transform / wait / set_state / mcp</div>
					<div>{t("routines.editorInspector.templateRefs")} {"{{ run.date }}"}, {"{{ steps.id.json }}"}, {"{{ state.key }}"}</div>
				</div>
			</section>
		</div>
	);
}

function RunMini({ routineId, run }: { routineId: string; run: RoutineRun }) {
	const ok = !run.error && !run.abortReason;
	const running = !run.endedAt && !run.abortedAt;
	return (
		<li>
			<Link to={`/routines/${routineId}/runs/${run.id}`} className="flex items-center gap-2 rounded px-1 py-0.5 font-mono text-2xs hover:bg-paper-3">
				<span className={`h-1.5 w-1.5 rounded-full ${running ? "bg-accent" : ok ? "bg-success" : "bg-danger"}`} />
				<span className="text-ink-3">{new Date(run.startedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
				<span className="text-ink-4">{run.trigger}</span>
				{run.abortReason ? <span className="ml-auto text-warn">{run.abortReason}</span> : null}
			</Link>
		</li>
	);
}
