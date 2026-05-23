import { useState } from "react";
import { ChevronDown, ChevronRight, ChevronsDown, ChevronsUp, Trash2 } from "lucide-react";

import type { RoutineStep } from "@omp-deck/protocol";

import { StepCommonFields } from "./StepCommonFields";
import { STEP_TYPE_BG, renderStepForm } from "./step-form-render";

interface Props {
	step: RoutineStep;
	index: number;
	total: number;
	existingIds: string[];
	onChange: (next: RoutineStep) => void;
	onRemove: () => void;
	onMoveUp: () => void;
	onMoveDown: () => void;
}



export function StepCard({
	step,
	index,
	total,
	existingIds,
	onChange,
	onRemove,
	onMoveUp,
	onMoveDown,
}: Props) {
	const [open, setOpen] = useState(true);
	const idsExcludingSelf = existingIds.filter((_id, i) => i !== index);

	return (
		<div className="rounded border border-line bg-paper-2">
			<div className="flex items-center gap-1 border-b border-line px-1.5 py-1">
				<button
					type="button"
					onClick={() => setOpen((o) => !o)}
					className="btn-ghost h-6 w-6 p-0"
					aria-label={open ? "Collapse" : "Expand"}
				>
					{open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
				</button>
				<span className={`rounded px-1.5 py-0.5 font-mono text-2xs uppercase tracking-meta ${STEP_TYPE_BG[step.type]}`}>
					{step.type}
				</span>
				<span className="font-mono text-2xs text-ink-2">{step.id || "(no id)"}</span>
				<div className="ml-auto flex items-center gap-0.5">
					<button
						type="button"
						onClick={onMoveUp}
						disabled={index === 0}
						className="btn-ghost h-6 w-6 p-0 disabled:opacity-30"
						aria-label="Move up"
						title="Move up"
					>
						<ChevronsUp className="h-3.5 w-3.5" />
					</button>
					<button
						type="button"
						onClick={onMoveDown}
						disabled={index === total - 1}
						className="btn-ghost h-6 w-6 p-0 disabled:opacity-30"
						aria-label="Move down"
						title="Move down"
					>
						<ChevronsDown className="h-3.5 w-3.5" />
					</button>
					<button
						type="button"
						onClick={onRemove}
						className="btn-ghost h-6 w-6 p-0 text-ink-4 hover:text-danger"
						aria-label="Remove step"
						title="Remove"
					>
						<Trash2 className="h-3.5 w-3.5" />
					</button>
				</div>
			</div>
			{open ? (
				<div className="space-y-2 p-2">
					<StepCommonFields step={step} onChange={onChange} existingIds={idsExcludingSelf} />
					{renderStepForm(step, onChange)}
				</div>
			) : null}
		</div>
	);
}
