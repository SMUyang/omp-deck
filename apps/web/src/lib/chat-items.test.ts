import { describe, expect, test } from "bun:test";

import { groupChatItems, ircGroupSenders } from "./chat-items";
import type { ChatMessage, IrcMsg } from "./types";

function userMsg(id: string): ChatMessage {
	return { id, role: "user", text: id, timestamp: 1 };
}

function asstMsg(id: string): ChatMessage {
	return { id, role: "assistant", blocks: [], isStreaming: false, timestamp: 1 };
}

function ircMsg(id: string, from?: string): IrcMsg {
	return { id, role: "irc", content: `body ${id}`, from, timestamp: 1 };
}

describe("groupChatItems", () => {
	test("empty input yields no items", () => {
		expect(groupChatItems([])).toEqual([]);
	});

	test("non-irc messages pass through in order", () => {
		const items = groupChatItems([userMsg("u1"), asstMsg("a1"), userMsg("u2")]);
		expect(items.map((i) => i.kind)).toEqual(["message", "message", "message"]);
		expect(items[0]).toMatchObject({ kind: "message", msg: { id: "u1" } });
	});

	test("consecutive irc messages collapse into one group", () => {
		const items = groupChatItems([
			userMsg("u1"),
			ircMsg("i1", "A"),
			ircMsg("i2", "B"),
			asstMsg("a1"),
		]);
		expect(items.map((i) => i.kind)).toEqual(["message", "irc-group", "message"]);
		const group = items[1];
		expect(group.kind === "irc-group" && group.msgs.map((m) => m.id)).toEqual(["i1", "i2"]);
	});

	test("separated irc runs form separate groups", () => {
		const items = groupChatItems([ircMsg("i1"), asstMsg("a1"), ircMsg("i2")]);
		expect(items.map((i) => i.kind)).toEqual(["irc-group", "message", "irc-group"]);
	});

	test("trailing irc run is flushed", () => {
		const items = groupChatItems([userMsg("u1"), ircMsg("i1")]);
		expect(items.map((i) => i.kind)).toEqual(["message", "irc-group"]);
	});

	test("a lone irc message still groups (uniform rendering)", () => {
		const items = groupChatItems([ircMsg("i1")]);
		expect(items).toHaveLength(1);
		expect(items[0]?.kind).toBe("irc-group");
	});
});

describe("ircGroupSenders", () => {
	test("distinct senders in first-seen order, missing senders skipped", () => {
		expect(ircGroupSenders([ircMsg("1", "A"), ircMsg("2"), ircMsg("3", "B"), ircMsg("4", "A")])).toEqual([
			"A",
			"B",
		]);
	});
});
