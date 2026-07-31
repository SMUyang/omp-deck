import { memo, useState } from "react";
import { ChevronRight } from "lucide-react";
import type { IrcMsg } from "@/lib/types";
import { ircGroupSenders } from "@/lib/chat-items";
import { cn } from "@/lib/utils";
import { IrcLine } from "./IrcLine";

/**
 * Collapsed container for a run of consecutive subagent/IRC messages.
 * Keeps delegation chatter one click away without flooding the main
 * conversation: the header shows count + senders; expanding reveals the
 * individual (still individually collapsed) lines.
 */
export const IrcGroup = memo(function IrcGroup({ msgs }: { msgs: IrcMsg[] }) { const [open, setOpen] = useState(false);
	const senders = ircGroupSenders(msgs);
	const shown = senders.slice(0, 3).join(", ");
	const more = senders.length > 3 ? ` +${senders.length - 3}` : "";

	return (
		<div className="rounded-md border border-line bg-paper-2/60">
			<button
				type="button"
				onClick={() => setOpen((v) => !v)}
				className="flex w-full items-center gap-1.5 px-2.5 py-1.5 text-left font-mono text-2xs uppercase tracking-meta text-ink-3 hover:text-ink-2"
			>
				<ChevronRight className={cn("h-3 w-3 shrink-0 transition-transform", open && "rotate-90")} />
				<span>
					subagent activity · {msgs.length} message{msgs.length === 1 ? "" : "s"}
				</span>
				{shown ? (
					<span className="truncate normal-case tracking-normal text-ink-4">
						{shown}
						{more}
					</span>
				) : null}
			</button>
			{open ? (
				<div className="space-y-1 border-t border-line px-2.5 py-2">
					{msgs.map((m) => (
						<IrcLine key={m.id} msg={m} />
					))}
				</div>
			) : null}
		</div>
	); });
