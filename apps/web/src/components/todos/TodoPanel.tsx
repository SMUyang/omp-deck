import type { TodoPhase, TodoTask } from "@/lib/types";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";

interface Props {
	phases: TodoPhase[];
}

const STATUS_GLYPH: Record<string, string> = {
	pending: "○",
	in_progress: "◐",
	completed: "●",
	dropped: "⊘",
	error: "✗",
};

const STATUS_TONE: Record<string, string> = {
	pending: "text-ink-4",
	in_progress: "text-accent",
	completed: "text-success",
	dropped: "text-warn",
	error: "text-danger",
};

export function TodoPanel({ phases }: Props) {
	const { t } = useTranslation();
	const total = phases.reduce((a, p) => a + p.tasks.length, 0);

	if (!phases || phases.length === 0) {
		return (
			<section className="border-b border-line px-4 py-4">
				<div className="meta mb-2">{t("tasks.todoPanel.title")}</div>
				<div className="font-mono text-2xs text-ink-3">{t("tasks.todoPanel.empty")}</div>
			</section>
		);
	}

	return (
		<section className="border-b border-line px-4 py-4">
			<div className="meta mb-2 flex items-center justify-between">
				<span>{t("tasks.todoPanel.title")}</span>
				<span className="text-ink-3 normal-case tracking-normal">{total}</span>
			</div>
			<div className="space-y-3">
				{phases.map((phase, i) => (
					<div key={phase.id ?? i}>
						{phase.name ? (
							<div className="meta mb-1 text-ink-2">{phase.name}</div>
						) : null}
						<ul className="space-y-0.5">
							{phase.tasks.map((t, j) => (
								<TaskRow key={t.id ?? j} task={t} />
							))}
						</ul>
					</div>
				))}
			</div>
		</section>
	);
}

function TaskRow({ task }: { task: TodoTask }) {
	const glyph = STATUS_GLYPH[task.status] ?? STATUS_GLYPH.pending ?? "○";
	const tone = STATUS_TONE[task.status] ?? STATUS_TONE.pending ?? "text-ink-4";
	return (
		<li className="flex items-start gap-2 text-[13px]">
			<span
				className={cn("mt-0.5 inline-block w-3 shrink-0 text-center font-mono text-xs", tone)}
				aria-hidden="true"
			>
				{glyph}
			</span>
			<span
				className={cn(
					"min-w-0 flex-1",
					task.status === "completed" && "text-ink-3 line-through",
					task.status === "dropped" && "text-ink-4 line-through",
				)}
			>
				{task.content}
				{task.notes && task.notes.length > 0 ? (
					<ul className="mt-0.5 ml-2 list-disc font-mono text-2xs text-ink-3">
						{task.notes.map((n, k) => (
							<li key={k}>{n}</li>
						))}
					</ul>
				) : null}
			</span>
		</li>
	);
}
