import { useState } from "react";
import {
	SortableContext,
	useSortable,
	verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical, Plus } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { Task, TaskState } from "@omp-deck/protocol";
import { cn } from "@/lib/utils";
import { TaskCard } from "./TaskCard";

interface Props {
	state: TaskState;
	tasks: Task[];
	onCreate: (stateId: string, title: string) => void;
	onOpen: (task: Task) => void;
	onRenameRequest?: (state: TaskState) => void;
	isDraggingColumns: boolean;
}

/**
 * One kanban column.
 *
 * `useSortable` makes the column itself a drag source within the horizontal
 * `SortableContext` in `TasksView`; `data: { type: "column" }` is what
 * `onDragStart` / `onDragEnd` branch on to tell column reorders apart from
 * task drags. `useSortable` already registers the node as a droppable, so a
 * task dragged onto a column body still lands here — no second `useDroppable`
 * is needed.
 *
 * The drag handle is a dedicated `GripVertical` icon to the left of the color
 * dot, NOT the whole header — that keeps click-to-rename working on the
 * column name and avoids stealing pointer-down from card drags within the
 * column.
 */
export function Column({
	state,
	tasks,
	onCreate,
	onOpen,
	onRenameRequest,
	isDraggingColumns,
}: Props) {
	const { t } = useTranslation();
	const {
		attributes,
		listeners,
		setNodeRef,
		transform,
		transition,
		isDragging,
		isOver,
	} = useSortable({ id: state.id, data: { type: "column", stateId: state.id } });

	const style: React.CSSProperties = {
		transform: CSS.Translate.toString(transform),
		transition,
		opacity: isDragging ? 0.4 : undefined,
	};

	const [composing, setComposing] = useState(false);
	const [draft, setDraft] = useState("");

	function submit(): void {
		const t = draft.trim();
		if (!t) {
			setComposing(false);
			return;
		}
		onCreate(state.id, t);
		setDraft("");
		setComposing(false);
	}

	// Only highlight as a drop target while a task is being dragged. Column-vs-
	// column drags get their own visual feedback from the sortable transform.
	const showTaskDropHighlight = isOver && !isDragging && !isDraggingColumns;

	return (
		<div
			ref={setNodeRef}
			style={style}
			className={cn(
				"flex w-72 shrink-0 flex-col border-r border-line bg-paper transition-colors",
				showTaskDropHighlight && "bg-accent-soft/40 ring-1 ring-inset ring-accent/40",
			)}
		>
			<div className="sticky top-0 z-10 flex items-center justify-between gap-2 border-b border-line bg-paper px-3 py-2">
				<div className="flex items-center gap-1.5 min-w-0">
					<button
						type="button"
						{...attributes}
						{...listeners}
						className="cursor-grab touch-none text-ink-4 hover:text-ink active:cursor-grabbing"
						aria-label={t("tasks.column.dragToReorderColumn", { name: state.name })}
						title={t("tasks.column.dragToReorder")}
					>
						<GripVertical className="h-3.5 w-3.5" />
					</button>
					<span
						className="h-2 w-2 shrink-0 rounded-full"
						style={{ backgroundColor: state.color }}
						aria-hidden="true"
					/>
					<button
						type="button"
						onClick={() => onRenameRequest?.(state)}
						className="font-mono text-2xs uppercase tracking-meta text-ink-2 hover:text-ink"
						title={t("tasks.column.editColumn")}
					>
						{state.name}
					</button>
					<span className="font-mono text-2xs text-ink-4">{tasks.length}</span>
				</div>
				<button
					type="button"
					onClick={() => setComposing(true)}
					className="text-ink-3 hover:text-ink"
					aria-label={t("tasks.column.addTask")}
					title={t("tasks.column.addTask")}
				>
					<Plus className="h-4 w-4" />
				</button>
			</div>

			<div className="flex-1 overflow-y-auto px-2 py-2">
				<SortableContext items={tasks.map((t) => t.id)} strategy={verticalListSortingStrategy}>
					<div className="flex flex-col gap-1.5">
						{tasks.map((t) => (
							<TaskCard key={t.id} task={t} onOpen={onOpen} />
						))}
					</div>
				</SortableContext>

				{composing ? (
					<div className="mt-2 border border-line bg-paper-2 p-2">
						<textarea
							autoFocus
							rows={2}
							value={draft}
							onChange={(e) => setDraft(e.target.value)}
							onKeyDown={(e) => {
								if (e.key === "Enter" && !e.shiftKey) {
									e.preventDefault();
									submit();
								}
								if (e.key === "Escape") {
									setDraft("");
									setComposing(false);
								}
							}}
							placeholder={t("tasks.column.taskTitlePlaceholder")}
							className="w-full resize-none bg-transparent text-sm placeholder:text-ink-4 focus:outline-none"
						/>
						<div className="mt-1 flex justify-between font-mono text-2xs text-ink-4">
							<span>{t("tasks.column.escCancel")}</span>
							<span>{t("tasks.column.enterToAdd")}</span>
						</div>
					</div>
				) : (
					<button
						type="button"
						onClick={() => setComposing(true)}
						className="mt-2 w-full px-2 py-1.5 text-left font-mono text-2xs text-ink-4 hover:text-ink"
					>
						+ {t("tasks.column.addTask")}
					</button>
				)}
			</div>
		</div>
	);
}
