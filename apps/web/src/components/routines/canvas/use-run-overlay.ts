/**
 * T-71: run-status overlay state for the visual builder.
 *
 * This hook fans out the work needed to paint per-step run status on top of
 * the canvas:
 *  - Fetches the routine's recent runs (descending; the head is the most
 *    recent) so the user can scrub through history.
 *  - Selects a default run (the most recent) and fetches its per-step
 *    records.
 *  - Subscribes to the WS firehose so a live run paints status changes in
 *    real time without polling. The store owns the singleton `WsClient`.
 *
 * Returned state is intentionally minimal — `stepRunsByStepId` is what the
 * canvas wants for ring colors and badges, `runs` powers the last-run picker,
 * `selectedRunId` is bidirectional so the picker can swap the overlay.
 *
 * Lifecycle:
 *  - When `routineId` changes (or becomes undefined), the hook clears state
 *    and refetches.
 *  - The component using this hook is mounted inside the routine editor; the
 *    WS client survives unmount via the zustand store, so we never tear it
 *    down here.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type {
	RoutineRun,
	RoutineStepRun,
	ServerFrame,
} from "@omp-deck/protocol";

import { routinesApi } from "@/lib/routines-api";
import { useStore } from "@/lib/store";

export interface RunOverlayState {
	/** Most-recent N runs for the routine, descending by `startedAt`. */
	runs: ReadonlyArray<RoutineRun>;
	/** Currently-displayed run id. `null` when no runs exist yet. */
	selectedRunId: string | null;
	/** Switch the overlay to a different run from history. */
	setSelectedRunId(id: string | null): void;
	/** Step-id → per-step record for the selected run. Empty until the first fetch lands. */
	stepRunsByStepId: ReadonlyMap<string, RoutineStepRun>;
	/** True while the runs list or step list is being (re)fetched. */
	refreshing: boolean;
	/** Manual refetch for the runs list + the current run's steps. */
	refresh(): Promise<void>;
}

const RUNS_LIMIT = 30;

export function useRunOverlay(routineId: string | undefined): RunOverlayState {
	const [runs, setRuns] = useState<RoutineRun[]>([]);
	const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
	const [stepRuns, setStepRuns] = useState<RoutineStepRun[]>([]);
	const [refreshing, setRefreshing] = useState(false);
	const ws = useStore((s) => s.ws);

	// Keep refs of the latest values so the WS subscription handler can read
	// them without re-binding (which would tear the subscription down on every
	// state update and miss frames mid-tick).
	const selectedRunIdRef = useRef<string | null>(null);
	useEffect(() => {
		selectedRunIdRef.current = selectedRunId;
	}, [selectedRunId]);
	const ownedRunIdsRef = useRef<Set<string>>(new Set());
	useEffect(() => {
		ownedRunIdsRef.current = new Set(runs.map((r) => r.id));
	}, [runs]);

	const fetchRunsList = useCallback(async () => {
		if (!routineId) return;
		setRefreshing(true);
		try {
			const { runs: list } = await routinesApi.runs(routineId, RUNS_LIMIT);
			setRuns(list);
			setSelectedRunId((cur) => cur ?? list[0]?.id ?? null);
		} catch {
			// Swallow — overlay is best-effort. The editor itself stays usable
			// without it.
		} finally {
			setRefreshing(false);
		}
	}, [routineId]);

	// (Re)initialize on routine change.
	useEffect(() => {
		setRuns([]);
		setSelectedRunId(null);
		setStepRuns([]);
		if (!routineId) return;
		void fetchRunsList();
	}, [routineId, fetchRunsList]);

	// Fetch step records for the selected run.
	useEffect(() => {
		if (!routineId || !selectedRunId) {
			setStepRuns([]);
			return;
		}
		let cancelled = false;
		setRefreshing(true);
		void routinesApi
			.steps(routineId, selectedRunId)
			.then((res) => {
				if (!cancelled) setStepRuns(res.steps);
			})
			.catch(() => {
				// Run records may not exist yet for a just-started run.
			})
			.finally(() => {
				if (!cancelled) setRefreshing(false);
			});
		return () => {
			cancelled = true;
		};
	}, [routineId, selectedRunId]);

	// WS subscription for live run events scoped to this routine.
	useEffect(() => {
		if (!ws || !routineId) return;
		return ws.subscribe((frame: ServerFrame) => {
			switch (frame.type) {
				case "routine_run_started": {
					if (frame.routineId !== routineId) return;
					// Switch the overlay to the brand-new run and refetch the
					// list so the picker reflects history.
					setSelectedRunId(frame.runId);
					ownedRunIdsRef.current.add(frame.runId);
					void fetchRunsList();
					return;
				}
				case "routine_step_event": {
					if (frame.runId !== selectedRunIdRef.current) return;
					setStepRuns((prev) => mergeStepEvent(prev, frame));
					return;
				}
				case "routine_run_finished": {
					if (!ownedRunIdsRef.current.has(frame.runId)) return;
					if (frame.runId === selectedRunIdRef.current) {
						// Final refetch so terminal fields land cleanly.
						void routinesApi
							.steps(routineId, frame.runId)
							.then((res) => setStepRuns(res.steps))
							.catch(() => {});
					}
					void fetchRunsList();
					return;
				}
				default:
					return;
			}
		});
	}, [ws, routineId, fetchRunsList]);

	const stepRunsByStepId = useMemo(() => {
		const m = new Map<string, RoutineStepRun>();
		for (const s of stepRuns) m.set(s.stepId, s);
		return m;
	}, [stepRuns]);

	const refresh = useCallback(async () => {
		await fetchRunsList();
		if (routineId && selectedRunIdRef.current) {
			try {
				const res = await routinesApi.steps(routineId, selectedRunIdRef.current);
				setStepRuns(res.steps);
			} catch {
				// no-op
			}
		}
	}, [fetchRunsList, routineId]);

	return {
		runs,
		selectedRunId,
		setSelectedRunId,
		stepRunsByStepId,
		refreshing,
		refresh,
	};
}

/**
 * Merge a `routine_step_event` frame into the step-run list for the selected
 * run. The frame carries a strict subset of the full `RoutineStepRun` shape,
 * so we splice it onto the existing record when present, or synthesize a
 * partial new record when the step is first seen. Required fields the frame
 * doesn't carry (`id`, `stepType`, `attempt`) get reasonable defaults that
 * the next REST fetch will overwrite.
 */
export function mergeStepEvent(
	prev: ReadonlyArray<RoutineStepRun>,
	frame: Extract<ServerFrame, { type: "routine_step_event" }>,
): RoutineStepRun[] {
	const existing = prev.find((s) => s.stepId === frame.stepId);
	const merged: RoutineStepRun = {
		id: existing?.id ?? `pending-${frame.runId}-${frame.stepId}`,
		runId: frame.runId,
		stepId: frame.stepId,
		stepIndex: frame.stepIndex,
		stepType: existing?.stepType ?? "run",
		startedAt:
			frame.startedAt ?? existing?.startedAt ?? new Date().toISOString(),
		endedAt: frame.endedAt ?? existing?.endedAt,
		status: frame.status,
		stdoutExcerpt: frame.excerpt?.stdout ?? existing?.stdoutExcerpt ?? "",
		stderrExcerpt: frame.excerpt?.stderr ?? existing?.stderrExcerpt ?? "",
		outputJson:
			frame.outputJson != null
				? safeJsonStringify(frame.outputJson)
				: existing?.outputJson,
		error: frame.error ?? existing?.error,
		model: frame.model ?? existing?.model,
		llmTokensIn: frame.tokens?.in ?? existing?.llmTokensIn,
		llmTokensOut: frame.tokens?.out ?? existing?.llmTokensOut,
		llmCostMicros: existing?.llmCostMicros,
		durationMs: frame.durationMs ?? existing?.durationMs,
		attempt: existing?.attempt ?? 1,
	};
	if (existing) {
		return prev.map((s) => (s.stepId === frame.stepId ? merged : s));
	}
	return [...prev, merged];
}

function safeJsonStringify(value: unknown): string {
	try {
		return JSON.stringify(value);
	} catch {
		return "";
	}
}
