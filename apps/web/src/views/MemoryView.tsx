import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Brain, Loader2, Search } from "lucide-react";
import type { MemoryBankSummary, MemoryGraphNode, MemoryGraphResponse, MemoryItem, MemoryStatusResponse } from "@omp-deck/protocol";
import { useTranslation } from "react-i18next";

import { Layout } from "@/components/Layout";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";

/**
 * Memory Cockpit — browse and search the agent's Mnemopi long-term memory.
 *
 * Shows memory backend status (bank counts, embedding/graph stats) and
 * provides FTS-backed text search across all memory banks.
 */
export function MemoryView() {
	const { t } = useTranslation();
	const [status, setStatus] = useState<MemoryStatusResponse | null>(null);
	const [statusLoading, setStatusLoading] = useState(true);
	const [statusError, setStatusError] = useState<string | null>(null);
	const [query, setQuery] = useState("");
	const [results, setResults] = useState<MemoryItem[]>([]);
	const [searching, setSearching] = useState(false);
	const [hasSearched, setHasSearched] = useState(false);
	const [selectedBank, setSelectedBank] = useState<string | null>(null);
	const [graphQuery, setGraphQuery] = useState("");
	const [graphDraftQuery, setGraphDraftQuery] = useState("");
	const [memoryGraph, setMemoryGraph] = useState<MemoryGraphResponse | null>(null);
	const [graphLoading, setGraphLoading] = useState(false);
	const [selectedGraphNodeId, setSelectedGraphNodeId] = useState<string | null>(null);
	const graphRequestSeq = useRef(0);

	const refreshStatus = useCallback(async (): Promise<void> => {
		setStatusLoading(true);
		setStatusError(null);
		try {
			const next = await api.getMemoryStatus();
			setStatus(next);
		} catch (err) {
			setStatus(null);
			setStatusError(err instanceof Error ? err.message : String(err));
		} finally {
			setStatusLoading(false);
		}
	}, []);

	useEffect(() => {
		void refreshStatus();
	}, [refreshStatus]);

	const runSearch = useCallback(async (q: string): Promise<void> => {
		setSearching(true);
		setHasSearched(true);
		try {
			const res = await api.searchMemories(q);
			setResults(res.items);
		} catch {
			setResults([]);
		} finally {
			setSearching(false);
		}
	}, []);

	const loadGraph = useCallback(async (q: string): Promise<void> => {
		const requestSeq = graphRequestSeq.current + 1;
		graphRequestSeq.current = requestSeq;
		setGraphLoading(true);
		setSelectedGraphNodeId(null);
		try {
			const graph = await api.getMemoryGraph({ bank: selectedBank, q, limit: 120 });
			if (graphRequestSeq.current === requestSeq) setMemoryGraph(graph);
		} catch {
			if (graphRequestSeq.current === requestSeq) setMemoryGraph(null);
		} finally {
			if (graphRequestSeq.current === requestSeq) setGraphLoading(false);
		}
	}, [selectedBank]);

	useEffect(() => {
		if (status?.available) void loadGraph(graphQuery);
	}, [graphQuery, loadGraph, status?.available]);

	// Load all memories on first mount if backend is available
	useEffect(() => {
		if (status?.available) void runSearch("");
	}, [status?.available, runSearch]);

	const visibleResults = useMemo(
		() => results.filter((item) => selectedBank === null || item.bank === selectedBank),
		[results, selectedBank],
	);

	return (
		<Layout
			sidebar={null}
			topBar={null}
			main={
				<div className="mx-auto flex h-full max-w-4xl flex-col gap-4 overflow-y-auto p-6">
					{/* Header */}
					<div className="flex items-center gap-2">
						<Brain className="h-5 w-5 text-accent" />
						<h1 className="font-mono text-sm uppercase tracking-meta text-ink-2">{t("memory.title")}</h1>
					</div>

					{/* Status */}
					{statusLoading ? (
						<div className="flex items-center gap-2 text-ink-3">
							<Loader2 className="h-4 w-4 animate-spin" />
						</div>
					) : status ? (
						<StatusSection status={status} selectedBank={selectedBank} onSelectBank={setSelectedBank} />
					) : statusError ? (
						<div className="rounded-md border border-line bg-paper-2 p-4 font-mono text-2xs text-ink-3">
							<div className="text-ink-2">{t("memory.statusLoadFailed")}</div>
							<div className="mt-1 break-words text-ink-4">{statusError}</div>
							<button type="button" className="btn-ghost mt-3 h-8 px-3 text-xs" onClick={() => void refreshStatus()}>
								{t("memory.retry")}
							</button>
						</div>
					) : null}

					{status?.available ? (
						<MemoryGraphPanel
							graph={memoryGraph}
							loading={graphLoading}
							query={graphDraftQuery}
							onQueryChange={setGraphDraftQuery}
							onSubmitQuery={() => setGraphQuery(graphDraftQuery)}
							selectedNodeId={selectedGraphNodeId}
							onSelectNode={setSelectedGraphNodeId}
						/>
					) : null}

					{/* Search */}
					{status?.available ? (
						<div className="flex flex-col gap-3">
							<div className="flex items-center gap-2">
								<div className="relative flex-1">
									<Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-4" />
									<input
										type="text"
										value={query}
										onChange={(e) => setQuery(e.target.value)}
										onKeyDown={(e) => {
											if (e.key === "Enter") void runSearch(query);
										}}
										placeholder={t("memory.searchPlaceholder")}
										className="w-full rounded-md border border-line bg-paper-2 px-8 py-1.5 font-mono text-xs text-ink outline-none focus:border-accent"
									/>
								</div>
								<button
									type="button"
									onClick={() => void runSearch(query)}
									className="btn-ghost h-8 px-3 text-xs"
								>
									{searching ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : t("memory.search")}
								</button>
							</div>

							{/* Results */}
							<div className="flex flex-col gap-2">
								{searching ? (
									<div className="flex items-center gap-2 py-4 text-ink-3">
										<Loader2 className="h-4 w-4 animate-spin" />
									</div>
								) : visibleResults.length === 0 ? (
									<div className="py-4 font-mono text-2xs text-ink-3">
										{selectedBank ? t("memory.noBankResults", { bank: selectedBank }) : hasSearched && query ? t("memory.noResults") : t("memory.noQuery")}
									</div>
								) : (
									visibleResults.map((item) => (
										<MemoryCard key={`${item.bank}:${item.id}`} item={item} />
									))
								)}
							</div>
						</div>
					) : null}
				</div>
			}
			inspector={null}
		/>
	);
}

function StatusSection({
	status,
	selectedBank,
	onSelectBank,
}: {
	status: MemoryStatusResponse;
	selectedBank: string | null;
	onSelectBank: (bank: string | null) => void;
}) {
	const { t } = useTranslation();

	if (!status.available) {
		return (
			<div className="rounded-md border border-line bg-paper-2 p-4 font-mono text-2xs text-ink-3">
				{status.message ?? t("memory.unavailable")}
			</div>
		);
	}

	const stats = [
		{ label: t("memory.working"), value: status.totalWorking },
		{ label: t("memory.episodic"), value: status.totalEpisodic },
		{ label: t("memory.facts"), value: status.totalFacts },
		{ label: t("memory.embeddings"), value: status.totalEmbeddings },
		{ label: t("memory.graphEdges"), value: status.totalGraphEdges },
	];

	return (
		<div className="flex flex-col gap-3">
			<div className="flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-2xs text-ink-3">
				<span>
					{t("memory.backend")}: <span className="text-accent">{status.backend}</span>
				</span>
				<span className="text-ink-4">·</span>
				<span>
					{t("memory.banks")}: {status.banks.length}
				</span>
				{selectedBank ? (
					<>
						<span className="text-ink-4">·</span>
						<button type="button" className="text-accent underline-offset-2 hover:underline" onClick={() => onSelectBank(null)}>
							{t("memory.clearBankFilter", { bank: selectedBank })}
						</button>
					</>
				) : null}
			</div>

			<div className="flex flex-wrap gap-2">
				{stats.map((s) => (
					<div key={s.label} className="rounded-md border border-line bg-paper-2 px-3 py-1.5">
						<div className="font-mono text-sm font-semibold text-ink">{s.value}</div>
						<div className="font-mono text-2xs uppercase tracking-meta text-ink-3">{s.label}</div>
					</div>
				))}
			</div>

			<MemoryTopology status={status} selectedBank={selectedBank} onSelectBank={onSelectBank} />

			{/* Bank details */}
			<div className="flex flex-col gap-1">
				{status.banks.map((b) => (
					<button
						type="button"
						key={b.bank}
						onClick={() => onSelectBank(selectedBank === b.bank ? null : b.bank)}
						className={cn(
							"flex items-center gap-3 rounded-md border bg-paper-2 px-3 py-1.5 text-left font-mono text-2xs text-ink-3 transition-colors",
							selectedBank === b.bank ? "border-accent/70 bg-accent/5" : "border-line hover:border-ink-4",
						)}
					>
						<span className="text-ink-2">{b.bank}</span>
						<span className="text-ink-4">·</span>
						<span>W:{b.workingCount}</span>
						<span>E:{b.episodicCount}</span>
						<span>F:{b.factCount}</span>
						<span>emb:{b.embeddingCount}</span>
						<span>G:{b.graphEdgeCount}</span>
					</button>
				))}
			</div>
		</div>
	);
}

function MemoryTopology({
	status,
	selectedBank,
	onSelectBank,
}: {
	status: MemoryStatusResponse;
	selectedBank: string | null;
	onSelectBank: (bank: string | null) => void;
}) {
	const { t } = useTranslation();
	const width = 760;
	const height = 360;
	const center = { x: width / 2, y: height / 2 };
	const bankRadius = 125;
	const maxBankTotal = Math.max(1, ...status.banks.map(totalBankCount));

	const bankNodes = status.banks.map((bank, index) => {
		const angle = (Math.PI * 2 * index) / Math.max(status.banks.length, 1) - Math.PI / 2;
		const x = center.x + Math.cos(angle) * bankRadius;
		const y = center.y + Math.sin(angle) * bankRadius;
		const total = totalBankCount(bank);
		const radius = 13 + Math.sqrt(total / maxBankTotal) * 15;
		return { bank, angle, x, y, total, radius };
	});

	return (
		<div className="rounded-lg border border-line bg-paper-2 p-3">
			<div className="mb-2 flex items-center justify-between gap-2 font-mono text-2xs text-ink-3">
				<span className="uppercase tracking-meta">{t("memory.topology")}</span>
				<span>{t("memory.topologyHint")}</span>
			</div>
			<svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={t("memory.topologyAria")} className="h-[330px] w-full overflow-visible">
				<defs>
					<filter id="memory-node-glow" x="-40%" y="-40%" width="180%" height="180%">
						<feGaussianBlur stdDeviation="5" result="blur" />
						<feMerge>
							<feMergeNode in="blur" />
							<feMergeNode in="SourceGraphic" />
						</feMerge>
					</filter>
				</defs>
				<circle cx={center.x} cy={center.y} r={bankRadius} className="fill-none stroke-line/20" strokeWidth="1" strokeDasharray="3 4" />
				{bankNodes.map((node) => (
					<line key={`edge:${node.bank.bank}`} x1={center.x} y1={center.y} x2={node.x} y2={node.y} className="stroke-line" strokeWidth="1.5" />
				))}
				<g
					role="button"
					tabIndex={0}
					onClick={() => onSelectBank(null)}
					onKeyDown={(event) => {
						if (event.key !== "Enter" && event.key !== " ") return;
						event.preventDefault();
						onSelectBank(null);
					}}
					className="cursor-pointer outline-none"
				>
					<title>{t("memory.allBanks")}</title>
					<circle cx={center.x} cy={center.y} r="38" className="fill-paper stroke-accent" strokeWidth="2" />
					<text x={center.x} y={center.y - 3} textAnchor="middle" className="fill-ink font-mono text-[11px] font-semibold">
						Mnemopi
					</text>
					<text x={center.x} y={center.y + 13} textAnchor="middle" className="fill-ink-3 font-mono text-[9px]">
						{t("memory.allBanks")}
					</text>
				</g>
				{bankNodes.map((node) => (
					<BankTopologyNode key={node.bank.bank} node={node} selected={selectedBank === node.bank.bank} onSelectBank={onSelectBank} />
				))}
			</svg>
		</div>
	);
}

function BankTopologyNode({
	node,
	selected,
	onSelectBank,
}: {
	node: { bank: MemoryBankSummary; angle: number; x: number; y: number; total: number; radius: number };
	selected: boolean;
	onSelectBank: (bank: string | null) => void;
}) {
	const { t } = useTranslation();
	const stores = [
		{ label: "W", count: node.bank.workingCount },
		{ label: "E", count: node.bank.episodicCount },
		{ label: "F", count: node.bank.factCount },
		{ label: "emb", count: node.bank.embeddingCount },
		{ label: "G", count: node.bank.graphEdgeCount },
	];
	const storeRadius = node.radius + 28;
	const labelOut = {
		x: node.x + Math.cos(node.angle) * (node.radius + 14),
		y: node.y + Math.sin(node.angle) * (node.radius + 14) + 4,
	};
	const labelAnchor = Math.abs(Math.cos(node.angle)) < 0.3 ? "middle" : Math.cos(node.angle) >= 0 ? "start" : "end";

	return (
		<g
			role="button"
			tabIndex={0}
			onClick={() => onSelectBank(selected ? null : node.bank.bank)}
			onKeyDown={(event) => {
				if (event.key !== "Enter" && event.key !== " ") return;
				event.preventDefault();
				onSelectBank(selected ? null : node.bank.bank);
			}}
			className="cursor-pointer outline-none"
		>
			<title>{t("memory.bankTopologyTitle", { bank: node.bank.bank, count: node.total })}</title>
			<circle cx={node.x} cy={node.y} r={storeRadius} className="fill-none stroke-line/15" strokeWidth="1" />
			{stores.map((store, index) => {
				const angle = node.angle + (index - 2) * 0.28;
				const x = node.x + Math.cos(angle) * storeRadius;
				const y = node.y + Math.sin(angle) * storeRadius;
				const storeNodeRadius = store.count > 0 ? 5 + Math.min(8, Math.sqrt(store.count) / 3) : 4;
				return (
					<g key={`${node.bank.bank}:${store.label}`}>
						<line x1={node.x} y1={node.y} x2={x} y2={y} className="stroke-line/70" strokeWidth="1" />
						<circle cx={x} cy={y} r={storeNodeRadius} className={store.count > 0 ? "fill-accent/40 stroke-accent/70" : "fill-paper stroke-line"} />
						<text x={x} y={y + storeNodeRadius + 9} textAnchor="middle" className="fill-ink-4 font-mono text-[7px]">
							{store.label}
						</text>
					</g>
				);
			})}
			<circle
				cx={node.x}
				cy={node.y}
				r={node.radius}
				className={selected ? "fill-accent/20 stroke-accent" : "fill-paper stroke-ink-4"}
				strokeWidth={selected ? 2.5 : 1.5}
				filter={selected ? "url(#memory-node-glow)" : undefined}
			/>
			<text x={node.x} y={node.y + 4} textAnchor="middle" className="fill-ink font-mono text-[10px] font-semibold">
				{node.total}
			</text>
			<text x={labelOut.x} y={labelOut.y} textAnchor={labelAnchor} className="fill-ink-2 font-mono text-[9px]">
				{node.bank.bank}
			</text>
		</g>
	);
}

function totalBankCount(bank: MemoryBankSummary): number {
	return bank.workingCount + bank.episodicCount + bank.factCount + bank.embeddingCount + bank.graphEdgeCount;
}

function MemoryGraphPanel({
	graph,
	loading,
	query,
	onQueryChange,
	onSubmitQuery,
	selectedNodeId,
	onSelectNode,
}: {
	graph: MemoryGraphResponse | null;
	loading: boolean;
	query: string;
	onQueryChange: (query: string) => void;
	onSubmitQuery: () => void;
	selectedNodeId: string | null;
	onSelectNode: (nodeId: string | null) => void;
}) {
	const { t } = useTranslation();
	const selectedNode = graph?.nodes.find((node) => node.id === selectedNodeId) ?? null;

	return (
		<div className="rounded-lg border border-line bg-paper-2 p-3">
			<div className="mb-3 flex flex-wrap items-center gap-2">
				<div className="relative min-w-64 flex-1">
					<Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-4" />
					<input
						type="text"
						value={query}
						onChange={(event) => onQueryChange(event.target.value)}
						onKeyDown={(event) => {
							if (event.key === "Enter") onSubmitQuery();
						}}
						placeholder={t("memory.graphSearchPlaceholder")}
						className="w-full rounded-md border border-line bg-paper px-8 py-1.5 font-mono text-xs text-ink outline-none focus:border-accent"
					/>
				</div>
				<button type="button" className="btn-ghost h-8 px-3 text-xs" onClick={onSubmitQuery}>
					{t("memory.graphSearch")}
				</button>
				<div className="font-mono text-2xs text-ink-3">
					{loading ? t("memory.graphLoading") : graph ? t("memory.graphStats", { nodes: graph.nodes.length, edges: graph.edges.length }) : t("memory.graphEmpty")}
					{graph?.truncated ? <span className="ml-2 text-accent">{t("memory.graphTruncated", { total: graph.totalNodes })}</span> : null}
				</div>
			</div>
			{graph && graph.nodes.length > 0 ? (
				<MemoryGraphSvg graph={graph} selectedNodeId={selectedNodeId} onSelectNode={onSelectNode} />
			) : (
				<div className="py-6 text-center font-mono text-2xs text-ink-3">{loading ? t("memory.graphLoading") : t("memory.graphEmpty")}</div>
			)}
			{selectedNode ? <MemoryGraphNodeDetails node={selectedNode} /> : null}
		</div>
	);
}

function MemoryGraphSvg({
	graph,
	selectedNodeId,
	onSelectNode,
}: {
	graph: MemoryGraphResponse;
	selectedNodeId: string | null;
	onSelectNode: (nodeId: string | null) => void;
}) {
	const width = 760;
	const height = 320;
	const center = { x: width / 2, y: height / 2 };
	const radius = Math.min(width, height) * 0.36;
	const positions = new Map(graph.nodes.map((node, index) => {
		const angle = (Math.PI * 2 * index) / Math.max(graph.nodes.length, 1) - Math.PI / 2;
		return [node.id, { x: center.x + Math.cos(angle) * radius, y: center.y + Math.sin(angle) * radius }];
	}));

	return (
		<svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Memory graph retrieval topology" className="h-[300px] w-full overflow-visible rounded-md border border-line bg-paper">
			{graph.edges.map((edge, index) => {
				const source = positions.get(edge.source);
				const target = positions.get(edge.target);
				if (!source || !target) return null;
				const weight = typeof edge.weight === "number" ? edge.weight : 1;
				const strokeWidth = 0.8 + Math.min(4, Math.max(0.1, weight) * 2.5);
				const midX = (source.x + target.x) / 2;
				const midY = (source.y + target.y) / 2;
				return (
					<g key={`${edge.source}:${edge.target}:${edge.relation}:${index}`}>
						<title>{`${edge.relation} · weight ${weight.toFixed(3)}`}</title>
						<line x1={source.x} y1={source.y} x2={target.x} y2={target.y} className="stroke-accent/35" strokeWidth={strokeWidth} />
						<text x={midX} y={midY - 3} textAnchor="middle" className="fill-accent/70 font-mono text-[7px]">
							{weight.toFixed(2)}
						</text>
					</g>
				);
			})}
			{graph.nodes.map((node) => {
				const position = positions.get(node.id);
				if (!position) return null;
				const degree = node.inbound + node.outbound;
				const selected = selectedNodeId === node.id;
				const r = 7 + Math.min(10, Math.sqrt(degree + 1) * 2);
				return (
					<g
						key={node.id}
						role="button"
						tabIndex={0}
						onClick={() => onSelectNode(selected ? null : node.id)}
						onKeyDown={(event) => {
							if (event.key !== "Enter" && event.key !== " ") return;
							event.preventDefault();
							onSelectNode(selected ? null : node.id);
						}}
						className="cursor-pointer outline-none"
					>
						<title>{node.content}</title>
						<circle cx={position.x} cy={position.y} r={r} className={selected ? "fill-accent/30 stroke-accent" : "fill-paper-2 stroke-ink-4"} strokeWidth={selected ? 2.5 : 1.4} />
						<text x={position.x} y={position.y + r + 10} textAnchor="middle" className="fill-ink-3 font-mono text-[7px]">
							{node.memoryId.slice(0, 10)}
						</text>
					</g>
				);
			})}
		</svg>
	);
}

function MemoryGraphNodeDetails({ node }: { node: MemoryGraphNode }) {
	const { t } = useTranslation();
	return (
		<div className="mt-3 rounded-md border border-line bg-paper px-3 py-2 font-mono text-2xs text-ink-3">
			<div className="mb-1 text-ink-2">{t("memory.graphSelectedNode")}: {node.memoryId}</div>
			<p className="whitespace-pre-wrap break-words text-xs text-ink-2">{node.content}</p>
			<div className="mt-2 flex flex-wrap gap-x-3 gap-y-1">
				<span>{t("memory.bank")}: {node.bank}</span>
				<span>{t("memory.type")}: {node.memoryType ?? node.kind}</span>
				<span>in:{node.inbound}</span>
				<span>out:{node.outbound}</span>
			</div>
		</div>
	);
}

function MemoryCard({ item }: { item: MemoryItem }) {
	const { t } = useTranslation();
	const [expanded, setExpanded] = useState(false);
	const content = item.content ?? "";
	const preview = expanded ? content : content.slice(0, 280);
	const showTruncated = item.contentTruncated && !expanded;

	return (
		<div
			className="cursor-pointer rounded-md border border-line bg-paper-2 p-3 transition-colors hover:border-ink-4"
			onClick={() => setExpanded(!expanded)}
		>
			<div className="flex items-start justify-between gap-2">
				<p className="flex-1 whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-ink-2">
					{preview}
					{content.length > 280 && !expanded ? "…" : null}
					{showTruncated ? <span className="ml-1 text-accent/70">(truncated)</span> : null}
				</p>
			</div>
			<div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-0.5 font-mono text-2xs text-ink-4">
				{item.bank ? (
					<span>
						{t("memory.bank")}: <span className="text-ink-3">{item.bank}</span>
					</span>
				) : null}
				{item.memoryType ? (
					<span>
						{t("memory.type")}: <span className="text-ink-3">{item.memoryType}</span>
					</span>
				) : null}
				{typeof item.importance === "number" ? (
					<span>
						{t("memory.importance")}: <span className="text-ink-3">{item.importance.toFixed(2)}</span>
					</span>
				) : null}
				{typeof item.recallCount === "number" && item.recallCount > 0 ? (
					<span className="text-ink-3">{t("memory.recallCount", { count: item.recallCount })}</span>
				) : null}
				{item.source ? (
					<span>
						{t("memory.source")}: <span className="text-ink-3">{item.source}</span>
					</span>
				) : null}
			</div>
		</div>
	);
}
