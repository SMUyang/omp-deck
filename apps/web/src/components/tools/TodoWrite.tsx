import type { ToolRendererProps } from "./ToolCallCard";
import { extractResultText } from "./shared";
import { cn } from "@/lib/utils";
import { useTranslation } from "react-i18next";

interface Op {
	op: string;
	task?: string;
	phase?: string;
	text?: string;
	items?: string[];
}

const OP_TONE: Record<string, string> = {
	init: "text-accent",
	start: "text-accent",
	done: "text-success",
	rm: "text-ink-3",
	drop: "text-warn",
	append: "text-accent",
	note: "text-ink-3",
};

export function TodoWriteTool({ args, stream }: ToolRendererProps) {
	const { t } = useTranslation();
	const ops = Array.isArray((args as { ops?: Op[] }).ops) ? ((args as { ops: Op[] }).ops) : [];
	const result = stream?.result;
	const resultText = result ? extractResultText(result) : "";

	return (
		<div className="space-y-1">
			<ul className="space-y-0.5 text-[13px]">
				{ops.map((op, i) => (
					<li key={i} className="flex items-start gap-2">
						<span className={cn("min-w-[44px] shrink-0 font-mono text-2xs uppercase tracking-meta", OP_TONE[op.op] ?? "text-ink-3")}>
							{t(`tools.todoWrite.op.${op.op}`, { defaultValue: op.op })}
						</span>
						<div className="min-w-0 flex-1">
							{op.phase ? <span className="text-thinking font-mono text-xs">{op.phase}</span> : null}
							{op.phase && (op.task || op.text || op.items) ? <span className="text-ink-3"> · </span> : null}
							{op.task ? <span className="text-ink">{op.task}</span> : null}
							{op.text ? <span className="text-ink-3"> — {op.text}</span> : null}
							{op.items ? (
								<ul className="ml-3 mt-0.5 list-disc text-ink-2">
									{op.items.map((it, j) => (
										<li key={j}>{it}</li>
									))}
								</ul>
							) : null}
						</div>
					</li>
				))}
			</ul>
			{resultText ? (
				<div className="font-mono text-2xs text-ink-3">{resultText}</div>
			) : null}
		</div>
	);
}
