/**
 * Session generator — builds a synthetic conversation with 12 needle memories
 * embedded at specified positions within distractor padding.
 *
 * Output: AgentMessage[] suitable for extractFromMessages().
 */

import type { Needle } from "./needles.ts";
import { generateDistractors, type DistractorMessage } from "./distractors.ts";

export interface GeneratedSession {
	messages: Record<string, unknown>[];
	needles: Needle[];
	needlePositions: Map<string, number>; // needleId → message index
	totalChars: number;
}

/**
 * Generate a session with needles at target positions within distractors.
 *
 * @param needles The 12 core memories to embed
 * @param positions Where to place each needle (fraction of total length)
 * @param targetChars Approximate total character count of all messages
 */
export function generateSession(
	needles: Needle[],
	positions: number[],
	targetChars: number,
): GeneratedSession {
	// Generate distractors
	const distractors = generateDistractors(targetChars);
	const totalSlots = distractors.length + needles.length;

	// Group needles so related memories stay adjacent (issue→resolution, supersession chains)
	const groups = new Map<string, number[]>(); // group → needle indices (in original order)
	needles.forEach((n, i) => {
		const g = n.group ?? `single-${i}`;
		if (!groups.has(g)) groups.set(g, []);
		groups.get(g)!.push(i);
	});

	// Assign each GROUP to a slot; group members are consecutive
	const slotAssignments = new Map<number, number[]>(); // slot → needle indices
	const groupIds = [...groups.keys()];
	groupIds.forEach((g, gi) => {
		const members = groups.get(g)!;
		const pos = positions[gi % positions.length] ?? 0.5;
		const baseSlot = Math.floor(pos * totalSlots);
		let slot = baseSlot;
		while (slotAssignments.has(slot)) slot++; // avoid group collisions
		slotAssignments.set(slot, members);
	});

	// Merge needles into distractor stream
	const messages: Record<string, unknown>[] = [];
	const needlePositions = new Map<string, number>();
	let di = 0;
	let msgIdx = 0;

	for (let slot = 0; slot < totalSlots; slot++) {
		// Place ALL needles assigned to this slot
		const needleIdxs = slotAssignments.get(slot);
		if (needleIdxs) {
			for (const ni of needleIdxs) {
				const needle = needles[ni]!;
				messages.push({
					role: needle.role,
					content: [{ type: "text", text: needle.content }],
					id: `needle-${needle.id}`,
					timestamp: new Date(Date.now() + msgIdx * 1000).toISOString(),
				});
				needlePositions.set(needle.id, msgIdx);
				msgIdx++;
			}
			continue;
		}

		// Place distractor
		if (di < distractors.length) {
			const d = distractors[di]!;
			messages.push({
				role: d.role,
				content: [{ type: "text", text: d.content }],
				id: `distractor-${di}`,
				timestamp: new Date(Date.now() + msgIdx * 1000).toISOString(),
			});
			di++;
			msgIdx++;
		}
	}

	const totalChars = messages.reduce((sum, m) => {
		const content = m.content as Array<{ text?: string }>;
		return sum + (Array.isArray(content) ? content[0]?.text?.length ?? 0 : 0);
	}, 0);

	return { messages, needles, needlePositions, totalChars };
}
