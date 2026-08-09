import { useStore } from "@/lib/store";
import { ChevronRight, Loader2 } from "lucide-react";
import type { ToolCallStream } from "@/lib/types";
import { cn, formatDurationMs, truncate } from "@/lib/utils";
import { useTranslation } from "react-i18next";

import { ReadTool } from "./Read";
import { WriteTool } from "./Write";
import { EditTool } from "./Edit";
import { BashTool } from "./Bash";
import { SearchTool } from "./Search";
import { LspTool } from "./Lsp";
import { TaskTool } from "./Task";
import { WebSearchTool } from "./WebSearch";
import { EvalTool } from "./Eval";
import { TodoWriteTool } from "./TodoWrite";
import { GenerateImageTool } from "./GenerateImage";
import { BrowserTool } from "./Browser";
import { GenericTool } from "./Generic";

export interface ToolRendererProps {
	toolCallId: string;
	name: string;
	args: Record<string, unknown>;
	intent?: string;
	stream?: ToolCallStream;
}

const DOT_TONE = {
	running: "bg-line-strong",
	complete: "bg-success",
	error: "bg-danger",
} as const;

export function ToolCallCard(props: ToolRendererProps) {
	const { t } = useTranslation();
	const { toolCallId, name, intent, stream, args } = props;
	const open = useStore(
		(s) => s.toolView.perCard[toolCallId] ?? !s.toolView.allCollapsed,
	);
	const setToolCardOpen = useStore((s) => s.setToolCardOpen);
	const status = stream?.status ?? "running";
	const isError = stream?.isError ?? false;
	const dot = isError ? DOT_TONE.error : DOT_TONE[status];
	const duration =
		stream?.endedAt && stream.startedAt ? stream.endedAt - stream.startedAt : undefined;

	const summary = summarizeArgs(name, args, intent);

	return (
		<div className="-mx-1">
			<button
				type="button"
				onClick={() => setToolCardOpen(toolCallId, !open)}
				className="flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left font-mono text-xs hover:bg-paper-3/60"
			>
				<ChevronRight
					className={cn("h-3 w-3 shrink-0 text-ink-3 transition-transform", open && "rotate-90")}
				/>
				<span
					className={cn("h-1.5 w-1.5 shrink-0 rounded-full", dot)}
					aria-hidden="true"
				/>
				<span className="font-medium text-ink">{name}</span>
				{summary ? (
					<span className="truncate text-ink-3">{summary}</span>
				) : null}
				<span className="ml-auto flex items-center gap-2 text-ink-3">
					{status === "running" ? (
						<Loader2 className="h-3 w-3 animate-spin text-accent" />
					) : (
						<span className={isError ? "text-danger" : "text-ink-4"}>
							{isError ? t("tools.toolCallCard.error") : t("tools.toolCallCard.done")}
						</span>
					)}
					{duration !== undefined ? (
						<span className="text-ink-4">{formatDurationMs(duration)}</span>
					) : null}
				</span>
			</button>
			{open ? (
				<div className="ml-3 mt-1 border-l border-line pl-3">
					{renderTool(name, props)}
				</div>
			) : null}
		</div>
	);
}

function summarizeArgs(name: string, args: Record<string, unknown>, intent?: string): string {
	if (intent) return intent;
	// Tool-specific quick summaries shown in collapsed header.
	switch (name) {
		case "read":
		case "write":
		case "edit": {
			const p = args.path as string | undefined;
			return p ? truncate(p, 60) : "";
		}
		case "bash":
			return truncate(String(args.command ?? ""), 60);
		case "search":
		case "find":
			return truncate(String(args.pattern ?? args.paths ?? ""), 60);
		case "lsp": {
			const action = String(args.action ?? "");
			const symbol = (args.symbol as string | undefined) ?? (args.query as string | undefined) ?? "";
			return [action, symbol].filter(Boolean).join(" · ");
		}
		case "web_search":
			return truncate(String(args.query ?? ""), 60);
		case "task":
			return String(args.agent ?? "");
		case "generate_image":
			return truncate(String(args.subject ?? ""), 60);
		case "todo_write": {
			const ops = Array.isArray((args as { ops?: unknown[] }).ops)
				? (args as { ops: { op?: string }[] }).ops
				: [];
			return ops
				.map((o) => o.op)
				.filter(Boolean)
				.slice(0, 4)
				.join(", ");
		}
		default:
			return "";
	}
}

function renderTool(name: string, props: ToolRendererProps) {
	switch (name) {
		case "read":
			return <ReadTool {...props} />;
		case "write":
			return <WriteTool {...props} />;
		case "edit":
			return <EditTool {...props} />;
		case "bash":
			return <BashTool {...props} />;
		case "search":
		case "find":
			return <SearchTool {...props} />;
		case "lsp":
			return <LspTool {...props} />;
		case "task":
			return <TaskTool {...props} />;
		case "web_search":
			return <WebSearchTool {...props} />;
		case "eval":
			return <EvalTool {...props} />;
		case "todo_write":
			return <TodoWriteTool {...props} />;
		case "generate_image":
			return <GenerateImageTool {...props} />;
		case "browser":
			return <BrowserTool {...props} />;
		default:
			return <GenericTool {...props} />;
	}
}
