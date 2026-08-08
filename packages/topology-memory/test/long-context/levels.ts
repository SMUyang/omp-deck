/**
 * Long-Context Memory Benchmark — Level definitions.
 *
 * Each level defines a target token budget. Sessions are generated
 * by embedding 12 needle memories at random positions within
 * distractor padding to hit the target token count.
 */

export interface ContextLevel {
	id: string;
	label: string;
	targetTokens: number;
	approxChars: number; // tokens × ~4 chars/token
}

export const LEVELS: ContextLevel[] = [
	{ id: "LV1", label: "8K",   targetTokens: 8_000,    approxChars: 32_000 },
	{ id: "LV2", label: "16K",  targetTokens: 16_000,   approxChars: 64_000 },
	{ id: "LV3", label: "32K",  targetTokens: 32_000,   approxChars: 128_000 },
	{ id: "LV4", label: "64K",  targetTokens: 64_000,   approxChars: 256_000 },
	{ id: "LV5", label: "128K", targetTokens: 128_000,  approxChars: 512_000 },
	{ id: "LV6", label: "256K", targetTokens: 256_000,  approxChars: 1_024_000 },
];

/** Needle insertion positions (fraction of total session length). */
export const POSITIONS = [0.05, 0.25, 0.50, 0.75, 0.95];

/** V2 acceptance targets per level. */
export const V2_TARGETS: Record<string, number> = {
	LV1: 0.98, LV2: 0.97, LV3: 0.95, LV4: 0.92, LV5: 0.88, LV6: 0.80,
};
