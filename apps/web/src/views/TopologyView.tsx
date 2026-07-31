import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { parseTopologyFocus, latestUserText } from "@/lib/topology-focus";

import type {
	ContextReplacementEvent,
	SessionContextGraphResponse,
	SessionContextNode,
} from "@omp-deck/protocol";

import { Layout } from "@/components/Layout";
import { SessionContextStatusChip } from "@/components/session/SessionContextStatusChip";
import { TopologyGraph } from "@/components/session/TopologyGraph";
import { ContextPackPanel } from "@/components/session/ContextPackPanel";
import { ContextEvidenceTimeline } from "@/components/topology/ContextEvidenceTimeline";
import { ContextSavingsCard } from "@/components/topology/ContextSavingsCard";
import { api } from "@/lib/api";
import { useStore, selectActiveSession } from "@/lib/store";
import { cn } from "@/lib/utils";

/**
 * First-class topology workspace with session selector, native SVG context
 * graph, selected-node inspector, evidence timeline, and context pack.
 *
 * Session selection persists in `?session=<id>`.  Responsive: two-column on
 * desktop (graph | inspector+evidence), single-column vertical document flow
 * on mobile so the right panel never covers SVG hit targets.
 */
export function TopologyView() {
	const { t } = useTranslation();
	const [searchParams, setSearchParams] = useSearchParams();

	// ── Store ──────────────────────────────────────────────────────────
	const sessions = useStore((s) => s.sessions);
	const refreshSessions = useStore((s) => s.refreshSessions);

	// ── URL-driven session selection ───────────────────────────────────
	const sessionId = searchParams.get("session") ?? null;

	// ── Graph state ────────────────────────────────────────────────────
	const [graph, setGraph] = useState<SessionContextGraphResponse | null>(null);
	const [graphLoading, setGraphLoading] = useState(false);
	const [graphError, setGraphError] = useState<string | null>(null);

	// ── Evidence state ─────────────────────────────────────────────────
	const [evidence, setEvidence] = useState<ContextReplacementEvent[]>([]);
	const [evidenceLoading, setEvidenceLoading] = useState(false);

	// ── Selected node ──────────────────────────────────────────────────
	const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);

	// ── Fetch graph when session changes ───────────────────────────────
	useEffect(() => {
		if (!sessionId) {
			setGraph(null);
			setGraphError(null);
			return;
		}
		let cancelled = false;
		setGraphLoading(true);
		setGraphError(null);
		api
			.getSessionContextGraph(sessionId, 500) // match focus retrieval limit (getStoredQueryTopologyFocus uses 500)
			.then((g) => {
				if (!cancelled) setGraph(g);
			})
			.catch((err: unknown) => {
				if (!cancelled) setGraphError(err instanceof Error ? err.message : String(err));
			})
			.finally(() => {
				if (!cancelled) setGraphLoading(false);
			});
		return () => {
			cancelled = true;
		};
	}, [sessionId]);

	// ── Focus state: query-driven selection of next model context ──
	const [focusQuery, setFocusQuery] = useState(() => searchParams.get("q") ?? "");
	const [focusIds, setFocusIds] = useState<Set<string>>(new Set());
	const [focusError, setFocusError] = useState<string | null>(null);
	const [focusLoading, setFocusLoading] = useState(false);
	const activeSession = useStore((s) => selectActiveSession(s));
	const activeQuery = useMemo(
		() => latestUserText((activeSession?.messages ?? []) as ReadonlyArray<{ role: string; text?: string }>),
		[activeSession?.messages],
	);
	const effectiveQuery = focusQuery || activeQuery;

	useEffect(() => {
		if (!sessionId) {
			setFocusIds(new Set());
			return;
		}
		const q = effectiveQuery.trim();
		if (!q) {
			setFocusIds(new Set());
			return;
		}
		let cancelled = false;
		setFocusLoading(true);
		setFocusError(null);
		api
			.getSessionContextFocus(sessionId, { q, contextPercent: 100 })
			.then((resp) => {
				if (cancelled) return;
				const parsed = parseTopologyFocus(resp.focus);
				setFocusIds(new Set(parsed?.nodes.map((n) => n.id) ?? []));
			})
			.catch((err) => {
				if (!cancelled) setFocusError(err instanceof Error ? err.message : String(err));
			})
			.finally(() => {
				if (!cancelled) setFocusLoading(false);
			});
		return () => {
			cancelled = true;
		};
	}, [sessionId, effectiveQuery]);

	// ── Fetch evidence when session changes ────────────────────────────
	useEffect(() => {
		if (!sessionId) {
			setEvidence([]);
			return;
		}
		let cancelled = false;
		setEvidenceLoading(true);
		api
			.getContextEvidence(sessionId)
			.then((events) => {
				if (!cancelled) setEvidence(events);
			})
			.catch(() => {
				if (!cancelled) setEvidence([]);
			})
			.finally(() => {
				if (!cancelled) setEvidenceLoading(false);
			});
		return () => {
			cancelled = true;
		};
	}, [sessionId]);

	// ── Selected node memo ─────────────────────────────────────────────
	const selectedNode = useMemo<SessionContextNode | null>(() => {
		if (!graph || !selectedNodeId) return null;
		return graph.nodes.find((n) => n.id === selectedNodeId) ?? null;
	}, [graph, selectedNodeId]);

	// ── Refresh sessions on mount ──────────────────────────────────────
	useEffect(() => {
		void refreshSessions();
	}, [refreshSessions]);

	// ── Handlers ───────────────────────────────────────────────────────
	const selectSession = useCallback(
		(id: string) => {
			setSearchParams({ session: id });
			setSelectedNodeId(null);
		},
		[setSearchParams],
	);

	// ── Render ─────────────────────────────────────────────────────────
	return (
		<Layout sidebar={null} inspector={null} main={
			<div className="flex h-full flex-col">
				{/* ── Empty state: no session selected ── */}
				{!sessionId ? (
					<div className="flex flex-1 items-center justify-center p-8">
						<div className="max-w-md space-y-4 text-center">
							<h2 className="text-lg font-semibold text-ink">
								{t("topologyWorkspace.title")}
							</h2>
							<p className="text-sm text-ink-3">
								{t("topologyWorkspace.empty")}
							</p>
							{sessions.length > 0 ? (
								<div className="max-h-64 overflow-y-auto rounded-lg border border-line text-left">
									{sessions.map((s) => (
										<div
											key={s.id}
											className="flex items-center border-b border-line/60 last:border-b-0"
										>
											<button
												type="button"
												onClick={() => selectSession(s.id)}
												className="min-w-0 flex-1 px-3 py-2 text-left text-sm transition-colors hover:bg-paper-2"
											>
												<span className="truncate">
													{s.title || s.id.slice(0, 8)}
												</span>
											</button>
											<SessionContextStatusChip
												sessionId={s.id}
												className="mr-2 shrink-0"
											/>
										</div>
									))}
								</div>
							) : (
								<p className="text-xs text-ink-3">
									{t("topologyWorkspace.evidence.empty")}
								</p>
							)}
						</div>
					</div>
				) : (
					/* ── Workspace layout ── */
					<div className="flex min-h-0 flex-1 flex-col lg:flex-row">
						{/* ── Session selector sidebar ── */}
						<aside className="shrink-0 max-h-36 overflow-y-auto border-b border-line p-2 lg:max-h-none lg:w-52 lg:border-b-0 lg:border-r">
							<div className="mb-1 px-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-ink-3">
								{t("topologyWorkspace.title")}
							</div>
							{sessions.map((s) => (
								<div key={s.id} className="flex items-center">
									<button
										type="button"
										onClick={() => selectSession(s.id)}
										className={cn(
											"min-w-0 flex-1 rounded-md px-2 py-1.5 text-left text-sm transition-colors",
											s.id === sessionId
												? "bg-paper-3 text-ink"
												: "text-ink-2 hover:bg-paper-2",
										)}
									>
										<span className="truncate">
											{s.title || s.id.slice(0, 8)}
										</span>
									</button>
									<SessionContextStatusChip
										sessionId={s.id}
										active={s.id === sessionId}
										className="shrink-0"
									/>
								</div>
							))}
						</aside>

						{/* ── Main: graph canvas ── */}
						<main className="flex min-h-0 min-w-0 flex-1 flex-col p-2">
							<div className="flex min-h-0 min-w-0 flex-1 flex-col gap-2 p-2">
								<ContextSavingsCard />
								<div className="flex items-center gap-2 rounded-md border border-line bg-paper-2 px-2 py-1.5">
									<span className="font-mono text-2xs uppercase tracking-meta text-ink-3">focus query</span>
									<input
										type="text"
										value={focusQuery}
										onChange={(e) => {
											setFocusQuery(e.target.value);
											const next = new URLSearchParams(searchParams);
											if (e.target.value) next.set("q", e.target.value);
											else next.delete("q");
											setSearchParams(next);
										}}
										placeholder={activeQuery || "leave empty to use the active chat's last turn"}
										className="flex-1 rounded border border-line bg-paper px-2 py-1 text-xs text-ink placeholder:text-ink-4"
									/>
									{focusLoading ? <span className="font-mono text-2xs text-ink-3">loading…</span> : null}
									{focusError ? <span className="font-mono text-2xs text-danger">{focusError}</span> : null}
									{effectiveQuery && focusIds.size > 0 ? (
										<span className="font-mono text-2xs text-accent">{focusIds.size} nodes highlighted</span>
									) : null}
								</div>
								<TopologyGraph
									graph={graph}
									loading={graphLoading}
									error={graphError ?? undefined}
									selectedNodeId={selectedNodeId}
									onSelectNode={setSelectedNodeId}
									focusIds={focusIds}
									className="flex-1"
								/>
							</div>
						</main>

						{/* ── Right panel: inspector + evidence + pack ──
						     On mobile this flows below the graph in normal
						     document order — never covering the SVG.  */}
						<aside className="shrink-0 overflow-y-auto border-t border-line p-3 lg:w-72 lg:border-l lg:border-t-0">
							<div className="space-y-4">
								{/* Selected node inspector */}
								<NodeInspector
									node={selectedNode}
									selectedNodeId={selectedNodeId}
									t={t}
								/>

								{/* Context replacement evidence timeline */}
								<ContextEvidenceTimeline
									events={evidence}
									loading={evidenceLoading}
									sessionId={sessionId}
								/>

								{/* Context pack */}
								<ContextPackPanel
									sessionId={sessionId}
									className="border-line border"
								/>
							</div>
						</aside>
					</div>
				)}
			</div>
		}/>
	);
}

// ── Node inspector (complementary to the graph's inline selected-node detail) ──

function NodeInspector({
	node,
	selectedNodeId,
	t,
}: {
	node: SessionContextNode | null;
	selectedNodeId: string | null;
	t: TFunction;
}) {
	if (!node) {
		if (selectedNodeId) {
			return (
				<div className="rounded-md border border-line p-2">
					<p className="text-xs text-ink-3">Node not found.</p>
				</div>
			);
		}
		return (
			<div className="rounded-md border border-line p-2">
				<h4 className="text-[10px] font-semibold uppercase tracking-[0.18em] text-ink-3">
					{t("topologyWorkspace.graph.selectedNode")}
				</h4>
				<p className="mt-1 text-xs text-ink-3">Click a node in the graph to inspect it.</p>
			</div>
		);
	}

	return (
		<div className="rounded-md border border-line p-2">
			<h4 className="text-[10px] font-semibold uppercase tracking-[0.18em] text-ink-3">
				{t("topologyWorkspace.graph.selectedNode")}
			</h4>
			<div className="mt-2 space-y-1.5 text-xs">
				<div className="flex items-start gap-1.5">
					<span className="shrink-0 text-ink-3">Title:</span>
					<span className="font-medium text-ink">{node.title}</span>
				</div>
				<div className="flex items-start gap-1.5">
					<span className="shrink-0 text-ink-3">Kind:</span>
					<span className="text-ink">{node.kind}</span>
				</div>
				{node.sourceTurnIndex != null && (
					<div className="flex items-start gap-1.5">
						<span className="shrink-0 text-ink-3">Turn:</span>
						<span className="text-ink">{node.sourceTurnIndex}</span>
					</div>
				)}
				{node.importance > 0 && (
					<div className="flex items-start gap-1.5">
						<span className="shrink-0 text-ink-3">Importance:</span>
						<span className="text-ink">
							{Math.round(node.importance * 100)}%
						</span>
					</div>
				)}
				{node.compressedBody && (
					<div className="border-t border-line/60 pt-1.5">
						<div className="mb-0.5 text-ink-3">Body:</div>
						<div className="max-h-32 overflow-y-auto whitespace-pre-wrap break-words text-ink-2">
							{node.compressedBody}
						</div>
					</div>
				)}
			</div>
		</div>
	);
}
