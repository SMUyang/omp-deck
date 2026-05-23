/**
 * T-65: categorized add-step palette pinned to the top-left corner of the
 * canvas viewport. Replaces the horizontal-scroll toolbar from T-64 with a
 * single discoverable trigger button + a vertical popover that groups step
 * types into Compute / I/O / Deck Read / Deck Write / File / Control.
 *
 * Discoverability: one button, one click, scannable categories. The popover
 * closes on outside-click and Escape, and each row shows the step's help text
 * inline so the author doesn't have to hover for a tooltip.
 */

import { useEffect, useRef, useState } from "react";
import { ChevronDown, Plus } from "lucide-react";

import type { RoutineDeckAction, RoutineStep } from "@omp-deck/protocol";

import { STEP_CATEGORIES } from "./step-categories";

interface AddStepPaletteProps {
	onAdd: (
		type: RoutineStep["type"],
		presetAction?: RoutineDeckAction,
		presetKind?: "if",
	) => void;
}

export function AddStepPalette({ onAdd }: AddStepPaletteProps): JSX.Element {
	const [open, setOpen] = useState(false);
	const wrapRef = useRef<HTMLDivElement | null>(null);

	// Close on outside click + Escape so the popover behaves like a menu.
	useEffect(() => {
		if (!open) return;
		function onDocPointer(e: MouseEvent | TouchEvent) {
			if (!wrapRef.current) return;
			if (wrapRef.current.contains(e.target as Node)) return;
			setOpen(false);
		}
		function onKey(e: KeyboardEvent) {
			if (e.key === "Escape") setOpen(false);
		}
		document.addEventListener("mousedown", onDocPointer);
		document.addEventListener("touchstart", onDocPointer);
		document.addEventListener("keydown", onKey);
		return () => {
			document.removeEventListener("mousedown", onDocPointer);
			document.removeEventListener("touchstart", onDocPointer);
			document.removeEventListener("keydown", onKey);
		};
	}, [open]);

	function pick(
		type: RoutineStep["type"],
		presetAction?: RoutineDeckAction,
		presetKind?: "if",
	) {
		onAdd(type, presetAction, presetKind);
		setOpen(false);
	}

	return (
		<div
			ref={wrapRef}
			className="pointer-events-auto absolute left-3 top-3 z-20"
			data-testid="add-step-palette"
		>
			<button
				type="button"
				onClick={() => setOpen((o) => !o)}
				aria-expanded={open}
				aria-haspopup="menu"
				aria-label="Add a routine step"
				className="flex h-8 items-center gap-1.5 rounded border border-line bg-paper px-2.5 font-mono text-2xs uppercase tracking-meta text-ink-2 shadow-sm hover:text-ink"
			>
				<Plus className="h-3.5 w-3.5 text-accent" />
				Add step
				<ChevronDown
					className={`h-3 w-3 text-ink-3 transition-transform ${open ? "rotate-180" : ""}`}
				/>
			</button>
			{open ? (
				<div
					role="menu"
					aria-label="Step type"
					className="mt-1 max-h-[70vh] w-[320px] overflow-y-auto rounded border border-line bg-paper shadow-xl"
				>
					{STEP_CATEGORIES.map((cat, i) => (
						<div
							key={cat.key}
							className={i === 0 ? "" : "border-t border-line"}
						>
							<div className="bg-paper-2/60 px-2.5 pb-1 pt-1.5">
								<div className="font-mono text-2xs uppercase tracking-meta text-ink-3">
									{cat.label}
								</div>
								<div className="text-2xs text-ink-4">{cat.tagline}</div>
							</div>
							<div className="py-1">
								{cat.entries.map((entry) => (
									<button
										key={entry.key}
										type="button"
										role="menuitem"
										onClick={() => pick(entry.value, entry.presetAction, entry.presetKind)}
										aria-label={`Add ${entry.label} step`}
										className="flex w-full items-start gap-2 px-2.5 py-1.5 text-left hover:bg-paper-3"
									>
										<span className="shrink-0 pt-px font-mono text-2xs uppercase tracking-meta text-accent">
											{entry.label}
										</span>
										<span className="text-2xs leading-snug text-ink-2">
											{entry.help}
										</span>
									</button>
								))}
							</div>
						</div>
					))}
				</div>
			) : null}
		</div>
	);
}
