import { useCallback, useEffect, useRef, useState, type MouseEvent } from "react";
import { useTranslation } from "react-i18next";
import type { SessionContextGraphResponse, SessionContextNode, SessionContextEdge } from "@omp-deck/protocol";

import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { useStore, selectActiveSession } from "@/lib/store";

type PanelState = "closed" | "loading" | "loaded" | "error";

export function TopologyMemoryPanel() {
	const { t } = useTranslation();
	const activeSession = useStore(selectActiveSession);
	const sessionId = activeSession?.sessionId ?? null;
	const [graph, setGraph] = useState<SessionContextGraphResponse | null>(null);
	const [state, setState] = useState<PanelState>("closed");
	const [error, setError] = useState<string | undefined>();
	const [rebuilding, setRebuilding] = useState(false);
	const [filter, setFilter] = useState("");

	const load = useCallback(async () => {
		if (!sessionId) return;
		setState("loading");
		setError(undefined);
		try {
			await api.rebuildSessionContext(sessionId);
			const data = await api.getSessionContextGraph(sessionId, 500);
			setGraph(data);
			setState("loaded");
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
			setState("error");
		}
	}, [sessionId]);

	const rebuild = useCallback(async (event: MouseEvent<HTMLButtonElement>) => {
		event.stopPropagation();
		if (!sessionId || rebuilding) return;
		setRebuilding(true);
		try {
			await api.rebuildSessionContext(sessionId);
			const data = await api.getSessionContextGraph(sessionId, 500);
			setGraph(data);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setRebuilding(false);
		}
	}, [sessionId, rebuilding]);

	useEffect(() => {
		if (sessionId) {
			void load();
		} else {
			setGraph(null);
			setState("closed");
		}
	}, [sessionId, load]);

	if (state === "closed") {
		return (
			<button
				type="button"
				className="mt-2 w-full rounded border border-line px-2 py-1 text-xs text-ink-3 hover:bg-paper-3"
				onClick={() => { if (sessionId) void load(); }}
				disabled={!sessionId}
			>
				{t("topology.loadGraph", "Load topology graph")}
			</button>
		);
	}

	if (state === "loading") {
		return <div className="mt-2 text-xs text-ink-3">{t("topology.loading", "Loading…")}</div>;
	}

	if (state === "error") {
		return (
			<div className="mt-2 space-y-1">
				<div className="rounded border border-red-500/30 bg-red-500/10 px-2 py-1 text-xs text-red-300">{error}</div>
				<button
					type="button"
					className="w-full rounded border border-line px-2 py-1 text-xs hover:bg-paper-3"
					onClick={() => { if (sessionId) void load(); }}
				>
					{t("topology.retry", "Retry")}
				</button>
			</div>
		);
	}

	if (!graph || graph.nodes.length === 0) {
		return (
			<div className="mt-2 space-y-1">
				<div className="text-xs text-ink-3">{t("topology.empty", "No topology data.")}</div>
				<button
					type="button"
					className="w-full rounded border border-line px-2 py-1 text-xs hover:bg-paper-3"
					onClick={rebuild}
					disabled={rebuilding}
				>
					{rebuilding ? t("topology.building", "Rebuilding…") : t("topology.rebuild", "Rebuild")}
				</button>
			</div>
		);
	}

	const filteredNodes = filter
		? graph.nodes.filter((n) =>
			n.title.toLowerCase().includes(filter.toLowerCase()) ||
			(n.compressedBody || n.body).toLowerCase().includes(filter.toLowerCase())
		)
		: graph.nodes;

	const nodesByKind = new Map<string, SessionContextNode[]>();
	for (const node of filteredNodes) {
		const list = nodesByKind.get(node.kind) ?? [];
		list.push(node);
		nodesByKind.set(node.kind, list);
	}

	const kindOrder = ["goal", "decision", "resolution", "evidence", "constraint", "issue", "user_intent", "action", "artifact", "todo_state", "handoff_summary"] as const;
	const kindLabels: Record<string, string> = {
		goal: "🎯 Goals", decision: "✅ Decisions", resolution: "🔧 Resolutions",
		evidence: "📎 Evidence", constraint: "🚧 Constraints", issue: "⚠️ Issues",
		user_intent: "💬 Intents", action: "⚡ Actions", artifact: "📦 Artifacts",
		todo_state: "📋 Todos", handoff_summary: "📝 Handoffs",
	};

	return (
		<div className="mt-2 space-y-2">
			<div className="flex items-center gap-2">
				<input
					type="text"
					className="w-full rounded border border-line bg-paper-2 px-2 py-1 text-xs"
					placeholder={t("topology.filterPlaceholder", "Filter nodes…")}
					value={filter}
					onChange={(e) => setFilter(e.target.value)}
				/>
				<button
					type="button"
					className="shrink-0 rounded border border-line px-2 py-1 text-xs hover:bg-paper-3"
					onClick={rebuild}
					disabled={rebuilding}
				>
					{rebuilding ? "…" : "↻"}
				</button>
			</div>
			<div className="font-mono text-2xs text-ink-3">
				{graph.nodes.length} nodes · {graph.edges.length} edges
				{graph.truncated ? " · truncated" : ""}
			</div>
			<div className="max-h-[40vh] space-y-2 overflow-y-auto pr-1">
				{kindOrder.map((kind) => {
					const nodes = nodesByKind.get(kind);
					if (!nodes || nodes.length === 0) return null;
					return (
						<div key={kind}>
							<div className="text-2xs font-semibold uppercase tracking-wider text-ink-3">
								{kindLabels[kind] ?? kind} ({nodes.length})
							</div>
							<ul className="mt-0.5 space-y-0.5">
								{nodes.slice(0, 20).map((node) => (
									<li key={node.id} className="rounded border border-line/40 bg-paper-2 px-2 py-1 text-xs">
										<div className="font-medium">{node.title}</div>
										<div className="mt-0.5 text-ink-3">{(node.compressedBody || node.body).slice(0, 120)}</div>
									</li>
								))}
								{nodes.length > 20 ? (
									<li className="text-2xs text-ink-4">… and {nodes.length - 20} more</li>
								) : null}
							</ul>
						</div>
					);
				})}
				{kindOrder.every((kind) => !nodesByKind.has(kind)) && nodesByKind.size > 0 ? (
					<div className="text-xs text-ink-3">
						{Array.from(nodesByKind.entries()).map(([kind, nodes]) => (
							<div key={kind}>{kind}: {nodes.length}</div>
						))}
					</div>
				) : null}
			</div>
		</div>
	);
}
