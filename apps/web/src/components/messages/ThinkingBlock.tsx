import { memo, useState } from "react";
import { ChevronRight } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Markdown } from "@/lib/markdown";
import { cn } from "@/lib/utils";

export const ThinkingBlock = memo(function ThinkingBlock({
	text,
	streaming,
	redacted,
}: {
	text: string;
	streaming?: boolean;
	redacted?: boolean;
}) { const { t } = useTranslation(); const [open, setOpen] = useState(Boolean(streaming));
	const lines = text.split(/\r?\n/).length;
	return (
		<div className="border-l-2 border-line-strong">
			<button
				type="button"
				onClick={() => setOpen((v) => !v)}
				className="flex w-full items-center gap-1.5 pl-2 py-0.5 text-left font-mono text-2xs uppercase tracking-meta text-thinking hover:text-thinking/80"
			>
				<ChevronRight
					className={cn("h-3 w-3 shrink-0 transition-transform", open && "rotate-90")}
				/>
				<span>{redacted ? t("messages.thinkingBlock.redacted") : t("messages.thinkingBlock.thinking")}</span>
				<span className="text-ink-3 normal-case tracking-normal">
					{t("messages.thinkingBlock.lines", { count: lines })}
				</span>
				{streaming ? <span className="text-accent">{t("messages.thinkingBlock.live")}</span> : null}
			</button>
			{open ? (
				<div className="pl-2 pt-1 pb-2">
					<Markdown className="text-[13px] text-ink-2" streaming={streaming}>
						{text}
					</Markdown>
				</div>
			) : null}
		</div>
	); });
