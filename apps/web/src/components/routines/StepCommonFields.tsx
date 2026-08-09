import type { RoutineOnFailure, RoutineRetryPolicy, RoutineStep } from "@omp-deck/protocol";
import { useTranslation } from "react-i18next";

import { Field, NumInput, TextInput } from "./form-primitives";
import { validateStepId } from "./routine-validation";

interface Props {
	step: RoutineStep;
	onChange: (next: RoutineStep) => void;
	existingIds: string[];
}

/**
 * Renders the `id`, `when`, `on_failure`, `timeout_secs`, and `retry` fields
 * shared by every step type. The per-type form mounts this above its own
 * type-specific fields.
 */
export function StepCommonFields({ step, onChange, existingIds }: Props) {
	const { t } = useTranslation();
	function set<K extends keyof RoutineStep>(key: K, value: RoutineStep[K]): void {
		onChange({ ...step, [key]: value });
	}
	function clear(key: keyof RoutineStep): void {
		const next = { ...step };
		delete (next as Record<string, unknown>)[key];
		onChange(next);
	}
	const idCollision = existingIds.includes(step.id);
	const idError = validateStepId(step.id);
	const idHint = idCollision ? "duplicate" : idError;
	const retry = step.retry;

	return (
		<div className="space-y-2 rounded border border-line bg-paper-2/40 p-2">
			<div className="grid grid-cols-2 gap-2">
				<Field label={t("routines.stepCommonFields.id")} hint={idCollision ? t("routines.stepCommonFields.duplicate") : idError} tone={idHint ? "danger" : undefined}>
					<TextInput value={step.id} onChange={(v) => set("id", v)} placeholder="fetch_tasks" mono />
				</Field>
				<Field label={t("routines.stepCommonFields.onFailure")}>
					<select
						value={step.on_failure ?? ""}
						onChange={(e) => {
							const v = e.target.value as RoutineOnFailure | "";
							if (v === "") clear("on_failure");
							else set("on_failure", v);
						}}
						className="field h-7 w-full px-2 font-mono text-2xs"
					>
						<option value="">{t("routines.stepCommonFields.defaultAbort")}</option>
						<option value="abort">{t("routines.stepCommonFields.abort")}</option>
						<option value="continue">{t("routines.stepCommonFields.continue")}</option>
						<option value="retry">{t("routines.stepCommonFields.retry")}</option>
					</select>
				</Field>
			</div>
			<Field label={t("routines.stepCommonFields.when")}>
				<TextInput
					value={step.when ?? ""}
					onChange={(v) => (v.trim() === "" ? clear("when") : set("when", v))}
					placeholder="state.last_run_date !== run.date"
					mono
				/>
			</Field>
			<div className="grid grid-cols-2 gap-2">
				<Field label={t("routines.stepCommonFields.timeoutSecs")}>
					<NumInput
						value={step.timeout_secs}
						onChange={(v) => (v === undefined ? clear("timeout_secs") : set("timeout_secs", v))}
						placeholder="120"
					/>
				</Field>
				{step.on_failure === "retry" ? (
					<Field label={t("routines.stepCommonFields.retryTimes")}>
						<NumInput
							value={retry?.times}
							onChange={(v) => {
								if (v === undefined) {
									clear("retry");
									return;
								}
								const next: RoutineRetryPolicy = retry
									? { ...retry, times: v }
									: { times: v, backoff: "linear" };
								set("retry", next);
							}}
							placeholder="3"
						/>
					</Field>
				) : null}
			</div>
			{step.on_failure === "retry" ? (
				<div className="grid grid-cols-2 gap-2">
					<Field label={t("routines.stepCommonFields.retryBackoff")}>
						<select
							value={retry?.backoff ?? "linear"}
							onChange={(e) => {
								const backoff = e.target.value as "linear" | "exponential";
								const next: RoutineRetryPolicy = retry
									? { ...retry, backoff }
									: { times: 3, backoff };
								set("retry", next);
							}}
							className="field h-7 w-full px-2 font-mono text-2xs"
						>
							<option value="linear">linear</option>
							<option value="exponential">exponential</option>
						</select>
					</Field>
					<Field label={t("routines.stepCommonFields.retryMaxDelaySecs")}>
						<NumInput
							value={retry?.max_delay_secs}
							onChange={(v) => {
								if (!retry) return;
								const next: RoutineRetryPolicy = { ...retry };
								if (v === undefined) delete next.max_delay_secs;
								else next.max_delay_secs = v;
								set("retry", next);
							}}
							placeholder="60"
						/>
					</Field>
				</div>
			) : null}
		</div>
	);
}
