import type { SessionContextNodeKind } from "@omp-deck/protocol";

/**
 * Color tones for the topology focus panel node chips and the node kind
 * legend. Matches the SVG KIND_COLORS in SessionContextTopologyGraph where
 * colors overlap (goal/decision/issue/resolution/evidence), and extends
 * the set for kinds the graph legend doesn't enumerate (artifact/todo).
 */
export interface NodeKindTone {
	chip: string;
	dot: string;
	label: string;
}

const TONES: Record<SessionContextNodeKind, NodeKindTone> = {
	goal: { chip: "bg-accent-soft text-accent border-accent/30", dot: "bg-accent", label: "goal" },
	user_intent: { chip: "bg-accent-soft/60 text-accent border-accent/25", dot: "bg-accent", label: "intent" },
	decision: { chip: "bg-thinking-soft text-thinking border-thinking/30", dot: "bg-thinking", label: "decision" },
	action: { chip: "bg-success-soft text-success border-success/30", dot: "bg-success", label: "action" },
	resolution: { chip: "bg-success-soft text-success border-success/30", dot: "bg-success", label: "resolution" },
	issue: { chip: "bg-danger-soft text-danger border-danger/30", dot: "bg-danger", label: "issue" },
	evidence: { chip: "bg-paper-3 text-ink-2 border-line", dot: "bg-ink-3", label: "evidence" },
	constraint: { chip: "bg-warn-soft text-warn border-warn/30", dot: "bg-warn", label: "constraint" },
	artifact: { chip: "bg-paper-3 text-ink-2 border-line", dot: "bg-ink-3", label: "artifact" },
	todo_state: { chip: "bg-paper-3 text-ink-2 border-line", dot: "bg-ink-3", label: "todo" },
	handoff_summary: { chip: "bg-paper-3 text-ink-2 border-line", dot: "bg-ink-3", label: "handoff" },
};

export function getNodeKindTone(kind: string): NodeKindTone {
	if (kind in TONES) return TONES[kind as SessionContextNodeKind];
	return { chip: "bg-paper-3 text-ink-2 border-line", dot: "bg-ink-3", label: kind };
}

export const NODE_KIND_ORDER: ReadonlyArray<SessionContextNodeKind> = [
	"goal",
	"user_intent",
	"decision",
	"constraint",
	"action",
	"resolution",
	"issue",
	"evidence",
	"artifact",
	"todo_state",
	"handoff_summary",
];
