/**
 * T-65: slide-over inspector for the selected canvas node.
 * T-77: dual placement — `mode: "inline"` makes the inspector a normal flex
 *   sibling of the canvas so React Flow reflows into the remaining width
 *   (used at viewport >= 1100px); `mode: "drawer"` keeps the original
 *   right-edge overlay with a backdrop dim for narrow viewports.
 *
 * Renders the existing `StepCommonFields` + `renderStepForm` so authors get
 * full type coverage from day one without duplicating any form code.
 *
 * Closing the panel (Esc, click X, click delete) deselects the active node;
 * that wiring lives in the canvas via the `onClose` / `onDelete` props.
 */

import { useEffect, useState } from "react";
import { ExternalLink, Trash2, X } from "lucide-react";
import { Link } from "react-router-dom";

import type { RoutineStep, RoutineStepRun, RoutineStepStatus } from "@omp-deck/protocol";

import { cn } from "@/lib/utils";

import { StepCommonFields } from "../StepCommonFields";
import { STEP_TYPE_BG, renderStepForm } from "../step-form-render";

interface StepInspectorProps {
	/** Currently-selected step, or `null` when nothing is selected. */
	step: RoutineStep | null;
	/** All step ids in the spec — used to surface "duplicate id" warnings. */
	existingIds: string[];
	/** Called when the user edits any field on the selected step. */
	onChange: (next: RoutineStep) => void;
	/** Close the inspector (deselects the node, leaves the spec untouched). */
	onClose: () => void;
	/** Remove the selected step from the spec entirely. */
	onDelete: () => void;
	/**
	 * Layout placement.
	 * - `"inline"`: rendered as a normal flex child so the React Flow canvas
	 *   gets the remaining horizontal space.
	 * - `"drawer"`: fixed overlay anchored to the right edge of the viewport;
	 *   render a backdrop sibling separately (see `RoutineCanvas`).
	 */
	mode: "inline" | "drawer";
	/**
	 * T-68: when the selected step is if-flavored (transform with branch edges
	 * leaving it), swap the full transform body editor for a simplified
	 * "Condition (boolean expression)" surface. Common fields still apply.
	 */
	isIfNode?: boolean;
	/**
	 * T-72: per-step run record for the selected run. Drives the "Last run"
	 * section at the bottom of the inspector (status, duration, output tabs).
	 * Undefined when the routine has no runs, the user has no run selected,
	 * or the selected run skipped this step.
	 */
	stepRun?: RoutineStepRun;
	/** Routine id, only used to build the "Open in Run Detail" deep link. */
	routineId?: string;
	/** Selected run id, only used to build the "Open in Run Detail" deep link. */
	selectedRunId?: string | null;
}

export function StepInspector({
	step,
	existingIds,
	onChange,
	onClose,
	onDelete,
	mode,
	isIfNode,
	stepRun,
	routineId,
	selectedRunId,
}: StepInspectorProps): JSX.Element | null {
	// Esc closes the inspector. Bound at the document level so the canvas
	// keyboard layer doesn't need to know about it.
	useEffect(() => {
		if (!step) return;
		function onKey(e: KeyboardEvent) {
			if (e.key === "Escape") onClose();
		}
		document.addEventListener("keydown", onKey);
		return () => document.removeEventListener("keydown", onKey);
	}, [step, onClose]);

	if (!step) return null;

	const idsExcludingSelf = existingIds.filter((id) => id !== step.id);
	return (
		<aside
			data-testid="step-inspector"
			data-mode={mode}
			aria-label={`${step.type} ${step.id} inspector`}
			className={
				mode === "inline"
					? "pointer-events-auto flex h-full w-[360px] flex-col border-l border-line bg-paper"
					: "pointer-events-auto fixed inset-y-0 right-0 z-30 flex w-[min(360px,90vw)] flex-col border-l border-line bg-paper shadow-[-8px_0_24px_-12px_rgba(0,0,0,0.18)]"
			}
		>
			<header className="flex items-center gap-2 border-b border-line bg-paper-2/60 px-2.5 py-1.5">
				<span
					className={`rounded px-1.5 py-0.5 font-mono text-2xs uppercase tracking-meta ${STEP_TYPE_BG[step.type]}`}
				>
					{step.type}
				</span>
				<span className="truncate font-mono text-2xs text-ink-2">
					{step.id || "(no id)"}
				</span>
				<div className="ml-auto flex items-center gap-0.5">
					<button
						type="button"
						onClick={onDelete}
						className="btn-ghost h-7 w-7 p-0 text-ink-4 hover:text-danger"
						aria-label="Delete step"
						title="Delete step"
					>
						<Trash2 className="h-3.5 w-3.5" />
					</button>
					<button
						type="button"
						onClick={onClose}
						className="btn-ghost h-7 w-7 p-0 text-ink-3 hover:text-ink"
						aria-label="Close inspector"
						title="Close (Esc)"
					>
						<X className="h-3.5 w-3.5" />
					</button>
				</div>
			</header>
			<div className="flex-1 space-y-2 overflow-y-auto p-2.5">
				<StepCommonFields
					step={step}
					onChange={onChange}
					existingIds={idsExcludingSelf}
				/>
				{isIfNode && step.type === "transform" ? (
					<BranchConditionForm step={step} onChange={onChange} />
				) : (
					renderStepForm(step, onChange)
				)}
				{stepRun ? (
					<LastRunSection
						run={stepRun}
						routineId={routineId}
						runId={selectedRunId ?? stepRun.runId}
					/>
				) : null}
			</div>
		</aside>
	);
}

/**
 * Simplified body editor for if-flavored transform steps. The full
 * `TransformStepForm` exposes the step body as a free-form JS expression;
 * here we frame it as "Condition" with a boolean-return hint, so the author
 * understands they're authoring a gate, not a general transform.
 *
 * The shape is identical to the underlying transform step — only the framing
 * changes — so toggling between if-flavored and regular transform via the
 * spec yaml editor doesn't lose data.
 */
function BranchConditionForm({
	step,
	onChange,
}: {
	step: Extract<RoutineStep, { type: "transform" }>;
	onChange: (next: RoutineStep) => void;
}): JSX.Element {
	return (
		<div className="space-y-2">
			<div className="rounded border border-line bg-paper-2/40 px-2 py-1.5 font-mono text-2xs leading-snug text-ink-3">
				Wire this node's <span className="text-success">true</span> and{" "}
				<span className="text-danger">false</span> handles to downstream
				steps. The compiler turns each branch edge into a{" "}
				<code className="text-ink-2">when:</code> gate on its target.
			</div>
			<label className="block space-y-1">
				<span className="font-mono text-2xs uppercase tracking-meta text-ink-3">
					condition (returns boolean)
				</span>
				<textarea
					value={step.body}
					onChange={(e) => onChange({ ...step, body: e.target.value })}
					rows={4}
					spellCheck={false}
					placeholder={"return steps.fetch_tasks.json.length > 0;"}
					className="field w-full resize-y px-2 py-1.5 font-mono text-2xs leading-relaxed"
				/>
			</label>
			<div className="font-mono text-2xs text-ink-3">
				Sandboxed (quickjs, 100ms cap). Same globals as a transform:{" "}
				<code>run</code>, <code>trigger</code>, <code>steps</code>,{" "}
				<code>state</code>, <code>env</code>, <code>secrets</code>.
			</div>
		</div>
	);
}

/**
 * T-72: per-step last-run section, rendered at the bottom of the inspector
 * whenever a run record is available for the selected node.
 *
 * Layout:
 *  - Status pill + duration in a single header row.
 *  - Tab strip across {stdout, stderr, json, error} — only tabs whose
 *    underlying field has content render, so a clean run shows just the
 *    relevant pane.
 *  - "Open in Run Detail" link if a routineId + runId are known. The link
 *    sets a hash fragment `#step-<id>` so RunDetailView can scroll and
 *    auto-expand the right card on arrival.
 */
function LastRunSection({
	run,
	routineId,
	runId,
}: {
	run: RoutineStepRun;
	routineId?: string;
	runId?: string | null;
}): JSX.Element {
	type Pane = "stdout" | "stderr" | "json" | "error";
	const tabs: Pane[] = [];
	if (run.stdoutExcerpt) tabs.push("stdout");
	if (run.stderrExcerpt) tabs.push("stderr");
	if (run.outputJson) tabs.push("json");
	if (run.error) tabs.push("error");
	const [tab, setTab] = useState<Pane | null>(tabs[0] ?? null);
	// Reset the selected tab when the underlying run changes — otherwise we
	// stay parked on `stdout` after the user steps through the picker.
	useEffect(() => {
		setTab(tabs[0] ?? null);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [run.id]);

	const dur = run.durationMs != null ? formatDur(run.durationMs) : "—";
	const deepLink =
		routineId && runId
			? `/routines/${encodeURIComponent(routineId)}/runs/${encodeURIComponent(runId)}#step-${encodeURIComponent(run.stepId)}`
			: null;

	return (
		<section
			className="rounded border border-line bg-paper-2/60"
			data-testid="inspector-last-run"
		>
			<header className="flex items-center gap-2 border-b border-line px-2 py-1.5">
				<span className="font-mono text-2xs uppercase tracking-meta text-ink-3">
					last run
				</span>
				<StatusPill status={run.status} />
				<span className="font-mono text-2xs text-ink-3">{dur}</span>
				{deepLink ? (
					<Link
						to={deepLink}
						className="ml-auto flex items-center gap-1 font-mono text-2xs text-ink-3 hover:text-ink"
						title="Open in Run Detail"
					>
						<ExternalLink className="h-3 w-3" />
						run detail
					</Link>
				) : null}
			</header>

			{tabs.length === 0 ? (
				<div className="px-2 py-2 font-mono text-2xs italic text-ink-4">
					No captured output for this step.
				</div>
			) : (
				<>
					<div className="flex gap-0.5 border-b border-line bg-paper px-1.5 py-1">
						{tabs.map((t) => (
							<button
								key={t}
								type="button"
								onClick={() => setTab(t)}
								className={cn(
									"rounded px-1.5 py-0.5 font-mono text-2xs uppercase tracking-meta",
									tab === t
										? "bg-paper-2 text-ink"
										: "text-ink-3 hover:text-ink",
								)}
							>
								{t}
							</button>
						))}
					</div>
					<div className="px-2 py-2">
						<PaneBody pane={tab} run={run} />
					</div>
				</>
			)}
		</section>
	);
}

function PaneBody({
	pane,
	run,
}: {
	pane: "stdout" | "stderr" | "json" | "error" | null;
	run: RoutineStepRun;
}): JSX.Element | null {
	if (!pane) return null;
	const text =
		pane === "stdout"
			? run.stdoutExcerpt
			: pane === "stderr"
				? run.stderrExcerpt
				: pane === "json"
					? prettyJson(run.outputJson ?? "")
					: (run.error ?? "");
	const tone = pane === "stderr" || pane === "error" ? "text-warn" : "text-ink-2";
	return (
		<pre
			className={cn(
				"paper-code max-h-[260px] overflow-auto whitespace-pre-wrap text-2xs leading-snug",
				tone,
			)}
		>
			{text || "(empty)"}
		</pre>
	);
}

function StatusPill({ status }: { status: RoutineStepStatus }): JSX.Element {
	const cls =
		status === "success"
			? "bg-success/10 text-success border-success/30"
			: status === "failed"
				? "bg-danger/10 text-danger border-danger/40"
				: status === "aborted"
					? "bg-warn/10 text-warn border-warn/40"
					: status === "running"
						? "bg-accent/10 text-accent border-accent/40"
						: status === "skipped"
							? "bg-paper-3 text-ink-3 border-line"
							: "bg-paper-3 text-ink-3 border-line";
	return (
		<span
			className={cn(
				"rounded border px-1.5 py-0.5 font-mono text-2xs uppercase tracking-meta",
				cls,
			)}
		>
			{status}
		</span>
	);
}

function formatDur(ms: number): string {
	if (ms < 1000) return `${Math.round(ms)}ms`;
	const s = ms / 1000;
	if (s < 60) return `${s.toFixed(1)}s`;
	const m = Math.floor(s / 60);
	const rem = Math.round(s - m * 60);
	return `${m}m${rem}s`;
}

function prettyJson(raw: string): string {
	if (!raw) return "";
	try {
		return JSON.stringify(JSON.parse(raw), null, 2);
	} catch {
		return raw;
	}
}
