import type { AssistantMsg, ToolCallStream } from "@/lib/types";
import { memo } from "react";
import { useTranslation } from "react-i18next";
import { Markdown } from "@/lib/markdown";
import { formatCost, formatDurationMs, formatTokens } from "@/lib/utils";
import { ThinkingBlock } from "./ThinkingBlock";
import { ToolCallCard } from "../tools/ToolCallCard";

interface Props {
	msg: AssistantMsg;
	toolCalls: Record<string, ToolCallStream>;
}

export const AssistantMessage = memo(function AssistantMessage({ msg, toolCalls }: Props) { const { t } = useTranslation(); const lastBlockIdx = msg.blocks.length - 1;

	return (
		<div className="space-y-2">
			<div className="flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-2xs uppercase tracking-meta text-ink-3">
				<span className="text-ink-2">omp</span>
				{msg.model ? <span className="text-ink-4 normal-case tracking-normal">{msg.model}</span> : null}
				{msg.isStreaming ? <span className="text-accent">{t("messages.assistantMessage.streaming")}</span> : null}
				{msg.stopReason && !msg.isStreaming ? (
					<span className={msg.stopReason === "stop" ? "text-ink-4" : "text-warn"}>
						· {msg.stopReason}
					</span>
				) : null}
				{msg.usage?.totalTokens ? (
					<span className="text-ink-4">
						· {formatTokens(msg.usage.totalTokens)} tok · {formatCost(msg.usage.cost)}
					</span>
				) : null}
				{msg.durationMs ? (
					<span className="text-ink-4">· {formatDurationMs(msg.durationMs)}</span>
				) : null}
			</div>

			{msg.errorMessage ? (
				<div className="border-l-2 border-danger pl-3 font-mono text-xs text-danger">
					{msg.errorMessage}
				</div>
			) : null}

			{msg.blocks.length === 0 && msg.isStreaming ? (
				<div className="cursor-blink font-mono text-xs text-ink-3">…</div>
			) : null}

			<div className="space-y-3">
				{msg.blocks.map((b, i) => {
					if (b.type === "text") {
						const last = i === lastBlockIdx;
						return (
							<Markdown key={i} streaming={msg.isStreaming && last}>
								{b.text}
							</Markdown>
						);
					}
					if (b.type === "thinking") {
						return <ThinkingBlock key={i} text={b.thinking} streaming={msg.isStreaming} />;
					}
					if (b.type === "redactedThinking") {
						return (
							<ThinkingBlock
								key={i}
								text={t("messages.assistantMessage.redactedThinking")}
								streaming={false}
								redacted
							/>
						);
					}
					if (b.type === "toolCall") {
						const stream = toolCalls[b.id];
						return (
							<ToolCallCard
								key={b.id || i}
								toolCallId={b.id}
								name={b.name}
								args={b.arguments}
								intent={b.intent}
								stream={stream}
							/>
						);
					}
					return null;
				})}
			</div>
		</div>
	); });
