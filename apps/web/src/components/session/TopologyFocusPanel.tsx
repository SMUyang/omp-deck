import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { Loader2, RefreshCw, Sparkles } from "lucide-react";

import { api } from "@/lib/api";
import type { SessionContextGraphResponse } from "@omp-deck/protocol";
import { TopologyGraph } from "@/components/session/TopologyGraph";
import { useStore, selectActiveSession } from "@/lib/store";
import { getNodeKindTone } from "@/lib/node-kind-tones";
import {
	latestUserText,
	parseTopologyFocus,
	splitQueryMatch,
	topologyFocusNodeIds,
	topologyFocusV1Projection,
	type TopologyFocus,
	type TopologyFocusV1,
} from "@/lib/topology-focus";
import { cn } from "@/lib/utils";
import type { SessionContextFocusResponse } from "@omp-deck/protocol";

const QUERY_HARD_CAP = 400;
const NODE_DISPLAY_CAP = 60;

interface FetchState {
	focus: TopologyFocus | null;
	emptyReason: string | null;
	truncated: boolean;
}

const INITIAL: FetchState = { focus: null, emptyReason: null, truncated: false };

export function TopologyFocusPanel() {
	const { t } = useTranslation();
	const session = useStore(selectActiveSession);
	const sessionId = session?.sessionId ?? null;
	const messages = session?.messages ?? [];
	const query = useMemo(() => latestUserText(messages as ReadonlyArray<{ role: string; text?: string }>), [messages]);
	const [state, setState] = useState<FetchState>(INITIAL);
	const [loading, setLoading] = useState(false);
	const [rebuilding, setRebuilding] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [tick, setTick] = useState(0);
	const [built, setBuilt] = useState<boolean | null>(null);

	useEffect(() => {
		if (!sessionId) {
			setState(INITIAL);
			setBuilt(null);
			return;
		}
		void api
			.getSessionContextStatus(sessionId)
			.then((s) => setBuilt(s.built))
			.catch(() => setBuilt(null));
	}, [sessionId, tick]);

	useEffect(() => {
		if (!sessionId) return;
		if (built === false) {
			setState({ focus: null, emptyReason: "session_not_built", truncated: false });
			return;
		}
		if (built !== true) return;
		setLoading(true);
		setError(null);
		api
			.getSessionContextFocus(sessionId, { q: query, contextPercent: 100 })
			.then((resp: SessionContextFocusResponse) => {
				const parsed = parseTopologyFocus(resp.focus);
				setState({
					focus: parsed,
					emptyReason: parsed ? null : (resp.emptyReason ?? "no_relevant_context"),
					truncated: Boolean(resp.truncated),
				});
			})
			.catch((err) => setError(err instanceof Error ? err.message : String(err)))
			.finally(() => setLoading(false));
	}, [sessionId, built, query, tick]);

	// ── Background graph for the mini topology preview ──
	const [graph, setGraph] = useState<SessionContextGraphResponse | null>(null);
	const [graphLoading, setGraphLoading] = useState(false);
	const focusIds = useMemo<Set<string>>(
		() => new Set(topologyFocusNodeIds(state.focus)),
		[state.focus],
	);
	useEffect(() => {
		if (!sessionId || built !== true) { setGraph(null); return; }
		let cancelled = false;
		setGraphLoading(true);
		api.getSessionContextGraph(sessionId, 80).then((g) => { if (!cancelled) setGraph(g); }).catch(() => { if (!cancelled) setGraph(null); }).finally(() => { if (!cancelled) setGraphLoading(false); });
		return () => { cancelled = true; };
	}, [sessionId, built, tick]);

	const navigate = useNavigate();
	const rebuild = async (): Promise<void> => {
		if (!sessionId) return;
		setRebuilding(true);
		setError(null);
		try {
			await api.rebuildSessionContext(sessionId);
			setTick((n) => n + 1);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setRebuilding(false);
		}
	};

	if (!sessionId) {
		return (
			<Empty>
				<span>{t("sessionContext.title")}</span>
			</Empty>
		);
	}

	return (
		<div className="flex h-full min-h-0 flex-col">
			<Header
				onRefresh={() => setTick((n) => n + 1)}
				onRebuild={rebuild}
				loading={loading}
				rebuilding={rebuilding}
			/>
			<div className="border-y border-line bg-paper-2/40 px-3 py-2 text-xs">
				<div className="font-mono text-2xs uppercase tracking-meta text-ink-3">
					{t("topologyFocus.query")}
				</div>
				{query ? (
					<div className="mt-0.5 line-clamp-3 text-ink-2">{truncate(query, QUERY_HARD_CAP)}</div>
				) : (
					<div className="mt-0.5 text-ink-3">{t("topologyFocus.queryEmpty")}</div>
				)}
			</div>

		{/* Mini topology: background graph with focus members highlighted. */}
		{built === true && (graphLoading || (graph && graph.nodes.length > 0)) ? (
			<div className="border-b border-line px-2 py-2">
				<TopologyGraph
					graph={graph}
					focusIds={focusIds}
					loading={graphLoading && !graph}
					variant="mini"
					focusOnly
				/>
			</div>
		) : null}

		{error ? (
				<div className="border-b border-line bg-danger-soft/30 px-3 py-2 text-xs text-danger">
					{t("topologyFocus.loadFailed")} {error}
				</div>
			) : null}
			<div className="flex-1 overflow-y-auto">
				{built === false ? (
					<NotBuilt
						busy={rebuilding}
						onRebuild={rebuild}
						error={error ? t("topologyFocus.rebuildFailed") : null}
					/>
				) : state.focus && topologyFocusNodeIds(state.focus).length > 0 ? (
					<NodeList
						focus={state.focus}
						truncated={state.truncated}
					/>
				) : loading ? (
					<Loading />
				) : (
					<Empty>
						{state.emptyReason === "no_relevant_context"
							? t("topologyFocus.empty")
							: t("topologyFocus.empty")}
					</Empty>
				)}
			</div>
			<button
				type="button"
				onClick={() => navigate("/topology")}
				className="border-t border-line bg-paper-2/40 px-3 py-2 text-left text-xs text-ink-3 hover:bg-paper-3 hover:text-ink"
			>
				{t("topologyFocus.openGraph")} →
			</button>
		</div>
	);
}

function Header({
	onRefresh,
	onRebuild,
	loading,
	rebuilding,
}: {
	onRefresh: () => void;
	onRebuild: () => void;
	loading: boolean;
	rebuilding: boolean;
}) {
	const { t } = useTranslation();
	return (
		<div className="flex items-center justify-between gap-2 border-b border-line px-3 py-2">
			<div className="flex items-center gap-1.5 text-ink-2">
				<Sparkles className="h-3.5 w-3.5 text-accent" />
				<span className="font-mono text-2xs uppercase tracking-meta">
					{t("topologyFocus.title")}
				</span>
			</div>
			<div className="flex items-center gap-1">
				<IconButton
					title={t("topologyFocus.rebuild")}
					onClick={onRebuild}
					disabled={rebuilding || loading}
				>
					{rebuilding ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "↻"}
				</IconButton>
				<IconButton title="refresh" onClick={onRefresh} disabled={loading || rebuilding}>
					<RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />
				</IconButton>
			</div>
		</div>
	);
}

function IconButton({
	children,
	...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement>) {
	return (
		<button
			type="button"
			{...rest}
			className="rounded p-1 text-ink-3 hover:bg-paper-3 hover:text-ink disabled:cursor-not-allowed disabled:opacity-50"
		>
			{children}
		</button>
	);
}

function NodeList({ focus, truncated }: { focus: TopologyFocus; truncated: boolean }) {
	const projected = topologyFocusV1Projection(focus);
	return <LegacyNodeList focus={projected} truncated={truncated} />;
}

function LegacyNodeList({ focus, truncated }: { focus: TopologyFocusV1; truncated: boolean }) {
	const { t } = useTranslation();
	const titleById = useMemo(() => {
		const m = new Map<string, string>();
		for (const n of focus.nodes) m.set(n.id, n.title);
		return m;
	}, [focus]);
	const shown = focus.nodes.slice(0, NODE_DISPLAY_CAP);
	const overflow = focus.nodes.length - shown.length;
	return (
		<div className="space-y-3 px-3 py-3">
			<div className="flex items-center gap-2 text-2xs text-ink-3">
				<span>{focus.nodes.length} {t("topologyFocus.nodes")}</span><span>·</span><span>{focus.edges.length} {t("topologyFocus.edges")}</span>
				{focus.artifactCount > 0 ? <><span>·</span><span>{focus.artifactCount} {t("topologyFocus.artifacts")}</span></> : null}
			</div>
			{shown.map((n, idx) => <FocusNodeCard key={n.id} node={n} rank={idx + 1} titleLookup={titleById} />)}
			{overflow > 0 ? <div className="text-2xs text-ink-3">{t("topologyFocus.more", { count: overflow })}</div> : null}
			{focus.edges.length > 0 ? <EdgeList edges={focus.edges} titleLookup={titleById} /> : null}
			{(truncated || focus.omittedNodeCount > 0) ? <div className="text-2xs text-ink-3">{t("topologyWorkspace.graph.truncated", { total: focus.nodes.length + focus.omittedNodeCount })}</div> : null}
		</div>
	);
}

function FocusNodeCard({
	node,
	rank,
}: {
	node: TopologyFocusV1["nodes"][number];
	rank: number;
	titleLookup: Map<string, string>;
}) {
	const { t } = useTranslation();
	const tone = getNodeKindTone(node.kind);
	const { text, matches } = splitQueryMatch(node.body);
	return (
		<div className="rounded-md border border-line bg-paper-2/60 p-2.5">
			<div className="flex items-center gap-1.5">
				<span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", tone.dot)} />
				<span
					className={cn(
						"shrink-0 rounded border px-1 py-0.5 font-mono text-2xs uppercase tracking-meta",
						tone.chip,
					)}
				>
					{tone.label}
				</span>
				<span className="font-mono text-2xs text-ink-3">#{rank}</span>
				{node.source.turnIndex !== undefined ? (
					<span className="ml-auto font-mono text-2xs text-ink-3">
						{t("topologyFocus.turn", { n: node.source.turnIndex + 1 })}
					</span>
				) : null}
			</div>
			<div className="mt-1.5 text-sm font-medium text-ink">{node.title}</div>
			{text ? <p className="mt-1 text-xs leading-relaxed text-ink-2">{text}</p> : null}
			{matches.length > 0 ? (
				<div className="mt-1.5 space-y-1">
					{matches.slice(0, 2).map((m, i) => (
						<div
							key={i}
							className="rounded border border-accent/30 bg-accent-soft/40 px-2 py-1 text-2xs text-accent"
						>
							<span className="mr-1 font-mono uppercase tracking-meta">{t("topologyFocus.match")}</span>
							<span className="text-ink-2">{truncate(m, 240)}</span>
						</div>
					))}
				</div>
			) : null}
		</div>
	);
}

function EdgeList({
	edges,
	titleLookup,
}: {
	edges: TopologyFocusV1["edges"];
	titleLookup: Map<string, string>;
}) {
	const { t } = useTranslation();
	return (
		<div className="rounded-md border border-line">
			<div className="border-b border-line bg-paper-2/40 px-2.5 py-1.5 font-mono text-2xs uppercase tracking-meta text-ink-3">
				{edges.length} {t("topologyFocus.edges")}
			</div>
			<ul className="divide-y divide-line text-xs">
				{edges.slice(0, 20).map((e, i) => {
					const src = titleLookup.get(e.sourceNodeId) ?? e.sourceNodeId.slice(0, 8);
					const dst = titleLookup.get(e.targetNodeId) ?? e.targetNodeId.slice(0, 8);
					return (
						<li key={`${e.sourceNodeId}-${e.targetNodeId}-${i}`} className="flex items-center gap-1.5 px-2.5 py-1">
							<span className="truncate text-ink-2">{src}</span>
							<span className="font-mono text-2xs text-ink-3">—{e.relation}→</span>
							<span className="truncate text-ink-2">{dst}</span>
						</li>
					);
				})}
				{edges.length > 20 ? (
					<li className="px-2.5 py-1 text-2xs text-ink-3">
						{t("topologyFocus.more", { count: edges.length - 20 })}
					</li>
				) : null}
			</ul>
		</div>
	);
}

function NotBuilt({ busy, onRebuild, error }: { busy: boolean; onRebuild: () => void; error: string | null }) {
	const { t } = useTranslation();
	return (
		<div className="flex h-full flex-col items-center justify-center gap-3 px-6 py-10 text-center">
			<div className="text-sm text-ink-2">{t("topologyFocus.notBuilt")}</div>
			<div className="text-xs text-ink-3">{t("topologyFocus.notBuiltHint")}</div>
			<button
				type="button"
				onClick={onRebuild}
				disabled={busy}
				className="mt-2 inline-flex items-center gap-1.5 rounded-md border border-line bg-paper-2 px-3 py-1.5 text-xs text-ink-2 hover:bg-paper-3 disabled:opacity-50"
			>
				{busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
				{busy ? t("topologyFocus.building") : t("topologyFocus.build")}
			</button>
			{error ? <div className="text-2xs text-danger">{error}</div> : null}
		</div>
	);
}

function Loading() {
	const { t } = useTranslation();
	return (
		<div className="flex items-center justify-center gap-2 px-3 py-10 text-xs text-ink-3">
			<Loader2 className="h-3.5 w-3.5 animate-spin" />
			{t("topologyWorkspace.graph.loading")}
		</div>
	);
}

function Empty({ children }: { children: React.ReactNode }) {
	return <div className="flex items-center justify-center px-6 py-10 text-xs text-ink-3">{children}</div>;
}

function truncate(s: string, n: number): string {
	return s.length > n ? `${s.slice(0, n)}…` : s;
}
