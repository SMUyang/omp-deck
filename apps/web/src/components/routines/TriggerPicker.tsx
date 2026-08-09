/**
 * Trigger picker. Edits a routine's `trigger:` array (cron, webhook, manual).
 * Event triggers are reserved in the schema for V1.5 — not surfaced here yet.
 */
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Plus, Trash2 } from "lucide-react";

import type { RoutineTrigger } from "@omp-deck/protocol";

import { Field, NumInput as _NumInput, TextInput } from "./form-primitives";

interface Props {
	triggers: RoutineTrigger[];
	onChange: (next: RoutineTrigger[]) => void;
}

const PRESET_CRONS: ReadonlyArray<{ key: string; expr: string }> = [
	{ key: "everyMinute", expr: "* * * * *" },
	{ key: "hourly", expr: "0 * * * *" },
	{ key: "daily7am", expr: "0 7 * * *" },
	{ key: "weekdays9am", expr: "0 9 * * 1-5" },
	{ key: "weeklySun9am", expr: "0 9 * * 0" },
];

export function TriggerPicker({ triggers, onChange }: Props) {
	const { t } = useTranslation();
	function add(kind: "cron" | "webhook" | "manual"): void {
		const next = triggers.slice();
		if (kind === "cron") next.push({ cron: "0 9 * * *" });
		else if (kind === "webhook") {
			const path = `/hooks/${Math.random().toString(36).slice(2, 10)}`;
			next.push({ webhook: { path, secret_env: "ROUTINE_WEBHOOK_SECRET" } });
		} else next.push({ manual: {} });
		onChange(next);
	}
	function remove(idx: number): void {
		const next = triggers.slice();
		next.splice(idx, 1);
		onChange(next);
	}
	function replace(idx: number, t: RoutineTrigger): void {
		const next = triggers.slice();
		next[idx] = t;
		onChange(next);
	}

	return (
		<div className="space-y-2">
			{triggers.length === 0 ? (
				<div className="rounded border border-warn/40 bg-warn/5 px-2 py-1.5 font-mono text-2xs text-warn">
					{t("routines.triggerPicker.noTriggers")}
				</div>
			) : null}
			{triggers.map((trg, idx) => (
				<TriggerCard key={idx} trigger={trg} onChange={(v) => replace(idx, v)} onRemove={() => remove(idx)} />
			))}
			<div className="flex flex-wrap gap-1.5">
				<button type="button" onClick={() => add("cron")} className="btn-ghost h-7 px-2 text-2xs">
					<Plus className="h-3 w-3" />
					{t("routines.triggerPicker.addCron")}
				</button>
				<button type="button" onClick={() => add("webhook")} className="btn-ghost h-7 px-2 text-2xs">
					<Plus className="h-3 w-3" />
					{t("routines.triggerPicker.addWebhook")}
				</button>
				<button type="button" onClick={() => add("manual")} className="btn-ghost h-7 px-2 text-2xs">
					<Plus className="h-3 w-3" />
					{t("routines.triggerPicker.addManual")}
				</button>
			</div>
		</div>
	);
}

function TriggerCard({
	trigger,
	onChange,
	onRemove,
}: {
	trigger: RoutineTrigger;
	onChange: (next: RoutineTrigger) => void;
	onRemove: () => void;
}) {
	const { t } = useTranslation();
	const kind: "cron" | "webhook" | "manual" | "event" = (() => {
		if ("cron" in trigger) return "cron";
		if ("webhook" in trigger) return "webhook";
		if ("manual" in trigger) return "manual";
		return "event";
	})();
	const kindLabel = (() => {
		switch (kind) {
			case "cron":
				return t("routines.triggerPicker.kindCron");
			case "webhook":
				return t("routines.triggerPicker.kindWebhook");
			case "manual":
				return t("routines.triggerPicker.kindManual");
			default:
				return t("routines.triggerPicker.kindEvent");
		}
	})();
	return (
		<div className="rounded border border-line bg-paper-2/40 p-2">
			<div className="flex items-center justify-between">
				<div className="meta">{kindLabel}</div>
				<button type="button" onClick={onRemove} className="btn-ghost h-6 w-6 p-0 text-ink-4 hover:text-danger">
					<Trash2 className="h-3 w-3" />
				</button>
			</div>
			<div className="mt-1.5">
				{"cron" in trigger ? <CronEditor expr={trigger.cron} onChange={(c) => onChange({ cron: c })} /> : null}
				{"webhook" in trigger ? (
					<WebhookEditor
						path={trigger.webhook.path}
						secretEnv={trigger.webhook.secret_env}
						onChange={(path, secret_env) => onChange({ webhook: { path, secret_env } })}
					/>
				) : null}
				{"manual" in trigger ? (
					<div className="font-mono text-2xs text-ink-3">
						{t("routines.triggerPicker.manualHint")}{" "}
						<code>POST /api/routines/:id/run</code>.
					</div>
				) : null}
				{"event" in trigger ? (
					<div className="font-mono text-2xs text-ink-4">{t("routines.triggerPicker.eventHint")}</div>
				) : null}
			</div>
		</div>
	);
}

function CronEditor({ expr, onChange }: { expr: string; onChange: (v: string) => void }) {
	const { t } = useTranslation();
	const [preview, setPreview] = useState<
		| { valid: true; nextRuns: string[] }
		| { valid: false; error: string }
		| undefined
	>(undefined);
	useEffect(() => {
		if (!expr.trim()) {
			setPreview(undefined);
			return;
		}
		const t = setTimeout(async () => {
			try {
				const r = await fetch(`/api/cron/validate?expr=${encodeURIComponent(expr)}`);
				setPreview(
					(await r.json()) as
						| { valid: true; nextRuns: string[] }
						| { valid: false; error: string },
				);
			} catch {
				/* keep previous */
			}
		}, 250);
		return () => clearTimeout(t);
	}, [expr]);
	return (
		<div className="space-y-1.5">
			<TextInput value={expr} onChange={onChange} placeholder="0 9 * * *" mono />
			<div className="flex flex-wrap gap-1">
				{PRESET_CRONS.map((p) => (
					<button
						key={p.expr}
						type="button"
						onClick={() => onChange(p.expr)}
						className="rounded border border-line bg-paper-2 px-1.5 py-0.5 font-mono text-2xs text-ink-3 hover:bg-paper-3 hover:text-ink"
					>
						{t(`routines.triggerPicker.cronPresets.${p.key}`)}
					</button>
				))}
			</div>
			{preview ? (
				preview.valid ? (
					<div className="rounded border border-success/30 bg-success/5 px-2 py-1">
						<div className="meta mb-0.5 text-success">{t("routines.triggerPicker.nextRuns", { count: preview.nextRuns.length })}</div>
						<ul className="space-y-0.5 font-mono text-2xs text-ink-2">
							{preview.nextRuns.slice(0, 3).map((iso) => (
								<li key={iso}>{new Date(iso).toLocaleString()}</li>
							))}
						</ul>
					</div>
				) : (
					<div className="rounded border border-danger/40 bg-danger/5 px-2 py-1 font-mono text-2xs text-danger">
						{preview.error}
					</div>
				)
			) : null}
		</div>
	);
}

function WebhookEditor({
	path,
	secretEnv,
	onChange,
}: {
	path: string;
	secretEnv: string;
	onChange: (path: string, secretEnv: string) => void;
}) {
	const { t } = useTranslation();
	return (
		<div className="space-y-1.5">
			<Field label={t("routines.triggerPicker.path")}>
				<TextInput value={path} onChange={(v) => onChange(v, secretEnv)} placeholder="/hooks/my-routine" mono />
			</Field>
			<Field label={t("routines.triggerPicker.secretEnv")}>
				<TextInput
					value={secretEnv}
					onChange={(v) => onChange(path, v)}
					placeholder="ROUTINE_WEBHOOK_SECRET"
					mono
				/>
			</Field>
			<div className="font-mono text-2xs text-ink-3">
				{t("routines.triggerPicker.webhookHint")}{" "}
				<code>X-Routine-Signature: sha256=...</code>.
			</div>
		</div>
	);
}
