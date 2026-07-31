import { memo, useState } from "react";
import { ChevronRight } from "lucide-react";
import type { CompactionMsg } from "@/lib/types";
import { cn } from "@/lib/utils";

export const CompactionLine = memo(function CompactionLine({ msg }: { msg: CompactionMsg }) { const [open, setOpen] = useState(false);
	return (
		<div className="border-l-2 border-warn">
			<button
				type="button"
				onClick={() => setOpen((v) => !v)}
				className="flex w-full items-center gap-1.5 pl-2 py-0.5 text-left font-mono text-2xs uppercase tracking-meta text-warn hover:text-warn/80"
			>
				<ChevronRight className={cn("h-3 w-3 shrink-0 transition-transform", open && "rotate-90")} />
				<span>compacted</span>
				<span className="text-ink-3 normal-case tracking-normal">
					· {msg.action} · {msg.reason}
				</span>
			</button>
			{open ? (
				<div className="whitespace-pre-wrap pl-2 pt-1 pb-2 text-[13px] text-ink-2">
					{msg.summary || "(no summary)"}
				</div>
			) : null}
		</div>
	); });
