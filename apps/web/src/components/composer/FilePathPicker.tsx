import { useEffect, useRef } from "react";
import { FileIcon, FolderIcon } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { FilePathMatch } from "@omp-deck/protocol";
import { cn } from "@/lib/utils";

interface Props {
	matches: FilePathMatch[];
	selectedIndex: number;
	onPick: (match: FilePathMatch) => void;
	onSelectionChange: (index: number) => void;
}

/**
 * Autocomplete dropdown anchored above the composer when the cursor sits
 * inside an `@<token>` mention. Filtering happens server-side; this component
 * just renders the candidate list and is keyboard-driven by the textarea's
 * own `handleKey` (Arrow / Enter / Tab / Esc) — mirrors `SlashCommandPicker`'s
 * controlled-from-outside contract so the composer only ever has one source
 * of keyboard truth.
 *
 * Renders nothing when there are no matches so the composer can drop it in
 * unconditionally and let it self-hide.
 */
export function FilePathPicker({
	matches,
	selectedIndex,
	onPick,
	onSelectionChange,
}: Props) {
	const { t } = useTranslation();
	const listRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		const el = listRef.current?.children[selectedIndex] as HTMLElement | undefined;
		el?.scrollIntoView({ block: "nearest" });
	}, [selectedIndex]);

	if (matches.length === 0) return null;

	return (
		<div
			role="listbox"
			aria-label={t("core.filePathPicker.filePaths")}
			className={cn(
				"absolute bottom-full left-0 right-0 mb-1 max-h-[280px] overflow-y-auto",
				"rounded-md border border-line bg-paper-2 shadow-[0_8px_24px_-8px_rgba(26,24,20,0.25)]",
				"font-mono text-[13px]",
			)}
		>
			<div ref={listRef}>
				{matches.map((m, i) => {
					const active = i === selectedIndex;
					const segments = m.path.split("/");
					const parent = segments.slice(0, -1).join("/");
					const Icon = m.isDir ? FolderIcon : FileIcon;
					return (
						<button
							key={m.path}
							type="button"
							role="option"
							aria-selected={active}
							onClick={() => onPick(m)}
							onMouseEnter={() => onSelectionChange(i)}
							// Prevent textarea blur that would dismiss the picker before onClick fires.
							onMouseDown={(e) => e.preventDefault()}
							className={cn(
								"flex w-full items-center gap-2 px-3 py-1.5 text-left",
								active ? "bg-accent-soft/60" : "hover:bg-paper-3/60",
							)}
						>
							<Icon
								className={cn(
									"h-3.5 w-3.5 shrink-0",
									m.isDir ? "text-accent" : "text-ink-3",
								)}
							/>
							<div className="min-w-0 flex-1 truncate">
								<span className={cn("font-medium", active ? "text-accent" : "text-ink")}>
									{m.name}
									{m.isDir ? "/" : ""}
								</span>
								{parent ? (
									<span className="ml-2 truncate font-mono text-2xs text-ink-3">
										{parent}/
									</span>
								) : null}
							</div>
						</button>
					);
				})}
			</div>
			<div className="border-t border-line bg-paper px-3 py-1 font-mono text-2xs text-ink-3">
				{t("core.filePathPicker.footer")}
			</div>
		</div>
	);
}
