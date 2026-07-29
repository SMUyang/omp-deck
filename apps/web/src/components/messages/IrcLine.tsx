import { useState } from "react";
import { ChevronRight } from "lucide-react";
import type { IrcMsg } from "@/lib/types";
import { Markdown } from "@/lib/markdown";
import { cn } from "@/lib/utils";

const PREVIEW_LEN = 100;

/**
 * Single subagent/IRC line. Subagent→parent hub messages carry full agent
 * outputs (often several KB), so the line stays collapsed by default: a
 * one-line sender + size + text preview. Click expands the full content.
 */
export function IrcLine({ msg }: { msg: IrcMsg }) {
	const [open, setOpen] = useState(false);
	const preview = firstLine(msg.content);
	const sizeKb = msg.content.length > 512 ? ` · ${(msg.content.length / 1024).toFixed(1)} KB` : "";

	return (
		<div className="border-l-2 border-line pl-2 py-0.5">
			<button
				type="button"
				onClick={() => setOpen((v) => !v)}
				className="flex w-full items-center gap-1.5 text-left font-mono text-2xs text-ink-3 hover:text-ink-2"
			>
				<ChevronRight className={cn("h-3 w-3 shrink-0 transition-transform", open && "rotate-90")} />
				<span className="shrink-0 uppercase tracking-meta">
					irc{msg.from ? ` · ${msg.from}` : ""}
					{sizeKb}
				</span>
				{!open && preview ? (
					<span className="truncate normal-case tracking-normal text-ink-4">{preview}</span>
				) : null}
			</button>
			{open ? (
				<div className="pl-2 pt-1 pb-1">
					<Markdown className="text-[13px]">{msg.content}</Markdown>
				</div>
			) : null}
		</div>
	);
}

function firstLine(content: string): string {
	for (const raw of content.split(/\r?\n/)) {
		const line = raw.trim();
		if (line.length === 0) continue;
		return line.length > PREVIEW_LEN ? `${line.slice(0, PREVIEW_LEN)}…` : line;
	}
	return "";
}
