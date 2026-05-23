/**
 * Custom React Flow node for a single `RoutineStep`. P1.2 ships the basic
 * shell — type strip, id, summary line. P2 will add selection-driven editing
 * via NodePropertyPanel and P4 will overlay run status.
 *
 * Visual style intentionally matches `StepCard` (form-mode): same type-color
 * strip, same id badge style, same 2xs monospace meta line. The canvas is an
 * alternate view, not a different aesthetic.
 */

import { Handle, Position, type NodeProps } from "@xyflow/react";
import { memo } from "react";

import type { RoutineStep, RoutineStepRun, RoutineStepStatus } from "@omp-deck/protocol";

import type { StepNode as StepNodeType } from "../graph-types";

/**
 * Type → background-tint class. Same palette as `StepCard.TYPE_BG` so a step
 * authored in form mode and viewed in canvas mode reads identically.
 */
const TYPE_TINT: Record<RoutineStep["type"], string> = {
	run: "bg-paper-3/40 border-line",
	agent: "bg-thinking/10 border-thinking/30",
	write: "bg-success/10 border-success/30",
	http: "bg-accent/10 border-accent/30",
	deck: "bg-accent-soft/40 border-line-strong",
	mcp: "bg-warn/10 border-warn/30",
	transform: "bg-paper-3/60 border-line",
	wait: "bg-paper-3/40 border-line",
	set_state: "bg-paper-3/40 border-line",
};

/**
 * One-line summary of the step's most distinctive field. Empty string when the
 * step has no useful surface text yet (renderer omits the line in that case).
 */
function summarize(step: RoutineStep): string {
	switch (step.type) {
		case "agent":
			return step.prompt?.slice(0, 80) ?? "";
		case "http":
			return `${step.method} ${step.url}`;
		case "write":
			return step.path;
		case "run":
			return step.command ?? "";
		case "deck":
			return step.action;
		case "mcp":
			return `${step.server}.${step.tool}`;
		case "transform":
			return step.body?.split("\n")[0]?.slice(0, 80) ?? "";
		case "wait":
			return `wait ${step.duration_secs}s`;
		case "set_state":
			return Object.keys(step.state ?? {}).join(", ");
		default:
			return "";
	}
}

export const StepNode = memo(function StepNode({
	data,
	selected,
}: NodeProps<StepNodeType>) {
	const { step, compileError, isIfNode, stepRun } = data;
	const summary = summarize(step);
	const tint = TYPE_TINT[step.type] ?? "bg-paper-2 border-line";

	// Visual priority for the outer ring:
	//  1. Compile errors — must surface even mid-edit; broken graphs ship nothing.
	//  2. Run status — when the user is reviewing a recent run, the per-step
	//     status is the most useful signal.
	//  3. Selection — neutral accent ring for the in-flight inspector target.
	const statusRing = stepRun ? STATUS_RING[stepRun.status] : "";
	const ringClass = compileError
		? " ring-2 ring-danger ring-offset-1 ring-offset-paper"
		: statusRing
			? ` ring-2 ${statusRing} ring-offset-1 ring-offset-paper`
			: selected
				? " ring-1 ring-accent ring-offset-1 ring-offset-paper"
				: "";

	return (
		<div
			className={
				"min-w-[200px] max-w-[260px] rounded border bg-paper-2 shadow-sm transition-colors " +
				tint +
				ringClass
			}
			title={compileError ?? undefined}
			data-step-id={step.id}
			data-status={stepRun?.status ?? "none"}
		>
			<Handle
				type="target"
				position={Position.Top}
				className="!h-2 !w-2 !border-line !bg-paper-2"
			/>
			<div className="flex items-center gap-2 border-b border-line/60 px-2 py-1">
				<span className="font-mono text-2xs uppercase tracking-meta text-ink-3">
					{step.type}
				</span>
				{compileError ? (
					<span
						className="font-mono text-2xs font-bold text-danger"
						aria-label="Compile error"
					>
						!
					</span>
				) : null}
				{stepRun && !compileError ? <StatusBadge run={stepRun} /> : null}
				<span className="ml-auto font-mono text-2xs text-ink-2">{step.id}</span>
			</div>
			{summary ? (
				<div className="px-2 py-1.5 font-mono text-2xs leading-snug text-ink-2 line-clamp-2">
					{summary}
				</div>
			) : (
				<div className="px-2 py-1.5 font-mono text-2xs italic text-ink-4">
					(empty)
				</div>
			)}
			{step.when ? (
				<div
					className="border-t border-line/60 px-2 py-1 font-mono text-2xs text-ink-3"
					title={step.when}
				>
					when: <span className="text-ink-2">{step.when.slice(0, 40)}</span>
					{step.when.length > 40 ? "…" : ""}
				</div>
			) : null}
			{compileError ? (
				<div className="border-t border-danger/40 bg-danger/10 px-2 py-1 font-mono text-2xs text-danger">
					{compileError.length > 60 ? compileError.slice(0, 57) + "…" : compileError}
				</div>
			) : null}
			{stepRun && !compileError ? <RunFootline run={stepRun} /> : null}
			{isIfNode ? (
				<>
					{/* Two source handles labeled `true` and `false`. The ids are
					    consumed by `handleConnect` so a drag from this handle persists
					    the right edge kind. Placed at 30%/70% horizontal so they read
					    left-to-right as truthy → falsy. */}
					<div className="flex border-t border-line/60 bg-paper-3/40 px-2 py-1 font-mono text-2xs text-ink-3">
						<span className="flex-1 text-success">true →</span>
						<span className="flex-1 text-right text-danger">→ false</span>
					</div>
					<Handle
						id="true"
						type="source"
						position={Position.Bottom}
						style={{ left: "30%" }}
						className="!h-2 !w-2 !border-success !bg-success"
					/>
					<Handle
						id="false"
						type="source"
						position={Position.Bottom}
						style={{ left: "70%" }}
						className="!h-2 !w-2 !border-danger !bg-danger"
					/>
				</>
			) : (
				<Handle
					type="source"
					position={Position.Bottom}
					className="!h-2 !w-2 !border-line !bg-paper-2"
				/>
			)}
		</div>
	);
});

/**
 * Status → ring tailwind class. Running pulses to convey activity; everything
 * else is solid. Skipped/aborted stay dim so they don't draw attention away
 * from the steps that actually executed.
 */
const STATUS_RING: Record<RoutineStepStatus, string> = {
	pending: "ring-line-strong",
	running: "ring-accent animate-pulse",
	success: "ring-success",
	skipped: "ring-line-strong opacity-80",
	failed: "ring-danger",
	aborted: "ring-warn",
};

const STATUS_DOT: Record<RoutineStepStatus, string> = {
	pending: "bg-line-strong",
	running: "bg-accent animate-pulse",
	success: "bg-success",
	skipped: "bg-line-strong",
	failed: "bg-danger",
	aborted: "bg-warn",
};

/**
 * Short status pill rendered in the node header. Uses the same colour scheme
 * as RunDetailView.StatusPill so the canvas and run-detail panes read as one
 * design system.
 */
function StatusBadge({ run }: { run: RoutineStepRun }): JSX.Element {
	return (
		<span
			className={`h-2 w-2 rounded-full ${STATUS_DOT[run.status]}`}
			aria-label={`status: ${run.status}`}
			title={`status: ${run.status}`}
		/>
	);
}

/**
 * Bottom info strip with run telemetry. Only fields that have a value are
 * rendered so successful no-cost steps (e.g. `set_state`) don't get a noisy
 * footer of dashes.
 */
function RunFootline({ run }: { run: RoutineStepRun }): JSX.Element | null {
	const tokensTotal = (run.llmTokensIn ?? 0) + (run.llmTokensOut ?? 0);
	const costUsd =
		run.llmCostMicros != null ? run.llmCostMicros / 1_000_000 : null;
	const parts: string[] = [];
	if (run.durationMs != null) parts.push(formatDur(run.durationMs));
	if (run.model) parts.push(run.model);
	if (tokensTotal > 0) parts.push(`${tokensTotal}t`);
	if (costUsd != null && costUsd > 0) parts.push(`$${costUsd.toFixed(3)}`);
	if (parts.length === 0) return null;
	return (
		<div className="flex items-center gap-1.5 border-t border-line/60 px-2 py-1 font-mono text-2xs text-ink-3">
			{parts.map((p, i) => (
				<span key={i} className={i === 0 ? "text-ink-2" : ""}>
					{p}
				</span>
			))}
		</div>
	);
}

function formatDur(ms: number): string {
	if (ms < 1000) return `${Math.round(ms)}ms`;
	const s = ms / 1000;
	if (s < 60) return `${s.toFixed(1)}s`;
	const m = Math.floor(s / 60);
	const rem = Math.round(s - m * 60);
	return `${m}m${rem}s`;
}
