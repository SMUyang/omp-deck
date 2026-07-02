import { useCallback, useEffect, useState, type MouseEvent } from "react";
import { useTranslation } from "react-i18next";
import type { SessionContextStatusResponse } from "@omp-deck/protocol";

import { api } from "@/lib/api";
import { cn } from "@/lib/utils";

type ChipState = "idle" | "building" | "failed" | "unavailable";

type TFunction = (key: string, values?: Record<string, number>) => string;

export function buildSessionContextStatusLabel(input: {
	status?: SessionContextStatusResponse;
	state?: ChipState;
	t: TFunction;
}): string {
	const label = input.t("sessionContext.sidebarStatus.label");
	if (input.state === "building") return `${label} · ${input.t("sessionContext.sidebarStatus.building")}`;
	if (input.state === "failed") return `${label} · ${input.t("sessionContext.sidebarStatus.failed")}`;
	if (input.state === "unavailable") return `${label} · ${input.t("sessionContext.sidebarStatus.unavailable")}`;
	if (!input.status || !input.status.built) return `${label} · ${input.t("sessionContext.sidebarStatus.notBuilt")}`;
	return `${label} · ${input.t("sessionContext.sidebarStatus.counts", { nodes: input.status.nodeCount, edges: input.status.edgeCount })}`;
}

interface SessionContextStatusChipProps {
	sessionId: string;
	active?: boolean;
	className?: string;
}

export function SessionContextStatusChip({ sessionId, active = false, className }: SessionContextStatusChipProps) {
	const { t } = useTranslation();
	const [status, setStatus] = useState<SessionContextStatusResponse | undefined>();
	const [state, setState] = useState<ChipState>("idle");
	const [error, setError] = useState<string | undefined>();

	useEffect(() => {
		let cancelled = false;
		setError(undefined);
		void api.getSessionContextStatus(sessionId)
			.then((next) => {
				if (cancelled) return;
				setStatus(next);
				setState("idle");
			})
			.catch((err: unknown) => {
				if (cancelled) return;
				setError(err instanceof Error ? err.message : String(err));
				setState("unavailable");
			});
		return () => {
			cancelled = true;
		};
	}, [sessionId]);

	const rebuild = useCallback(async (event: MouseEvent<HTMLButtonElement>) => {
		event.stopPropagation();
		setState("building");
		setError(undefined);
		try {
			await api.rebuildSessionContext(sessionId);
			setStatus(await api.getSessionContextStatus(sessionId));
			setState("idle");
		} catch (err: unknown) {
			setError(err instanceof Error ? err.message : String(err));
			setState("failed");
		}
	}, [sessionId]);

	const label = buildSessionContextStatusLabel({ status, state, t });
	return (
		<button
			type="button"
			className={cn(
				"mt-1 inline-flex max-w-full items-center rounded border border-line/70 px-1.5 py-0.5 font-mono text-[10px] text-ink-4 hover:border-line-strong hover:text-ink-2",
				active ? "bg-paper-2" : "bg-paper/40",
				className,
			)}
			onClick={rebuild}
			title={error ?? label}
		>
			<span className="truncate">{label}</span>
		</button>
	);
}
