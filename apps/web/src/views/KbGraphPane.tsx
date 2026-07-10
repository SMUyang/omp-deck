import { lazy, memo, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ForceGraphMethods } from "react-force-graph-2d";

// Lazy-load the browser-only graph library so that module evaluation
// does not require `window` (force-graph reads `window.innerWidth` at init).
const ForceGraph2D = lazy(() => import("react-force-graph-2d"));
import { AlertTriangle, EyeOff, Loader2, Search } from "lucide-react";
import type { KbGraphEdge, KbGraphNode, KbGraphResponse } from "@omp-deck/protocol";

import { kbApi } from "@/lib/kb-api";
import { cn } from "@/lib/utils";

/**
 * Obsidian-style force-directed graph over the KB. Nodes coloured by top-level
 * directory, sized by inbound degree. Click a node to open its file in the
 * viewer (the parent KbView handles the URL state). Designed to handle the
 * v1 scale (~800 nodes / ~5000 edges) on a canvas surface — d3-force keeps
 * the simulation smooth past 10k nodes if we ever grow that far.
 */
export const KbGraphPane = memo(function KbGraphPane({
	currentPath,
	onSelect,
	kbChangeCounter,
}: {
	currentPath: string | undefined;
	onSelect: (path: string) => void;
	kbChangeCounter: number;
}) {
	const [data, setData] = useState<KbGraphResponse | null>(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | undefined>();
	const [search, setSearch] = useState("");
	const [hideOrphans, setHideOrphans] = useState(false);
	const [isolatedDir, setIsolatedDir] = useState<string | null>(null);

	useEffect(() => {
		let cancelled = false;
		setLoading(true);
		kbApi
			.graph()
			.then((g) => {
				if (cancelled) return;
				setData(g);
				setError(undefined);
			})
			.catch((e) => {
				if (cancelled) return;
				setError(String((e as Error).message ?? e));
			})
			.finally(() => {
				if (cancelled) return;
				setLoading(false);
			});
		return () => {
			cancelled = true;
		};
	}, [kbChangeCounter]);

	const dirs = useMemo(() => {
		if (!data) return [] as { name: string; count: number; color: string }[];
		const counts = new Map<string, number>();
		for (const n of data.nodes) {
			const key = n.dir || "(root)";
			counts.set(key, (counts.get(key) ?? 0) + 1);
		}
		return Array.from(counts.entries())
			.map(([name, count]) => ({ name, count, color: colorForDir(name) }))
			.sort((a, b) => b.count - a.count);
	}, [data]);

	// Filtered view — applied to both the rendered graph and the legend
	// counts so the user can see what their filter is excluding.
	const filtered = useMemo(() => {
		if (!data) return { nodes: [], links: [] as Array<{ source: string; target: string }> };
		const q = search.trim().toLowerCase();
		const matchesSearch = (n: KbGraphNode): boolean => {
			if (!q) return true;
			if (n.title.toLowerCase().includes(q)) return true;
			if (n.path.toLowerCase().includes(q)) return true;
			if (n.tags.some((t) => t.toLowerCase().includes(q))) return true;
			return false;
		};
		const keep = new Set<string>();
		for (const n of data.nodes) {
			if (hideOrphans && n.inbound === 0 && n.outbound === 0) continue;
			if (isolatedDir && (n.dir || "(root)") !== isolatedDir) continue;
			if (!matchesSearch(n)) continue;
			keep.add(n.path);
		}
		const nodes = data.nodes
			.filter((n) => keep.has(n.path))
			.map<DisplayNode>((n) => ({
				id: n.path,
				path: n.path,
				title: n.title,
				dir: n.dir,
				inbound: n.inbound,
				outbound: n.outbound,
				tags: n.tags,
			}));
		const links = data.edges
			.filter((e) => keep.has(e.source) && keep.has(e.target))
			.map<DisplayLink>((e) => ({ source: e.source, target: e.target }));
		return { nodes, links };
	}, [data, search, hideOrphans, isolatedDir]);

	const containerRef = useRef<HTMLDivElement | null>(null);
	const [size, setSize] = useState<{ width: number; height: number }>({ width: 800, height: 600 });
	useEffect(() => {
		const el = containerRef.current;
		if (!el) return;
		const ro = new ResizeObserver((entries) => {
			const e = entries[0];
			if (!e) return;
			setSize({ width: Math.floor(e.contentRect.width), height: Math.floor(e.contentRect.height) });
		});
		ro.observe(el);
		return () => ro.disconnect();
	}, []);

	const fgRef = useRef<ForceGraphMethods | undefined>(undefined);
	useEffect(() => {
		// On every data swap, give the simulation a small zoom-out so the user
		// sees the whole graph by default. Done as a one-off after mount;
		// react-force-graph handles its own warmup.
		const id = setTimeout(() => fgRef.current?.zoomToFit(400, 50), 600);
		return () => clearTimeout(id);
	}, [filtered.nodes.length]);

	const onNodeClick = useCallback(
		(n: DisplayNode) => {
			onSelect(n.path);
		},
		[onSelect],
	);

	return (
		<div className="relative flex h-full min-h-0 flex-col">
			<div className="flex h-10 shrink-0 items-center gap-2 border-b border-line bg-paper px-3">
				<div className="meta">Graph</div>
				<div className="text-xs text-ink-3">
					{loading
						? "loading..."
						: data
							? `${filtered.nodes.length} / ${data.totalNodes} nodes · ${filtered.links.length} edges`
							: ""}
				</div>
				{data?.truncated ? (
					<span
						className="inline-flex items-center gap-1 rounded bg-warn/15 px-1.5 py-0.5 font-mono text-2xs text-warn"
						title="Graph truncated at the v1 cap"
					>
						<AlertTriangle className="h-3 w-3" /> truncated
					</span>
				) : null}
				<div className="flex-1" />
				<button
					type="button"
					onClick={() => setHideOrphans((x) => !x)}
					className={cn(
						"btn-ghost inline-flex h-7 items-center gap-1 px-2 text-xs",
						hideOrphans && "text-accent",
					)}
					title="Toggle orphan visibility"
				>
					<EyeOff className="h-3.5 w-3.5" />
					orphans
				</button>
				<div className="flex items-center gap-2 rounded-md border border-line bg-paper-2 px-2 py-1 text-xs">
					<Search className="h-3.5 w-3.5 text-ink-3" />
					<input
						value={search}
						onChange={(e) => setSearch(e.target.value)}
						placeholder="Filter by title, path, or tag"
						className="w-full bg-transparent text-ink placeholder:text-ink-4 focus:outline-none sm:w-56"
					/>
				</div>
			</div>

			{error ? (
				<div className="mx-3 mt-2 rounded-md border border-danger/30 bg-danger/10 px-3 py-2 font-mono text-xs text-danger">
					{error}
				</div>
			) : null}

			<div ref={containerRef} className="relative min-h-0 flex-1 overflow-hidden bg-paper">
				{loading && !data ? (
					<div className="absolute inset-0 flex items-center justify-center text-sm text-ink-3">
						<Loader2 className="mr-2 h-4 w-4 animate-spin" /> building graph…
					</div>
				) : null}
				{data ? (
					<Suspense
						fallback={
							<div className="absolute inset-0 flex items-center justify-center text-sm text-ink-3">
								<Loader2 className="mr-2 h-4 w-4 animate-spin" /> loading graph…
							</div>
						}
					>
						<ForceGraph2D
							ref={fgRef}
							graphData={{ nodes: filtered.nodes, links: filtered.links }}
							width={size.width}
							height={size.height}
							nodeId="id"
							nodeLabel={(n) => {
								const node = n as DisplayNode;
								return `${node.title}\n${node.path}\n← ${node.inbound} · ${node.outbound} →`;
							}}
							nodeColor={(n) => {
								const node = n as DisplayNode;
								if (currentPath && node.path === currentPath) return "#f97316"; // tailwind orange-500 (matches rust accent)
								return colorForDir(node.dir || "(root)");
							}}
							nodeRelSize={2.2}
							nodeVal={(n) => {
								const node = n as DisplayNode;
								return 1 + Math.log2(1 + node.inbound) * 1.5;
							}}
							linkColor={() => "rgba(160,160,160,0.22)"}
							linkWidth={0.6}
							linkDirectionalParticles={0}
							cooldownTicks={120}
							warmupTicks={60}
							onNodeClick={(n) => onNodeClick(n as DisplayNode)}
							enableNodeDrag={false}
						/>
					</Suspense>
				) : null}

				{data && !loading ? (
					<div className="pointer-events-auto absolute bottom-3 left-3 max-w-[16rem] rounded-md border border-line bg-paper/95 px-3 py-2 shadow-sm backdrop-blur">
						<div className="font-mono text-2xs uppercase tracking-meta text-ink-4">Sources</div>
						<ul className="mt-1 space-y-0.5 text-xs">
							{dirs.map((d) => (
								<li key={d.name}>
									<button
										type="button"
										onClick={() => setIsolatedDir(isolatedDir === d.name ? null : d.name)}
										className={cn(
											"flex w-full items-center gap-2 rounded px-1 py-0.5 text-left transition-colors",
											isolatedDir === d.name
												? "bg-accent-soft/40 text-ink"
												: "text-ink-2 hover:bg-paper-3",
										)}
									>
										<span
											className="h-2.5 w-2.5 shrink-0 rounded-full"
											style={{ backgroundColor: d.color }}
										/>
										<span className="truncate">{d.name}</span>
										<span className="ml-auto font-mono text-2xs text-ink-3">{d.count}</span>
									</button>
								</li>
							))}
						</ul>
						{isolatedDir ? (
							<div className="mt-1.5 text-2xs text-ink-3">
								Showing only <span className="font-mono">{isolatedDir}</span> ·{" "}
								<button
									type="button"
									className="text-accent underline-offset-2 hover:underline"
									onClick={() => setIsolatedDir(null)}
								>
									show all
								</button>
							</div>
						) : null}
					</div>
				) : null}
			</div>
		</div>
	);
});

/** Deterministic color per top-level dir. Keeps the palette stable across reloads. */
function colorForDir(name: string): string {
	switch (name) {
		case "cryptocracy":
			return "#a855f7"; // violet
		case "projects":
			return "#ef4444"; // red — distinct from cryptocracy violet
		case "domains":
			return "#3b82f6"; // blue
		case "tools":
			return "#10b981"; // emerald
		case "system":
			return "#eab308"; // amber
		case "writing":
			return "#ec4899"; // pink
		case "music":
			return "#06b6d4"; // cyan
		case "(root)":
			return "#94a3b8"; // slate
		default: {
			// Stable hash → HSL for any unanticipated provider.
			let h = 0;
			for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
			return `hsl(${h % 360},60%,55%)`;
		}
	}
}

interface DisplayNode {
	id: string;
	path: string;
	title: string;
	dir: string;
	inbound: number;
	outbound: number;
	tags: string[];
}

interface DisplayLink {
	source: string;
	target: string;
}
