/**
 * V1 routine builder. Form-mode visual editor over a `RoutineSpec`, with a
 * Spec tab that surfaces the underlying YAML for round-tripping. The two views
 * share the same backing model: form edits update `spec`, which serializes to
 * `yamlBuffer`; valid YAML edits parse back into `spec`.
 *
 * Invalid YAML disables form view with an inline parse-error explanation.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Copy, RefreshCcw } from "lucide-react";

import type {
	Routine,
	RoutineDeckAction,
	RoutineRun,
	RoutineSpec,
	RoutineStep,
	RoutineTrigger,
	ValidationError,
} from "@omp-deck/protocol";

import { routinesApi } from "@/lib/routines-api";
import { formatDurationMs } from "@/lib/utils";

import { compileGraph } from "./canvas/graph-compile";
import { RoutineCanvas } from "./canvas/RoutineCanvas";
import { SavePreviewDialog, shouldSkipSavePreview } from "./canvas/SavePreviewDialog";
import { useRunOverlay } from "./canvas/use-run-overlay";
import { AddStepPicker } from "./AddStepPicker";
import { SettingsForm } from "./SettingsForm";
import { StepCard } from "./StepCard";
import { TriggerPicker } from "./TriggerPicker";
import {
	emptyV1Spec,
	insertStep,
	moveStep,
	parseSpec,
	removeStep,
	replaceStep,
	replaceTriggers,
	scaffoldStep,
	stringifySpec,
} from "./spec-yaml";

interface Props {
	/** The routine being edited, or `undefined` if we're creating a new V1 routine. */
	routine: Routine | undefined;
	onSaved: (saved: Routine) => void;
	onError: (message: string) => void;
}

type Tab = "steps" | "canvas" | "triggers" | "settings" | "spec";

/**
 * Initial tab to land on when (re)opening the editor:
 * - Brand-new routine, or routine with a saved `layout` block -> Canvas.
 * - Existing routine without a layout -> Steps (form mode, preserving prior UX).
 */
function pickInitialTab(routine: Routine | undefined, spec: RoutineSpec): Tab {
	if (!routine) return "canvas";
	if (spec.layout) return "canvas";
	return "steps";
}

export function RoutineBuilder({ routine, onSaved, onError }: Props) {
	const initialSpec = useMemo<RoutineSpec>(() => {
		if (routine?.specYaml) {
			const parsed = parseSpec(routine.specYaml);
			if (parsed.ok && parsed.spec) return parsed.spec;
		}
		return emptyV1Spec();
	}, [routine]);

	const [spec, setSpec] = useState<RoutineSpec>(initialSpec);
	const [yamlBuffer, setYamlBuffer] = useState<string>(() =>
		routine?.specYaml ?? stringifySpec(initialSpec),
	);
	const [yamlDirty, setYamlDirty] = useState(false);
	const [yamlError, setYamlError] = useState<string | undefined>();
	const [schemaErrors, setSchemaErrors] = useState<ValidationError[] | undefined>();
	const [tab, setTab] = useState<Tab>(() => pickInitialTab(routine, initialSpec));
	const [busy, setBusy] = useState(false);
	const [enabled, setEnabled] = useState<boolean>(routine?.enabled ?? false);
	const [webhookSecret, setWebhookSecret] = useState<string | undefined>();
	const [runs, setRuns] = useState<RoutineRun[]>([]);
	const [showRuns, setShowRuns] = useState(false);
	// T-70: pre-save diff preview state. When non-null, the SavePreviewDialog is
	// open and the contained `specToSave` + `specYaml` are what will be PATCHed
	// or POSTed when the user confirms. Cancelling clears this back to null.
	const [pendingSave, setPendingSave] = useState<{
		specToSave: RoutineSpec;
		specYaml: string;
	} | null>(null);

	// When the parent passes a different routine, reset everything.
	const lastRoutineId = useRef<string | undefined>(routine?.id);
	useEffect(() => {
		if (lastRoutineId.current === routine?.id) return;
		lastRoutineId.current = routine?.id;
		setSpec(initialSpec);
		setYamlBuffer(routine?.specYaml ?? stringifySpec(initialSpec));
		setYamlDirty(false);
		setYamlError(undefined);
		setSchemaErrors(undefined);
		setEnabled(routine?.enabled ?? false);
		setTab(pickInitialTab(routine, initialSpec));
	}, [routine, initialSpec]);

	useEffect(() => {
		if (!routine) return;
		void routinesApi.runs(routine.id, 10).then((r) => setRuns(r.runs));
	}, [routine]);

	// Form -> YAML sync.
	function updateSpec(next: RoutineSpec): void {
		setSpec(next);
		setYamlBuffer(stringifySpec(next));
		setYamlDirty(false);
		setYamlError(undefined);
		setSchemaErrors(undefined);
	}
	// YAML -> form sync (debounced via blur; the textarea-onChange just tracks
	// the buffer; we re-parse when the user clicks "Apply" or switches tab).
	function applyYaml(): boolean {
		const result = parseSpec(yamlBuffer);
		if (!result.ok) {
			if (result.yamlError) setYamlError(`${result.yamlError.message}${result.yamlError.line ? ` (line ${result.yamlError.line})` : ""}`);
			else setYamlError(undefined);
			if (result.schemaErrors) setSchemaErrors(result.schemaErrors);
			else setSchemaErrors(undefined);
			return false;
		}
		setSpec(result.spec ?? emptyV1Spec());
		setYamlDirty(false);
		setYamlError(undefined);
		setSchemaErrors(undefined);
		return true;
	}

	function switchTab(next: Tab): void {
		// If leaving the YAML tab with unsaved YAML, try to apply it first; if
		// invalid, keep the user on the YAML tab so they can see the error.
		if (tab === "spec" && yamlDirty && next !== "spec") {
			const ok = applyYaml();
			if (!ok) return;
		}
		setTab(next);
	}

	// Compile the canvas graph on every spec change. In the linear short-circuit
	// path (no `layout.edges`), this is the identity function; it only does work
	// when the user has wired explicit edges via the canvas. Errors gate Save
	// and feed the canvas's red-ring overlay + bottom error strip.
	const compile = useMemo(() => compileGraph(spec), [spec]);

	// T-71: run-status overlay state. Shared between the canvas (ring colors
	// + badges + last-run picker) and the inspector (per-step output preview
	// in T-72). Subscribes to WS for live updates while the routine runs.
	const runOverlay = useRunOverlay(routine?.id);

	async function save(): Promise<void> {
		// Make sure YAML changes are applied to the live spec first.
		if (yamlDirty) {
			const ok = applyYaml();
			if (!ok) {
				onError("Spec has validation errors. Fix them on the Spec tab before saving.");
				return;
			}
		}
		// Re-compile against the freshest spec (applyYaml may have mutated it
		// since the memo snapshotted). Block save when any error is present;
		// the canvas error strip already shows the user what is broken.
		const finalCompile = compileGraph(spec);
		if (finalCompile.errors.length > 0) {
			const first = finalCompile.errors[0]!;
			onError(`Cannot save: ${first.message}${finalCompile.errors.length > 1 ? ` (+${finalCompile.errors.length - 1} more)` : ""}`);
			return;
		}
		// Apply the topo-sorted step order so the runtime engine walks the graph
		// the user drew. No-op when compile was the identity.
		const specToSave: RoutineSpec = finalCompile.steps === spec.steps
			? spec
			: { ...spec, steps: finalCompile.steps };
		const specYaml = stringifySpec(specToSave);

		// T-70: from canvas mode, route the save through a diff-preview dialog
		// unless the user has explicitly opted out (env or localStorage). Other
		// tabs save directly — the YAML editor on the Spec tab is already a
		// preview of its own, and the Steps/Triggers/Settings forms never
		// trigger branch compilation.
		const previewable =
			tab === "canvas" &&
			!shouldSkipSavePreview() &&
			specYaml !== (routine?.specYaml ?? "");
		if (previewable) {
			setPendingSave({ specToSave, specYaml });
			return;
		}
		await commitSave(specToSave, specYaml);
	}

	async function commitSave(specToSave: RoutineSpec, specYaml: string): Promise<void> {
		setBusy(true);
		try {
			if (routine) {
				const updated = await routinesApi.update(routine.id, {
					name: specToSave.name,
					description: specToSave.description ?? "",
					specYaml,
					enabled,
				});
				onSaved(updated);
			} else {
				const created = await routinesApi.create({
					name: specToSave.name,
					description: specToSave.description ?? "",
					// V0 fields are ignored when specYaml is present.
					cron: "",
					actionKind: "bash",
					actionBody: "",
					enabled,
					specYaml,
				});
				onSaved(created);
			}
			setPendingSave(null);
		} catch (e) {
			onError(String(e));
		} finally {
			setBusy(false);
		}
	}

	async function runNow(): Promise<void> {
		if (!routine) return;
		try {
			await routinesApi.runNow(routine.id);
			await new Promise((r) => setTimeout(r, 600));
			const r = await routinesApi.runs(routine.id, 10);
			setRuns(r.runs);
			setShowRuns(true);
		} catch (e) {
			onError(String(e));
		}
	}

	async function rotateWebhook(): Promise<void> {
		if (!routine) return;
		try {
			const res = await routinesApi.rotateWebhookSecret(routine.id);
			setWebhookSecret(res.secret);
		} catch (e) {
			onError(String(e));
		}
	}

	// ─── Step helpers ───────────────────────────────────────────────────────

	const existingStepIds = spec.steps.map((s) => s.id);
	function onAddStep(type: RoutineStep["type"], presetAction?: RoutineDeckAction): void {
		updateSpec(insertStep(spec, scaffoldStep(type, existingStepIds, presetAction)));
	}
	function onChangeStep(index: number, next: RoutineStep): void {
		updateSpec(replaceStep(spec, index, next));
	}
	function onRemoveStep(index: number): void {
		updateSpec(removeStep(spec, index));
	}
	function onMoveUp(index: number): void {
		updateSpec(moveStep(spec, index, Math.max(0, index - 1)));
	}
	function onMoveDown(index: number): void {
		updateSpec(moveStep(spec, index, Math.min(spec.steps.length - 1, index + 1)));
	}
	function onChangeTriggers(triggers: RoutineTrigger[]): void {
		updateSpec(replaceTriggers(spec, triggers));
	}

	// ─── Render ────────────────────────────────────────────────────────────

	const canSave =
		spec.name.trim().length > 0 &&
		spec.trigger.length > 0 &&
		spec.steps.length > 0 &&
		compile.errors.length === 0 &&
		!busy;

	return (
		<div
			className={
				// T-77: canvas tab claims the full viewport so the graph + inspector
				// can spread out; form tabs stay capped at 5xl for readability.
				tab === "canvas"
					? "flex h-full flex-col overflow-hidden rounded-lg border border-line bg-paper shadow-[0_1px_0_0_rgb(var(--ink)/0.03)]"
					: "mx-auto flex h-full max-w-5xl flex-col overflow-hidden rounded-lg border border-line bg-paper shadow-[0_1px_0_0_rgb(var(--ink)/0.03)]"
			}
		>
			<TabBar tab={tab} onChange={switchTab} stepCount={spec.steps.length} triggerCount={spec.trigger.length} />
			<div
				className={
					tab === "canvas"
						? "flex-1 min-h-0"
						: "flex-1 overflow-y-auto px-3 py-3"
				}
			>
				{tab === "steps" ? (
					<div className="space-y-2">
						{spec.steps.length === 0 ? (
							<div className="rounded border border-dashed border-line bg-paper-2 p-4 text-center text-2xs text-ink-3">
								No steps yet. Pick one to start.
							</div>
						) : (
							spec.steps.map((step, idx) => (
								<StepCard
									key={`${step.id}-${idx}`}
									step={step}
									index={idx}
									total={spec.steps.length}
									existingIds={existingStepIds}
									onChange={(n) => onChangeStep(idx, n)}
									onRemove={() => onRemoveStep(idx)}
									onMoveUp={() => onMoveUp(idx)}
									onMoveDown={() => onMoveDown(idx)}
								/>
							))
						)}
						<AddStepPicker onAdd={onAddStep} />
					</div>
				) : null}

				{tab === "canvas" ? (
					<RoutineCanvas
						spec={spec}
						onChange={updateSpec}
						compileErrors={compile.errors}
						routineId={routine?.id}
						runs={runOverlay.runs}
						selectedRunId={runOverlay.selectedRunId}
						onSelectRun={runOverlay.setSelectedRunId}
						stepRunsByStepId={runOverlay.stepRunsByStepId}
					/>
				) : null}

				{tab === "triggers" ? (
					<TriggerPicker triggers={spec.trigger} onChange={onChangeTriggers} />
				) : null}

				{tab === "settings" ? (
					<div className="space-y-3">
						<SettingsForm spec={spec} onChange={updateSpec} />
						{routine ? (
							<div className="space-y-2 rounded border border-line bg-paper-2/40 p-2">
								<div className="meta">Webhook secret</div>
								<button
									type="button"
									onClick={() => void rotateWebhook()}
									className="btn-ghost h-7 text-2xs"
								>
									<RefreshCcw className="h-3 w-3" />
									Rotate secret
								</button>
								{webhookSecret ? (
									<div className="space-y-1">
										<div className="font-mono text-2xs text-warn">
											Copy now — the secret is shown ONCE.
										</div>
										<div className="flex items-center gap-1">
											<code className="flex-1 truncate rounded border border-line bg-paper-code px-2 py-1 font-mono text-2xs">
												{webhookSecret}
											</code>
											<button
												type="button"
												onClick={() => {
													void navigator.clipboard.writeText(webhookSecret);
												}}
												className="btn-ghost h-7 w-7 p-0"
												aria-label="Copy"
											>
												<Copy className="h-3.5 w-3.5" />
											</button>
										</div>
									</div>
								) : null}
							</div>
						) : null}
					</div>
				) : null}

				{tab === "spec" ? (
					<div className="space-y-2">
						<textarea
							value={yamlBuffer}
							onChange={(e) => {
								setYamlBuffer(e.target.value);
								setYamlDirty(true);
							}}
							rows={28}
							spellCheck={false}
							className="field w-full resize-y px-2 py-1.5 font-mono text-2xs leading-relaxed"
						/>
						<div className="flex items-center gap-2">
							<button
								type="button"
								onClick={applyYaml}
								disabled={!yamlDirty}
								className="btn-ghost h-7 text-2xs disabled:opacity-40"
							>
								Apply to form
							</button>
							{yamlDirty ? (
								<span className="font-mono text-2xs text-warn">unsaved YAML edits</span>
							) : null}
						</div>
						{yamlError ? (
							<div className="rounded border border-danger/40 bg-danger/5 px-2 py-1.5 font-mono text-2xs text-danger">
								YAML parse: {yamlError}
							</div>
						) : null}
						{schemaErrors ? (
							<div className="rounded border border-danger/40 bg-danger/5 px-2 py-1.5">
								<div className="meta mb-0.5 text-danger">Schema errors</div>
								<ul className="space-y-0.5 font-mono text-2xs text-danger">
									{schemaErrors.slice(0, 6).map((e, idx) => (
										<li key={idx}>
											{e.path || "/"} — {e.message}
										</li>
									))}
								</ul>
							</div>
						) : null}
					</div>
				) : null}

				{routine && tab !== "canvas" ? (
					<div className="mt-3 border-t border-line pt-2">
						<button
							type="button"
							onClick={() => setShowRuns((s) => !s)}
							className="flex w-full items-center gap-1 text-left font-mono text-2xs text-ink-3 hover:text-ink"
						>
							<span>Recent runs ({runs.length})</span>
							<span className="text-ink-4">{showRuns ? "▾" : "▸"}</span>
						</button>
						{showRuns ? <RunList routine={routine} runs={runs} /> : null}
					</div>
				) : null}
			</div>
			<Footer
				routine={routine}
				canSave={canSave}
				busy={busy}
				enabled={enabled}
				setEnabled={setEnabled}
				onSave={() => void save()}
				onRunNow={() => void runNow()}
			/>
			{pendingSave ? (
				<SavePreviewDialog
					currentYaml={routine?.specYaml ?? ""}
					newYaml={pendingSave.specYaml}
					busy={busy}
					onCancel={() => {
						if (!busy) setPendingSave(null);
					}}
					onConfirm={() => {
						void commitSave(pendingSave.specToSave, pendingSave.specYaml);
					}}
				/>
			) : null}
		</div>
	);
}

function TabBar({
	tab,
	onChange,
	stepCount,
	triggerCount,
}: {
	tab: Tab;
	onChange: (next: Tab) => void;
	stepCount: number;
	triggerCount: number;
}) {
	const tabs: ReadonlyArray<{ id: Tab; label: string; badge?: number }> = [
		{ id: "canvas", label: "Canvas" },
		{ id: "steps", label: "Steps", badge: stepCount },
		{ id: "triggers", label: "Triggers", badge: triggerCount },
		{ id: "settings", label: "Settings" },
		{ id: "spec", label: "Spec (YAML)" },
	];
	return (
		<div className="flex shrink-0 border-b border-line bg-paper">
			{tabs.map((t) => (
				<button
					key={t.id}
					type="button"
					onClick={() => onChange(t.id)}
					className={
						"relative h-9 px-3 text-2xs uppercase tracking-meta " +
						(tab === t.id
							? "text-ink after:absolute after:inset-x-2 after:bottom-0 after:h-px after:bg-accent"
							: "text-ink-3 hover:text-ink")
					}
				>
					{t.label}
					{t.badge !== undefined ? (
						<span className="ml-1.5 rounded bg-paper-2 px-1 font-mono text-2xs text-ink-3">
							{t.badge}
						</span>
					) : null}
				</button>
			))}
		</div>
	);
}

function Footer({
	routine,
	canSave,
	busy,
	enabled,
	setEnabled,
	onSave,
	onRunNow,
}: {
	routine: Routine | undefined;
	canSave: boolean;
	busy: boolean;
	enabled: boolean;
	setEnabled: (v: boolean) => void;
	onSave: () => void;
	onRunNow: () => void;
}) {
	return (
		<div className="flex shrink-0 items-center gap-2 border-t border-line bg-paper px-3 py-2">
			<label className="flex items-center gap-2 text-2xs">
				<input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
				<span>Enabled</span>
			</label>
			<div className="ml-auto flex items-center gap-1.5">
				{routine ? (
					<button type="button" onClick={onRunNow} className="btn-ghost text-2xs">
						Run now
					</button>
				) : null}
				<button
					type="button"
					onClick={onSave}
					disabled={!canSave}
					className="btn-primary text-2xs disabled:opacity-50"
				>
					{busy ? "Saving..." : routine ? "Save" : "Create"}
				</button>
			</div>
		</div>
	);
}

function RunList({ routine, runs }: { routine: Routine; runs: RoutineRun[] }) {
	return (
		<ul className="mt-2 space-y-1">
			{runs.length === 0 ? (
				<li className="font-mono text-2xs text-ink-3">No runs yet.</li>
			) : (
				runs.map((r) => {
					const dur =
						r.endedAt && r.startedAt
							? new Date(r.endedAt).getTime() - new Date(r.startedAt).getTime()
							: undefined;
					const ok = !r.error && !r.abortReason;
					return (
						<li key={r.id} className="flex items-center gap-2 font-mono text-2xs">
							<span
								className={
									"h-1.5 w-1.5 shrink-0 rounded-full " +
									(r.endedAt || r.abortedAt ? (ok ? "bg-success" : "bg-danger") : "bg-accent")
								}
							/>
							<span className="text-ink-3">{new Date(r.startedAt).toLocaleString()}</span>
							<span className="text-ink-4">{r.trigger}</span>
							{dur !== undefined ? <span className="text-ink-4">{formatDurationMs(dur)}</span> : null}
							{r.abortReason ? <span className="text-warn">{r.abortReason}</span> : null}
							<a
								href={`/routines/${routine.id}/runs/${r.id}`}
								className="ml-auto text-ink-3 underline-offset-2 hover:text-accent hover:underline"
							>
								detail
							</a>
						</li>
					);
				})
			)}
		</ul>
	);
}
