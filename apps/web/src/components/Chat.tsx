import { useEffect, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useStore } from "@/lib/store";
import { groupChatItems, type ChatRenderItem } from "@/lib/chat-items";
import type { ChatMessage, QueuedPrompt, ToolCallStream } from "@/lib/types";
import { ChatHeader } from "./chat/ChatHeader";
import { SessionPicker } from "./chat/SessionPicker";
import { UserMessage } from "./messages/UserMessage";
import { AssistantMessage } from "./messages/AssistantMessage";
import { Notice } from "./messages/Notice";
import { CompactionLine } from "./messages/CompactionLine";
import { TtsrLine } from "./messages/TtsrLine";
import { IrcGroup } from "./messages/IrcGroup";
import { QueuedMessage } from "./messages/QueuedMessage";
import { PlanApproval } from "./messages/PlanApproval";

// Stable refs for absent optional fields — avoids a fresh array/object per
// selector call (which would defeat zustand's Object.is change detection).
const EMPTY_MESSAGES: ChatMessage[] = [];
const EMPTY_TOOL_CALLS: Record<string, ToolCallStream> = {};
const EMPTY_QUEUED: QueuedPrompt[] = [];

function renderMessage(m: ChatMessage, toolCalls: Record<string, ToolCallStream>) {
	switch (m.role) {
		case "user":
			return <UserMessage msg={m} />;
		case "assistant":
			return <AssistantMessage msg={m} toolCalls={toolCalls} />;
		case "notice":
			return <Notice msg={m} />;
		case "compaction":
			return <CompactionLine msg={m} />;
		case "ttsr":
			return <TtsrLine msg={m} />;
		default:
			return null;
	}
}

export function Chat() {
	const { t } = useTranslation();
	// Narrow per-field selectors: only the streaming message (messages ref)
	// changes per chunk, so memoized message components skip re-render.
	const sessionId = useStore((s) => s.sessionsById[s.activeId ?? ""]?.sessionId);
	const messages = useStore((s) => s.sessionsById[s.activeId ?? ""]?.messages ?? EMPTY_MESSAGES);
	const toolCalls = useStore((s) => s.sessionsById[s.activeId ?? ""]?.toolCalls ?? EMPTY_TOOL_CALLS);
	const queuedPrompts = useStore((s) => s.sessionsById[s.activeId ?? ""]?.queuedPrompts ?? EMPTY_QUEUED);
	const pendingPlanApproval = useStore((s) => s.sessionsById[s.activeId ?? ""]?.pendingPlanApproval);
	const scrollRef = useRef<HTMLDivElement>(null);
	const stickyRef = useRef(true);

	// Collapse runs of consecutive subagent/IRC messages into a single
	// expandable group so delegation chatter doesn't flood the transcript.
	const items = useMemo(() => groupChatItems(messages), [messages]);

	useEffect(() => {
		const el = scrollRef.current;
		if (!el) return;
		if (stickyRef.current) {
			el.scrollTop = el.scrollHeight;
		}
	}, [messages, toolCalls, queuedPrompts]);

	function handleScroll(): void {
		const el = scrollRef.current;
		if (!el) return;
		const fromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
		stickyRef.current = fromBottom < 100;
	}

	// No active session — show the picker as the main pane instead of a
	// dead-end "go to sidebar" message.
	if (!sessionId) {
		return <SessionPicker />;
	}

	return (
		<div className="flex h-full min-h-0 flex-col">
			<ChatHeader />
			<div ref={scrollRef} onScroll={handleScroll} className="flex-1 overflow-y-auto">
				<div className="mx-auto flex max-w-[760px] flex-col gap-7 px-6 py-10">
					{messages.length === 0 ? (
						<div className="text-center font-mono text-2xs uppercase tracking-meta text-ink-3">
							{t("core.chat.emptySession")}
						</div>
					) : null}

					{items.map((item: ChatRenderItem, i: number) => {
						if (item.kind === "irc-group") {
							return <IrcGroup key={item.key} msgs={item.msgs} />;
						}
						const m = item.msg;
						// Turn separator: each new user message opens a turn — give it a
						// hairline + extra breathing room so multi-turn sessions scan.
						const turnStart = m.role === "user" && i > 0;
						return (
							<div key={m.id} className={turnStart ? "border-t border-line pt-7" : undefined}>
								{renderMessage(m, toolCalls)}
							</div>
						);
					})}

					{queuedPrompts.map((q) => (
						<QueuedMessage key={q.id} msg={q} />
					))}
					{pendingPlanApproval ? (
						<PlanApproval />
					) : null}
				</div>
			</div>
		</div>
	);
}
