import { useEffect, useState } from "react";
import { Plus, Trash2, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { TaskState } from "@omp-deck/protocol";
import { tasksApi } from "@/lib/tasks-api";

interface Props {
	states: TaskState[];
	onClose: () => void;
	onChanged: () => void;
}

const PRESET_COLORS = [
	"#6e6a62",
	"#9a3412",
	"#b45309",
	"#15803d",
	"#6b21a8",
	"#0e7490",
	"#991b1b",
];

/** Inline drawer to manage kanban columns: add / rename / recolor / delete. */
export function StateConfig({ states, onClose, onChanged }: Props) {
	const { t } = useTranslation();
	const [newName, setNewName] = useState("");
	const [busy, setBusy] = useState(false);
	const [err, setErr] = useState<string | undefined>();

	useEffect(() => setErr(undefined), [states.length]);

	async function add(): Promise<void> {
		const name = newName.trim();
		if (!name) return;
		setBusy(true);
		try {
			await tasksApi.createState({ name });
			setNewName("");
			onChanged();
		} catch (e) {
			setErr(String(e));
		} finally {
			setBusy(false);
		}
	}

	async function rename(state: TaskState, name: string): Promise<void> {
		const trimmed = name.trim();
		if (!trimmed || trimmed === state.name) return;
		try {
			await tasksApi.updateState(state.id, { name: trimmed });
			onChanged();
		} catch (e) {
			setErr(String(e));
		}
	}

	async function recolor(state: TaskState, color: string): Promise<void> {
		try {
			await tasksApi.updateState(state.id, { color });
			onChanged();
		} catch (e) {
			setErr(String(e));
		}
	}

	async function remove(state: TaskState): Promise<void> {
		if (state.isDefault) return;
		if (!confirm(t("tasks.stateConfig.deleteColumnConfirm", { name: state.name }))) return;
		try {
			await tasksApi.removeState(state.id);
			onChanged();
		} catch (e) {
			setErr(String(e));
		}
	}

	return (
		<div className="flex h-full flex-col">
			<div className="flex h-11 items-center gap-2 border-b border-line px-3">
				<div className="meta">{t("tasks.stateConfig.columns")}</div>
				<button
					type="button"
					onClick={onClose}
					className="btn-ghost ml-auto h-7 w-7 p-0"
					aria-label={t("tasks.stateConfig.close")}
				>
					<X className="h-4 w-4" />
				</button>
			</div>

			<div className="flex-1 overflow-y-auto p-3">
				<ul className="space-y-3">
					{states.map((s) => (
						<li key={s.id} className="border border-line bg-paper-2 px-3 py-2">
							<div className="flex items-center gap-2">
								<input
									defaultValue={s.name}
									onBlur={(e) => void rename(s, e.target.value)}
									onKeyDown={(e) => {
										if (e.key === "Enter") (e.target as HTMLInputElement).blur();
									}}
									className="field h-7 flex-1 px-2 text-sm"
								/>
								{s.isDefault ? (
									<span className="font-mono text-2xs text-ink-4">{t("tasks.stateConfig.default")}</span>
								) : (
									<button
										type="button"
										onClick={() => void remove(s)}
										className="text-ink-3 hover:text-danger"
										aria-label={t("tasks.stateConfig.deleteColumn")}
										title={t("tasks.stateConfig.deleteColumn")}
									>
										<Trash2 className="h-3.5 w-3.5" />
									</button>
								)}
							</div>
							<div className="mt-2 flex items-center gap-1.5">
								{PRESET_COLORS.map((c) => (
									<button
										key={c}
										type="button"
										onClick={() => void recolor(s, c)}
										title={c}
										aria-label={t("tasks.stateConfig.setColor", { color: c })}
										className={
											"h-4 w-4 rounded-full border border-line-strong"
										}
										style={{
											backgroundColor: c,
											boxShadow:
												s.color === c ? "0 0 0 2px var(--paper), 0 0 0 3px var(--ink)" : undefined,
										}}
									/>
								))}
							</div>
						</li>
					))}
				</ul>

				<div className="mt-4 border border-line bg-paper-2 px-3 py-2">
					<div className="meta mb-1.5">{t("tasks.stateConfig.addColumn")}</div>
					<div className="flex items-center gap-1.5">
						<input
							value={newName}
							onChange={(e) => setNewName(e.target.value)}
							onKeyDown={(e) => {
								if (e.key === "Enter") void add();
							}}
							placeholder={t("tasks.stateConfig.columnNamePlaceholder")}
							className="field h-7 flex-1 px-2 text-sm"
						/>
						<button
							type="button"
							onClick={() => void add()}
							disabled={busy || newName.trim().length === 0}
							className="btn-primary h-7 px-2 text-xs"
						>
							<Plus className="h-3.5 w-3.5" />
							{t("tasks.stateConfig.add")}
						</button>
					</div>
				</div>

				{err ? <div className="mt-3 text-xs text-danger">{err}</div> : null}
			</div>
		</div>
	);
}
