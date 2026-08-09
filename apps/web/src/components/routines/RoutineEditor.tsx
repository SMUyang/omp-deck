import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { Maximize2, Trash2, X } from "lucide-react";
import type { Routine, RoutineActionKind, RoutineRun } from "@omp-deck/protocol";

import { routinesApi } from "@/lib/routines-api";
import { formatDurationMs } from "@/lib/utils";

import { RoutineBuilder } from "./RoutineBuilder";

interface Props {
	routine: Routine | "new";
	onClose: () => void;
	onSaved: (routine: Routine) => void;
	onDeleted: (id: string) => void;
}

const KINDS: ReadonlyArray<{
	value: RoutineActionKind;
	label: string;
	placeholder?: string;
	placeholderKey?: string;
}> = [
	{ value: "bash", label: "bash", placeholder: "echo hello" },
	{ value: "script", label: "script", placeholder: "C:/path/to/script.ps1 --flag" },
	{ value: "prompt", label: "prompt", placeholderKey: "prompt" },
];

const PRESET_CRONS: ReadonlyArray<{ key: string; expr: string }> = [
	{ key: "everyMinute", expr: "* * * * *" },
	{ key: "hourly", expr: "0 * * * *" },
	{ key: "daily9am", expr: "0 9 * * *" },
	{ key: "weekdays9am", expr: "0 9 * * 1-5" },
	{ key: "weeklySun9am", expr: "0 9 * * 0" },
];

type Mode = "v0" | "v1";

export function RoutineEditor({ routine, onClose, onSaved, onDeleted }: Props) {
	const { t } = useTranslation();
	const isNew = routine === "new";
	const existingMode: Mode = !isNew && routine.specVersion === 1 ? "v1" : "v0";
	// New routines start in V1 (multi-step builder) by default; users can
	// toggle to legacy V0 single-action mode for trivial cron jobs.
	const [mode, setMode] = useState<Mode>(isNew ? "v1" : existingMode);
	const [err, setErr] = useState<string | undefined>();

	// Reset mode when switching to a different routine.
	useEffect(() => {
		setMode(isNew ? "v1" : existingMode);
		setErr(undefined);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [routine]);

	// Existing V1 routines MUST stay in V1 mode (you can't downgrade a spec).
	const canSwitchMode = isNew;

	async function remove(): Promise<void> {
		if (isNew) return;
		if (!confirm(t("routines.routineEditor.confirmDelete", { name: routine.name }))) return;
		try {
			await routinesApi.remove(routine.id);
			onDeleted(routine.id);
		} catch (e) {
			setErr(String(e));
		}
	}

	return (
		<div className="flex h-full flex-col">
			<div className="flex h-11 items-center gap-2 border-b border-line px-3">
				<div className="meta">{isNew ? t("routines.routineEditor.newRoutine") : t("routines.routineEditor.editRoutine")}</div>
				{!isNew ? (
					<span className="rounded bg-paper-3 px-1.5 py-0.5 font-mono text-2xs uppercase tracking-meta text-accent">
						{routine.specVersion === 1 ? t("routines.routineEditor.v1Pipeline") : t("routines.routineEditor.v0SingleAction")}
					</span>
				) : null}
				{canSwitchMode ? (
					<div className="ml-2 flex items-center gap-0.5 rounded border border-line bg-paper-2 p-0.5">
						<button
							type="button"
							onClick={() => setMode("v1")}
							className={
								"rounded px-2 py-0.5 font-mono text-2xs uppercase tracking-meta " +
								(mode === "v1" ? "bg-ink text-paper-2" : "text-ink-3 hover:text-ink")
							}
						>
							{t("routines.routineEditor.pipeline")}
						</button>
						<button
							type="button"
							onClick={() => setMode("v0")}
							className={
								"rounded px-2 py-0.5 font-mono text-2xs uppercase tracking-meta " +
								(mode === "v0" ? "bg-ink text-paper-2" : "text-ink-3 hover:text-ink")
							}
						>
							{t("routines.routineEditor.singleAction")}
						</button>
					</div>
				) : null}
				<button
					type="button"
					onClick={onClose}
					className="btn-ghost ml-auto h-7 w-7 p-0"
					aria-label={t("routines.routineEditor.close")}
				>
					<X className="h-4 w-4" />
				</button>
			</div>

			{err ? (
				<div className="border-b border-line bg-danger/10 px-3 py-1 font-mono text-2xs text-danger">{err}</div>
			) : null}

			{mode === "v1" ? (
				<RoutineBuilder
					routine={isNew ? undefined : routine}
					onSaved={onSaved}
					onError={setErr}
				/>
			) : (
				<V0Editor
					routine={isNew ? "new" : routine}
					onSaved={onSaved}
					onRemove={() => void remove()}
					onError={setErr}
				/>
			)}
		</div>
	);
}

// ─── Legacy V0 single-action editor ─────────────────────────────────────────

function V0Editor({
	routine,
	onSaved,
	onRemove,
	onError,
}: {
	routine: Routine | "new";
	onSaved: (saved: Routine) => void;
	onRemove: () => void;
	onError: (msg: string) => void;
}) {
	const isNew = routine === "new";
	const { t } = useTranslation();
	const initial = isNew
		? {
				name: "",
				description: "",
				cron: "0 9 * * *",
				actionKind: "bash" as RoutineActionKind,
				actionBody: "",
				actionCwd: "",
				enabled: true,
			}
		: {
				name: routine.name,
				description: routine.description,
				cron: routine.cron,
				actionKind: routine.actionKind,
				actionBody: routine.actionBody,
				actionCwd: routine.actionCwd ?? "",
				enabled: routine.enabled,
			};

	const [form, setForm] = useState(initial);
	const [busy, setBusy] = useState(false);
	const [runs, setRuns] = useState<RoutineRun[]>([]);
	const [cronPreview, setCronPreview] = useState<
		| { valid: true; nextRuns: string[] }
		| { valid: false; error: string }
		| undefined
	>(undefined);
	const [ompOnPath, setOmpOnPath] = useState<boolean | undefined>(undefined);
	const [expandedRunId, setExpandedRunId] = useState<string | undefined>(undefined);

	useEffect(() => {
		if (!form.cron.trim()) {
			setCronPreview(undefined);
			return;
		}
		const handle = setTimeout(async () => {
			try {
				const r = await fetch(`/api/cron/validate?expr=${encodeURIComponent(form.cron)}`);
				const data = (await r.json()) as
					| { valid: true; nextRuns: string[] }
					| { valid: false; error: string };
				setCronPreview(data);
			} catch {
				/* keep previous */
			}
		}, 250);
		return () => clearTimeout(handle);
	}, [form.cron]);

	useEffect(() => {
		if (form.actionKind !== "prompt") return;
		if (ompOnPath !== undefined) return;
		void fetch("/api/binary/which?name=omp")
			.then((r) => r.json())
			.then((d) => setOmpOnPath(Boolean(d.found)))
			.catch(() => setOmpOnPath(false));
	}, [form.actionKind, ompOnPath]);

	useEffect(() => {
		setForm(initial);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [routine]);

	useEffect(() => {
		if (isNew) return;
		void routinesApi.runs(routine.id, 10).then((r) => setRuns(r.runs));
	}, [isNew, routine]);

	function update<K extends keyof typeof form>(key: K, value: (typeof form)[K]): void {
		setForm((f) => ({ ...f, [key]: value }));
	}

	async function save(): Promise<void> {
		setBusy(true);
		try {
			const payload = {
				name: form.name,
				description: form.description,
				cron: form.cron,
				actionKind: form.actionKind,
				actionBody: form.actionBody,
				actionCwd: form.actionCwd || undefined,
				enabled: form.enabled,
			};
			const saved = isNew
				? await routinesApi.create(payload)
				: await routinesApi.update(routine.id, payload);
			onSaved(saved);
		} catch (e) {
			onError(String(e));
		} finally {
			setBusy(false);
		}
	}

	async function runNow(): Promise<void> {
		if (isNew) return;
		try {
			await routinesApi.runNow(routine.id);
			await new Promise((r) => setTimeout(r, 600));
			const r = await routinesApi.runs(routine.id, 10);
			setRuns(r.runs);
		} catch (e) {
			onError(String(e));
		}
	}

	return (
		<>
			<div className="flex-1 overflow-y-auto px-3 py-3 space-y-3 text-sm">
				<Field label={t("routines.routineEditor.name")}>
					<input
						value={form.name}
						onChange={(e) => update("name", e.target.value)}
						placeholder={t("routines.routineEditor.namePlaceholder")}
						className="field h-8 w-full px-2 text-sm"
					/>
				</Field>

				<Field label={t("routines.routineEditor.description")}>
					<input
						value={form.description}
						onChange={(e) => update("description", e.target.value)}
						placeholder={t("routines.routineEditor.descriptionPlaceholder")}
						className="field h-8 w-full px-2 text-sm"
					/>
				</Field>

				<Field label={t("routines.routineEditor.cron")}>
					<input
						value={form.cron}
						onChange={(e) => update("cron", e.target.value)}
						placeholder="0 9 * * *"
						className="field h-8 w-full px-2 font-mono text-sm"
					/>
					<div className="mt-1.5 flex flex-wrap gap-1">
						{PRESET_CRONS.map((p) => (
							<button
								key={p.expr}
								type="button"
								onClick={() => update("cron", p.expr)}
								className="rounded border border-line bg-paper-2 px-1.5 py-0.5 font-mono text-2xs text-ink-3 hover:bg-paper-3 hover:text-ink"
							>
								{t(`routines.routineEditor.cronPresets.${p.key}`)}
							</button>
						))}
					</div>
					{cronPreview ? (
						cronPreview.valid ? (
							<div className="mt-2 rounded border border-success/30 bg-success/5 px-2 py-1.5">
								<div className="meta mb-0.5 text-success">
									{t("routines.routineEditor.nextRuns", { count: cronPreview.nextRuns.length })}
								</div>
								<ul className="space-y-0.5 font-mono text-2xs text-ink-2">
									{cronPreview.nextRuns.map((iso) => (
										<li key={iso}>{new Date(iso).toLocaleString()}</li>
									))}
								</ul>
							</div>
						) : (
							<div className="mt-2 rounded border border-danger/40 bg-danger/5 px-2 py-1.5 font-mono text-2xs text-danger">
								{t("routines.routineEditor.invalidCron", { error: cronPreview.error })}
							</div>
						)
					) : null}
				</Field>

				<Field label={t("routines.routineEditor.action")}>
					<div className="flex gap-1">
						{KINDS.map((k) => (
							<button
								key={k.value}
								type="button"
								onClick={() => update("actionKind", k.value)}
								className={
									"rounded border px-2 py-0.5 font-mono text-2xs uppercase tracking-meta " +
									(form.actionKind === k.value
										? "border-ink bg-ink text-paper-2"
										: "border-line text-ink-3 hover:text-ink")
								}
							>
								{k.label}
							</button>
						))}
					</div>
					<textarea
						value={form.actionBody}
						onChange={(e) => update("actionBody", e.target.value)}
						rows={5}
						placeholder={
							KINDS.find((k) => k.value === form.actionKind)?.placeholderKey
								? t(`routines.routineEditor.actionPlaceholders.${KINDS.find((k) => k.value === form.actionKind)!.placeholderKey}`)
								: (KINDS.find((k) => k.value === form.actionKind)?.placeholder ?? "")
						}
						className="field mt-1.5 w-full resize-y px-2 py-1.5 font-mono text-xs leading-relaxed"
					/>
					{form.actionKind === "prompt" ? (
						ompOnPath === false ? (
							<div className="mt-1.5 rounded border border-warn/40 bg-warn/5 px-2 py-1.5 font-mono text-2xs text-warn">
								<code>omp</code> {t("routines.routineEditor.ompNotOnPath")}
							</div>
						) : (
							<p className="mt-1 font-mono text-2xs text-ink-3">
								{t("routines.routineEditor.runsOmp")} <code>omp -p &quot;&lt;body&gt;&quot;</code> {t("routines.routineEditor.headless")}
								{ompOnPath === true ? (
									<span className="text-success"> · {t("routines.routineEditor.ompFoundOnPath")}</span>
								) : null}
								.
							</p>
						)
					) : null}
				</Field>

				<Field label={t("routines.routineEditor.workingDir")}>
					<input
						value={form.actionCwd}
						onChange={(e) => update("actionCwd", e.target.value)}
						placeholder={t("routines.routineEditor.cwdPlaceholder")}
						className="field h-8 w-full px-2 font-mono text-xs"
					/>
				</Field>

				<label className="flex items-center gap-2 text-sm">
					<input
						type="checkbox"
						checked={form.enabled}
						onChange={(e) => update("enabled", e.target.checked)}
					/>
					<span>{t("routines.routineEditor.enabled")}</span>
				</label>

				{!isNew ? (
					<section>
						<div className="meta mb-1.5">{t("routines.routineEditor.lastRuns")}</div>
						{runs.length === 0 ? (
							<div className="font-mono text-2xs text-ink-3">{t("routines.routineEditor.noRuns")}</div>
						) : (
							<ul className="space-y-1">
								{runs.map((r) => {
									const dur =
										r.endedAt && r.startedAt
											? new Date(r.endedAt).getTime() - new Date(r.startedAt).getTime()
											: undefined;
									const ok = r.error == null && (r.exitCode === 0 || r.exitCode === undefined);
									const expanded = expandedRunId === r.id;
									const hasDetail =
										Boolean(r.stdoutExcerpt) || Boolean(r.stderrExcerpt) || Boolean(r.error);
									return (
										<li key={r.id} className="border-l-2 border-line pl-2">
											<button
												type="button"
												onClick={() => setExpandedRunId(expanded ? undefined : r.id)}
												className="flex w-full items-center gap-2 text-left font-mono text-2xs hover:text-ink"
											>
												<span
													className={
														"h-1.5 w-1.5 rounded-full shrink-0 " +
														(r.endedAt ? (ok ? "bg-success" : "bg-danger") : "bg-accent")
													}
												/>
												<span className="text-ink-3">{new Date(r.startedAt).toLocaleString()}</span>
												<span className="text-ink-4">{r.trigger}</span>
												{dur !== undefined ? <span className="text-ink-4">{formatDurationMs(dur)}</span> : null}
												{r.exitCode !== undefined ? (
													<span className="text-ink-4">{t("routines.routineEditor.exitCode", { code: r.exitCode })}</span>
												) : null}
												{!r.endedAt ? <span className="text-accent">{t("routines.routineEditor.running")}</span> : null}
												<Link
													to={`/routines/${(routine as Routine).id}/runs/${r.id}`}
													onClick={(e) => e.stopPropagation()}
													className="ml-auto flex items-center gap-1 text-ink-3 hover:text-accent"
													title={t("routines.routineEditor.openRunDetail")}
												>
													<Maximize2 className="h-3 w-3" />
													<span className="text-2xs uppercase tracking-meta">{t("routines.routineEditor.detail")}</span>
												</Link>
												{hasDetail ? (
													<span className="text-ink-4">{expanded ? "▾" : "▸"}</span>
												) : null}
											</button>
											{expanded && hasDetail ? (
												<div className="mt-1.5 space-y-1.5 pl-3">
													{r.error ? <RunPane label="error" tone="danger" body={r.error} /> : null}
													{r.stdoutExcerpt ? (
														<RunPane label="stdout" tone="default" body={r.stdoutExcerpt} />
													) : null}
													{r.stderrExcerpt ? (
														<RunPane label="stderr" tone="warn" body={r.stderrExcerpt} />
													) : null}
												</div>
											) : null}
										</li>
									);
								})}
							</ul>
						)}
					</section>
				) : null}
			</div>

			<div className="flex shrink-0 items-center justify-between gap-2 border-t border-line bg-paper px-3 py-2">
				{!isNew ? (
					<button type="button" onClick={onRemove} className="btn-ghost text-danger text-xs">
						<Trash2 className="h-3.5 w-3.5" />
						{t("routines.routineEditor.delete")}
					</button>
				) : (
					<span />
				)}
				<div className="flex items-center gap-1.5">
					{!isNew ? (
						<button
							type="button"
							onClick={() => void runNow()}
							className="btn-ghost h-7 px-2.5 text-xs"
							title={t("routines.routineEditor.runNowTitle")}
						>
							{t("routines.routineEditor.runNow")}
						</button>
					) : null}
					<button
						type="button"
						onClick={() => void save()}
						disabled={busy || !form.name.trim() || !form.cron.trim() || !form.actionBody.trim()}
						className="btn-primary h-7 px-2.5 text-xs"
					>
						{isNew ? t("routines.routineEditor.create") : t("routines.routineEditor.save")}
					</button>
				</div>
			</div>
		</>
	);
}

function RunPane({ label, tone, body }: { label: string; tone: "default" | "warn" | "danger"; body: string }) {
	const toneClass =
		tone === "danger"
			? "text-danger border-danger/30"
			: tone === "warn"
				? "text-warn border-warn/30"
				: "text-ink-2 border-line";
	return (
		<div>
			<div className={`meta mb-0.5 ${toneClass.split(" ")[0]}`}>{label}</div>
			<pre
				className={`max-h-48 overflow-auto whitespace-pre-wrap break-words bg-paper-code border ${toneClass.split(" ")[1] ?? "border-line"} px-2 py-1.5 font-mono text-2xs leading-relaxed`}
			>
				{body}
			</pre>
		</div>
	);
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
	return (
		<div>
			<div className="meta mb-1">{label}</div>
			{children}
		</div>
	);
}
