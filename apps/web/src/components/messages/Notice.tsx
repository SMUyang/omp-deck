import type { NoticeMsg } from "@/lib/types";
import { memo } from "react";
import { cn } from "@/lib/utils";

const TONE: Record<NoticeMsg["level"], string> = {
	info: "border-ink/30 text-ink-2",
	warning: "border-warn text-warn",
	error: "border-danger text-danger",
};

export const Notice = memo(function Notice({ msg }: { msg: NoticeMsg }) { const tone = TONE[msg.level] ?? TONE.info;
	return (
		<div className={cn("border-l-2 pl-3 py-1 text-[13px]", tone)}>
			{msg.source ? (
				<span className="mr-2 font-mono text-2xs uppercase tracking-meta opacity-75">
					{msg.source}
				</span>
			) : null}
			<span className="text-ink-2">{msg.message}</span>
		</div>
	); });
