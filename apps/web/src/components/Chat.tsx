import { useEffect, useRef } from "react";
import { useStore, selectActiveSession } from "@/lib/store";
import { ChatHeader } from "./chat/ChatHeader";
import { SessionPicker } from "./chat/SessionPicker";
import { UserMessage } from "./messages/UserMessage";
import { AssistantMessage } from "./messages/AssistantMessage";
import { Notice } from "./messages/Notice";
import { CompactionLine } from "./messages/CompactionLine";
import { TtsrLine } from "./messages/TtsrLine";
import { IrcLine } from "./messages/IrcLine";
import { QueuedMessage } from "./messages/QueuedMessage";
import { PlanApproval } from "./messages/PlanApproval";
import { ContextPackPanel } from "./session/ContextPackPanel";

export function Chat() {
	const session = useStore(selectActiveSession);
	const scrollRef = useRef<HTMLDivElement>(null);
	const stickyRef = useRef(true);

	const messages = session?.messages ?? [];
	const toolCalls = session?.toolCalls ?? {};
	const queuedPrompts = session?.queuedPrompts ?? [];

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
	if (!session) {
		return <SessionPicker />;
	}

	return (
		<div className="flex h-full min-h-0 flex-col">
			<ChatHeader />
			<div ref={scrollRef} onScroll={handleScroll} className="flex-1 overflow-y-auto">
				<div className="mx-auto flex max-w-[760px] flex-col gap-7 px-6 py-10">
					{messages.length === 0 ? (
						<div className="text-center font-mono text-2xs uppercase tracking-meta text-ink-3">
							Empty session — send a prompt below.
						</div>
					) : null}

					{messages.map((m) => {
						switch (m.role) {
							case "user":
								return <UserMessage key={m.id} msg={m} />;
							case "assistant":
								return <AssistantMessage key={m.id} msg={m} toolCalls={toolCalls} />;
							case "notice":
								return <Notice key={m.id} msg={m} />;
							case "compaction":
								return <CompactionLine key={m.id} msg={m} />;
							case "ttsr":
								return <TtsrLine key={m.id} msg={m} />;
							case "irc":
								return <IrcLine key={m.id} msg={m} />;
							default:
								return null;
						}
					})}

					{queuedPrompts.map((q) => (
						<QueuedMessage key={q.id} msg={q} />
					))}
					{session.pendingPlanApproval ? (
						<PlanApproval session={session} />
					) : null}
					<ContextPackPanel sessionId={session.sessionId} />
				</div>
			</div>
		</div>
	);
}
