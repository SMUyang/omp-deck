/**
 * Chat render-item grouping.
 *
 * Subagent→parent hub traffic arrives as `irc` chat messages. A busy
 * delegation run can produce dozens of them in a row; rendered inline they
 * drown the actual conversation. The chat therefore collapses every
 * maximal run of consecutive `irc` messages into a single {@link IrcGroup}
 * render item. All other messages pass through unchanged, order preserved.
 */

import type { ChatMessage, IrcMsg } from "./types";

export type ChatRenderItem =
	| { kind: "message"; msg: ChatMessage }
	| { kind: "irc-group"; msgs: IrcMsg[]; key: string };

export function groupChatItems(messages: ChatMessage[]): ChatRenderItem[] {
	const out: ChatRenderItem[] = [];
	let pending: IrcMsg[] = [];

	const flush = (): void => {
		if (pending.length === 0) return;
		out.push({ kind: "irc-group", msgs: pending, key: `irc-group-${pending[0]?.id ?? "0"}` });
		pending = [];
	};

	for (const msg of messages) {
		if (msg.role === "irc") {
			pending.push(msg);
			continue;
		}
		flush();
		out.push({ kind: "message", msg });
	}
	flush();
	return out;
}

/** Distinct senders of an irc group, in first-seen order, for the header. */
export function ircGroupSenders(msgs: IrcMsg[]): string[] {
	const seen = new Set<string>();
	for (const m of msgs) {
		if (m.from) seen.add(m.from);
	}
	return [...seen];
}
