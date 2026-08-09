import type { ToolRendererProps } from "./ToolCallCard";
import { extractResultText } from "./shared";
import { MaybeJsonBlock } from "@/lib/code";
import { formatCost, formatDurationMs, truncate, cn } from "@/lib/utils";
import { useTranslation } from "react-i18next";

const STATUS_TONE: Record<string, string> = {
	complete: "text-success",
	error: "text-danger",
	running: "text-accent",
	queued: "text-ink-4",
};

export function TaskTool({ args, stream }: ToolRendererProps) {
	const { t } = useTranslation();
	const agent = String((args.agent as string | undefined) ?? "");
	const tasks = Array.isArray(args.tasks) ? (args.tasks as Array<Record<string, unknown>>) : [];

	const result = stream?.result ?? stream?.partialResult;
	const subagents = extractSubagents(result);

	return (
		<div className="space-y-2">
			<div className="font-mono text-2xs">
				<span className="text-accent">{agent || t("tools.task.agentFallback")}</span>
				<span className="text-ink-3"> · {t("tools.task.subagentCount", { count: tasks.length })}</span>
			</div>
			<div className="grid grid-cols-1 gap-1 sm:grid-cols-2">
				{tasks.map((task, i) => {
					const id = String(task?.id ?? `task-${i}`);
					const desc = String(task?.description ?? "");
					const sub = subagents[id];
					const status = sub?.status ?? "queued";
					return (
						<div key={id} className="border-l border-line pl-2">
							<div className="flex items-baseline justify-between gap-2 font-mono text-2xs">
								<span className="truncate font-medium text-ink">{id}</span>
								<span className={cn("shrink-0", STATUS_TONE[status] ?? "text-ink-4")}>
									{t(`tools.task.status.${status}`, { defaultValue: status })}
								</span>
							</div>
							{desc ? (
								<div className="mt-0.5 text-2xs text-ink-3">{truncate(desc, 100)}</div>
							) : null}
							{sub ? (
								<div className="mt-0.5 flex gap-2 font-mono text-2xs text-ink-4">
									{sub.durationMs ? <span>{formatDurationMs(sub.durationMs)}</span> : null}
									{sub.cost ? <span>{formatCost(sub.cost)}</span> : null}
								</div>
							) : null}
						</div>
					);
				})}
			</div>
			{result ? (
				<details>
					<summary className="cursor-pointer font-mono text-2xs uppercase tracking-meta text-ink-3 hover:text-ink">
						{t("tools.task.findings")}
					</summary>
					<div className="mt-1">
						<MaybeJsonBlock text={extractResultText(result)} />
					</div>
				</details>
			) : null}
		</div>
	);
}

function extractSubagents(
	result: unknown,
): Record<string, { status?: string; durationMs?: number; cost?: number }> {
	const map: Record<string, { status?: string; durationMs?: number; cost?: number }> = {};
	if (!result || typeof result !== "object") return map;
	const r = result as Record<string, unknown>;
	const subs = (r.subagents ?? r.tasks ?? r.findings) as unknown;
	if (Array.isArray(subs)) {
		for (const s of subs) {
			if (!s || typeof s !== "object") continue;
			const obj = s as Record<string, unknown>;
			const id = String(obj.id ?? "");
			if (!id) continue;
			const cost =
				typeof obj.cost === "number"
					? (obj.cost as number)
					: typeof (obj.cost as Record<string, unknown> | undefined)?.total === "number"
						? ((obj.cost as Record<string, unknown>).total as number)
						: undefined;
			map[id] = {
				status: typeof obj.status === "string" ? obj.status : undefined,
				durationMs: typeof obj.durationMs === "number" ? (obj.durationMs as number) : undefined,
				cost,
			};
		}
	}
	return map;
}
