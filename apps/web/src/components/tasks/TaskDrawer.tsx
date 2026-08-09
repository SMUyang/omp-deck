import { useEffect, useState } from "react";
import { Trash2, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { Task, TaskState } from "@omp-deck/protocol";
import { cn } from "@/lib/utils";

interface Props {
	task: Task;
	states: TaskState[];
	onClose: () => void;
	onSave: (patch: { title?: string; body?: string; stateId?: string }) => void;
	onDelete: () => void;
	onArchive: () => void;
	onOpenInChat: () => void;
}

export function TaskDrawer({ task, states, onClose, onSave, onDelete, onArchive, onOpenInChat }: Props) {
	const { t } = useTranslation();
	const [title, setTitle] = useState(task.title);
	const [body, setBody] = useState(task.body);
	const [stateId, setStateId] = useState(task.stateId);
	const [dirty, setDirty] = useState(false);

	useEffect(() => {
		setTitle(task.title);
		setBody(task.body);
		setStateId(task.stateId);
		setDirty(false);
	}, [task]);

	function maybeSave(): void {
		if (!dirty) return;
		const patch: { title?: string; body?: string; stateId?: string } = {};
		if (title !== task.title) patch.title = title;
		if (body !== task.body) patch.body = body;
		if (stateId !== task.stateId) patch.stateId = stateId;
		if (Object.keys(patch).length > 0) onSave(patch);
	}

	useEffect(() => {
		function onKey(e: KeyboardEvent): void {
			if (e.key === "Escape") {
				maybeSave();
				onClose();
			}
			if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
				maybeSave();
			}
		}
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [dirty, title, body, stateId]);

	return (
		<div className="flex h-full flex-col">
			<div className="flex h-11 items-center gap-2 border-b border-line px-3">
				<span
					className="shrink-0 font-mono text-2xs uppercase tracking-meta text-ink-3"
					title={task.id}
				>
					T-{task.displayId}
				</span>
				<input
					value={title}
					onChange={(e) => {
						setTitle(e.target.value);
						setDirty(true);
					}}
					onBlur={maybeSave}
					placeholder={t("tasks.drawer.untitled")}
					className="flex-1 bg-transparent text-base font-medium text-ink placeholder:text-ink-4 focus:outline-none"
				/>
				<button
					type="button"
					onClick={() => {
						maybeSave();
						onClose();
					}}
					className="btn-ghost h-7 w-7 p-0"
					aria-label={t("tasks.drawer.close")}
				>
					<X className="h-4 w-4" />
				</button>
			</div>

			<div className="border-b border-line px-3 py-2">
				<div className="flex items-center gap-2 font-mono text-2xs">
					<span className="text-ink-3">{t("tasks.drawer.state")}</span>
					<select
						value={stateId}
						onChange={(e) => {
							setStateId(e.target.value);
							setDirty(true);
						}}
						onBlur={maybeSave}
						className="field h-6 px-2 text-xs"
					>
						{states.map((s) => (
							<option key={s.id} value={s.id}>
								{s.name}
							</option>
						))}
					</select>
					<span className="ml-auto text-ink-4">
						{t("tasks.drawer.updated", { time: new Date(task.updatedAt).toLocaleString() })}
					</span>
				</div>
			</div>

			<div className="flex-1 overflow-y-auto">
				<textarea
					value={body}
					onChange={(e) => {
						setBody(e.target.value);
						setDirty(true);
					}}
					onBlur={maybeSave}
					placeholder={t("tasks.drawer.notesPlaceholder")}
					className="h-full w-full resize-none bg-transparent px-4 py-3 text-sm text-ink placeholder:text-ink-4 focus:outline-none"
				/>
			</div>

			<div className="flex shrink-0 items-center justify-between gap-2 border-t border-line bg-paper px-3 py-2">
				<button type="button" onClick={onDelete} className="btn-ghost text-danger text-xs">
					<Trash2 className="h-3.5 w-3.5" />
					{t("tasks.drawer.delete")}
				</button>
				<div className="flex items-center gap-1.5">
					<button
						type="button"
						onClick={() => {
							maybeSave();
							onArchive();
						}}
						className="btn-ghost text-xs"
					>
						{task.archivedAt ? t("tasks.drawer.unarchive") : t("tasks.drawer.archive")}
					</button>
					<button
						type="button"
						onClick={() => {
							maybeSave();
							onOpenInChat();
						}}
						className={cn("btn-primary text-xs")}
					>
						{t("tasks.drawer.openInChat")}
					</button>
				</div>
			</div>
		</div>
	);
}
