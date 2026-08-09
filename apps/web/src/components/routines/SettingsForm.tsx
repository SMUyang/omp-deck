/**
 * Routine settings form: concurrency, budget caps, timezone, tags, declared
 * state keys. Lives under the Builder tab's "Settings" subsection.
 */
import type { RoutineBudget, RoutineConcurrency, RoutineSpec } from "@omp-deck/protocol";
import { useTranslation } from "react-i18next";

import { Field, NumInput, TagInput, TextInput } from "./form-primitives";

interface Props {
	spec: RoutineSpec;
	onChange: (next: RoutineSpec) => void;
}

const CONCURRENCY_OPTIONS: ReadonlyArray<{
	value: RoutineConcurrency;
	label: string;
	key: string;
}> = [
	{ value: "skip", label: "skip", key: "skip" },
	{ value: "queue", label: "queue", key: "queue" },
	{ value: "cancel-previous", label: "cancel-previous", key: "cancelPrevious" },
	{ value: "parallel", label: "parallel", key: "parallel" },
];

export function SettingsForm({ spec, onChange }: Props) {
	const { t } = useTranslation();
	function patchSpec(p: Partial<RoutineSpec>): void {
		onChange({ ...spec, ...p });
	}
	function patchBudget(p: Partial<RoutineBudget>): void {
		const next: RoutineBudget = { ...(spec.budget ?? {}), ...p };
		// Drop empty keys so the YAML output stays clean.
		const cleaned: RoutineBudget = {};
		for (const [k, v] of Object.entries(next)) {
			if (v !== undefined && v !== null) (cleaned as Record<string, unknown>)[k] = v;
		}
		if (Object.keys(cleaned).length === 0) {
			const without = { ...spec };
			delete without.budget;
			onChange(without);
		} else {
			patchSpec({ budget: cleaned });
		}
	}
	return (
		<div className="space-y-3">
			<Field label={t("routines.settingsForm.name")}>
				<TextInput value={spec.name} onChange={(v) => patchSpec({ name: v })} placeholder="my-routine" mono />
			</Field>
			<Field label={t("routines.settingsForm.description")}>
				<TextInput
					value={spec.description ?? ""}
					onChange={(v) => {
						const next = { ...spec };
						if (v.trim() === "") delete next.description;
						else next.description = v;
						onChange(next);
					}}
					placeholder={t("routines.settingsForm.descriptionPlaceholder")}
				/>
			</Field>
			<Field label={t("routines.settingsForm.concurrency")}>
				<select
					value={spec.concurrency ?? "skip"}
					onChange={(e) => patchSpec({ concurrency: e.target.value as RoutineConcurrency })}
					className="field h-7 w-full px-2 font-mono text-2xs"
				>
					{CONCURRENCY_OPTIONS.map((o) => (
						<option key={o.value} value={o.value}>
							{o.label} — {t(`routines.settingsForm.concurrencyHelp.${o.key}`)}
						</option>
					))}
				</select>
			</Field>
			<Field label={t("routines.settingsForm.timezone")}>
				<TextInput
					value={spec.timezone ?? ""}
					onChange={(v) => {
						const next = { ...spec };
						if (v.trim() === "") delete next.timezone;
						else next.timezone = v;
						onChange(next);
					}}
					placeholder="America/Chicago"
					mono
				/>
			</Field>
			<Field label={t("routines.settingsForm.tags")}>
				<TagInput
					values={spec.tags ?? []}
					onChange={(v) => {
						const next = { ...spec };
						if (v.length === 0) delete next.tags;
						else next.tags = v;
						onChange(next);
					}}
					placeholder="daily,inbox"
				/>
			</Field>
			<div>
				<div className="meta mb-1.5">{t("routines.settingsForm.budget")}</div>
				<div className="grid grid-cols-2 gap-2">
					<Field label={t("routines.settingsForm.maxDurationSecs")}>
						<NumInput
							value={spec.budget?.max_duration_secs}
							onChange={(v) =>
								patchBudget({ max_duration_secs: v === undefined ? undefined : v })
							}
							placeholder="180"
						/>
					</Field>
					<Field label={t("routines.settingsForm.maxLlmCostUsd")}>
						<NumInput
							value={spec.budget?.max_llm_cost_usd}
							onChange={(v) =>
								patchBudget({ max_llm_cost_usd: v === undefined ? undefined : v })
							}
							placeholder="0.05"
						/>
					</Field>
					<Field label={t("routines.settingsForm.maxLlmTokensInput")}>
						<NumInput
							value={spec.budget?.max_llm_tokens_input}
							onChange={(v) =>
								patchBudget({ max_llm_tokens_input: v === undefined ? undefined : v })
							}
							placeholder="50000"
						/>
					</Field>
					<Field label={t("routines.settingsForm.maxLlmTokensOutput")}>
						<NumInput
							value={spec.budget?.max_llm_tokens_output}
							onChange={(v) =>
								patchBudget({ max_llm_tokens_output: v === undefined ? undefined : v })
							}
							placeholder="8000"
						/>
					</Field>
					<Field label={t("routines.settingsForm.maxStepsExecuted")}>
						<NumInput
							value={spec.budget?.max_steps_executed}
							onChange={(v) =>
								patchBudget({ max_steps_executed: v === undefined ? undefined : v })
							}
							placeholder="20"
						/>
					</Field>
				</div>
			</div>
			<Field label={t("routines.settingsForm.declaredStateKeys")}>
				<TagInput
					values={spec.state?.declared_keys ?? []}
					onChange={(v) => {
						const next = { ...spec };
						if (v.length === 0) {
							if (next.state) {
								const stateNext = { ...next.state };
								delete stateNext.declared_keys;
								if (Object.keys(stateNext).length === 0) delete next.state;
								else next.state = stateNext;
							}
						} else {
							next.state = { ...(next.state ?? {}), declared_keys: v };
						}
						onChange(next);
					}}
					placeholder="last_run_date"
				/>
			</Field>
		</div>
	);
}
