import type { HTMLAttributes } from "react";
import { cn } from "@/lib/utils";

type Tone = "default" | "accent" | "accent-plan" | "warn" | "danger" | "success" | "thinking" | "muted";

interface Props extends HTMLAttributes<HTMLSpanElement> {
	tone?: Tone;
}

const tones: Record<Tone, string> = {
	default: "bg-paper-3 text-ink",
	accent: "bg-accent-soft text-accent",
	"accent-plan": "border border-accent-plan/40 bg-accent-plan/10 text-accent-plan",
	warn: "bg-warn/15 text-warn",
	danger: "bg-danger/15 text-danger",
	success: "bg-success/15 text-success",
	thinking: "bg-thinking/15 text-thinking",
	muted: "bg-paper-3 text-ink-3",
};

export function Badge({ className, tone = "default", ...rest }: Props) {
	return (
		<span
			className={cn(
				"inline-flex items-center gap-1 rounded px-1.5 py-[1px] font-mono text-2xs uppercase tracking-meta",
				tones[tone],
				className,
			)}
			{...rest}
		/>
	);
}
