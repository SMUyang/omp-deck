import { memo, useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import {
	ArrowLeft,
	BookOpen,
	ChevronDown,
	ChevronRight,
	Eye,
	File as FileIcon,
	FilePlus,
	FileText,
	Folder,
	FolderOpen,
	Link2,
	Link2Off,
	Loader2,
	Pencil,
	Save,
	Search,
	X,
} from "lucide-react";
import { useNavigate, useSearchParams } from "react-router-dom";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import type { KbFileResponse, KbTreeEntry, KbTreeResponse } from "@omp-deck/protocol";

import { Layout } from "@/components/Layout";
import { CopyButton } from "@/lib/CopyButton";
import { kbApi } from "@/lib/kb-api";
import { useStore } from "@/lib/store";
import { cn } from "@/lib/utils";

/**
 * /kb — Karpathy-style llm-wiki viewer. Sidebar = tree; main = markdown
 * viewer (resolves [[wikilinks]] to in-app navigation); inspector =
 * frontmatter + outbound list. URL state in `?path=<rel>` drives the open
 * file; back/forward works.
 *
 * Editor (T-36) and graph view (T-37/38) plug into this shell.
 */
export function KbView() {
	const [params, setParams] = useSearchParams();
	const currentPath = params.get("path") ?? undefined;

	const setCurrentPath = useCallback(
		(p: string | undefined) => {
			const next = new URLSearchParams(params);
			if (p) next.set("path", p);
			else next.delete("path");
			setParams(next, { replace: false });
		},
		[params, setParams],
	);

	// On mobile (<lg), tree and viewer can't share a column; we slide between
	// them. At lg+ both render side-by-side and this flag is inert.
	const [mobileDetailOpen, setMobileDetailOpen] = useState(Boolean(currentPath));
	useEffect(() => {
		if (currentPath) setMobileDetailOpen(true);
	}, [currentPath]);

	const kbChangeCounter = useStore((s) => s.kbChangeCounter);

	return (
		<Layout
			sidebar={<KbSidebar />}
			inspector={<KbInspector currentPath={currentPath} kbChangeCounter={kbChangeCounter} />}
			main={
				<div className="flex h-full min-h-0 flex-col">
					<KbTopBar
						currentPath={currentPath}
						mobileDetailOpen={mobileDetailOpen}
						onBack={() => {
							setMobileDetailOpen(false);
							setCurrentPath(undefined);
						}}
					/>
					<div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[minmax(0,18rem)_minmax(0,1fr)]">
						<div
							className={cn(
								"min-h-0 overflow-y-auto border-line lg:block lg:border-r",
								mobileDetailOpen ? "hidden" : "block",
							)}
						>
							<KbTree
								currentPath={currentPath}
								onSelect={(p) => {
									setCurrentPath(p);
									setMobileDetailOpen(true);
								}}
								kbChangeCounter={kbChangeCounter}
							/>
						</div>
						<div
							className={cn(
								"min-h-0 overflow-y-auto lg:block",
								mobileDetailOpen ? "block" : "hidden lg:block",
							)}
						>
							{currentPath ? (
								<KbFilePane path={currentPath} onNavigate={(p) => setCurrentPath(p)} kbChangeCounter={kbChangeCounter} />
							) : (
								<KbEmpty />
							)}
						</div>
					</div>
				</div>
			}
		/>
	);
}

function KbTopBar({
	currentPath,
	mobileDetailOpen,
	onBack,
}: {
	currentPath: string | undefined;
	mobileDetailOpen: boolean;
	onBack: () => void;
}) {
	return (
		<div className="flex h-10 shrink-0 items-center gap-2 border-b border-line bg-paper px-3">
			{mobileDetailOpen ? (
				<button
					type="button"
					onClick={onBack}
					aria-label="Back to tree"
					className="-ml-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-ink-3 transition-colors hover:bg-paper-3 hover:text-ink lg:hidden"
				>
					<ArrowLeft className="h-4 w-4" />
				</button>
			) : null}
			<BookOpen className="h-4 w-4 text-accent" aria-hidden="true" />
			<div className="meta">Knowledge</div>
			<div className="min-w-0 truncate font-mono text-xs text-ink-3">{currentPath ?? "browse"}</div>
		</div>
	);
}

function KbEmpty() {
	return (
		<div className="flex h-full flex-col items-center justify-center px-6 py-10 text-center">
			<BookOpen className="h-6 w-6 text-ink-4" />
			<div className="mt-3 text-sm text-ink-2">Pick a file from the tree.</div>
			<div className="mt-1 max-w-sm text-xs text-ink-3">
				The KB cockpit reads your wiki at <span className="font-mono text-ink-2">~/kb</span>. Top-level
				<span className="font-mono"> projects/</span> is excluded by default.
			</div>
		</div>
	);
}

// ─── Tree ────────────────────────────────────────────────────────────────

function KbSidebar() {
	return (
		<div className="flex h-full min-h-0 flex-col">
			<div className="border-b border-line px-3 py-2">
				<div className="meta">Knowledge</div>
				<div className="mt-0.5 text-xs text-ink-3">
					Filters and tag chips land in T-39. For now, browse the tree on the right.
				</div>
			</div>
			<div className="min-h-0 flex-1 px-3 py-2 text-xs text-ink-3">
				The cockpit reads <span className="font-mono">~/kb</span> via{" "}
				<span className="font-mono">OMP_DECK_KB_ROOT</span>.{" "}
				<span className="font-mono">projects/</span> is excluded by default.
			</div>
		</div>
	);
}

function KbTree({
	currentPath,
	onSelect,
	kbChangeCounter,
}: {
	currentPath: string | undefined;
	onSelect: (p: string) => void;
	kbChangeCounter: number;
}) {
	return (
		<div className="flex h-full min-h-0 flex-col">
			<div className="border-b border-line px-3 py-2">
				<div className="meta">Knowledge</div>
				<div className="mt-0.5 text-xs text-ink-3">
					Your Karpathy-style llm-wiki. Click a file to open; wikilinks navigate in-app.
				</div>
			</div>
			<div className="min-h-0 flex-1 overflow-y-auto py-1">
				<TreeBranch path="" depth={0} expanded openOnMount currentPath={currentPath} onSelect={onSelect} kbChangeCounter={kbChangeCounter} />
			</div>
		</div>
	);
}

function TreeBranch({
	path,
	depth,
	expanded: expandedDefault,
	openOnMount,
	currentPath,
	onSelect,
	kbChangeCounter,
}: {
	path: string;
	depth: number;
	expanded: boolean;
	openOnMount?: boolean;
	currentPath: string | undefined;
	onSelect: (p: string) => void;
	kbChangeCounter: number;
}) {
	const [expanded, setExpanded] = useState(expandedDefault);
	const [data, setData] = useState<KbTreeResponse | null>(null);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | undefined>();

	const fetchHere = useCallback(async () => {
		setLoading(true);
		try {
			const r = await kbApi.tree(path);
			setData(r);
			setError(undefined);
		} catch (e) {
			setError(String((e as Error).message ?? e));
		} finally {
			setLoading(false);
		}
	}, [path]);

	useEffect(() => {
		if (!expanded) return;
		void fetchHere();
	}, [expanded, fetchHere, kbChangeCounter]);

	useEffect(() => {
		if (openOnMount) setExpanded(true);
	}, [openOnMount]);

	return (
		<div>
			{data ? (
				<>
					{data.dirs.map((d) => (
						<TreeDir
							key={d.path}
							entry={d}
							depth={depth}
							currentPath={currentPath}
							onSelect={onSelect}
							kbChangeCounter={kbChangeCounter}
						/>
					))}
					{data.files.map((f) => (
						<TreeFile key={f.path} entry={f} depth={depth} active={currentPath === f.path} onSelect={onSelect} />
					))}
				</>
			) : null}
			{loading && !data ? (
				<div className="px-3 py-1.5 text-xs text-ink-3">
					<Loader2 className="mr-1 inline-block h-3 w-3 animate-spin" /> loading
				</div>
			) : null}
			{error ? (
				<div className="px-3 py-1.5 font-mono text-2xs text-danger">{error}</div>
			) : null}
		</div>
	);
}

function TreeDir({
	entry,
	depth,
	currentPath,
	onSelect,
	kbChangeCounter,
}: {
	entry: KbTreeEntry;
	depth: number;
	currentPath: string | undefined;
	onSelect: (p: string) => void;
	kbChangeCounter: number;
}) {
	const [expanded, setExpanded] = useState(false);
	const Chevron = expanded ? ChevronDown : ChevronRight;
	const FolderIcon = expanded ? FolderOpen : Folder;
	return (
		<div>
			<button
				type="button"
				onClick={() => setExpanded((x) => !x)}
				className={cn(
					"flex w-full items-center gap-1 px-2 py-1 text-left text-sm transition-colors hover:bg-paper-3",
				)}
				style={{ paddingLeft: 8 + depth * 12 }}
			>
				<Chevron className="h-3 w-3 shrink-0 text-ink-3" />
				<FolderIcon className="h-3.5 w-3.5 shrink-0 text-ink-3" />
				<span className="min-w-0 truncate text-ink-2">{entry.name}</span>
				{entry.symlink ? (
					<span className="font-mono text-2xs uppercase text-ink-4" title="symlink/junction">→</span>
				) : null}
				{typeof entry.mdCount === "number" ? (
					<span className="ml-auto font-mono text-2xs text-ink-4">{entry.mdCount}</span>
				) : null}
			</button>
			{expanded ? (
				<TreeBranch
					path={entry.path}
					depth={depth + 1}
					expanded
					currentPath={currentPath}
					onSelect={onSelect}
					kbChangeCounter={kbChangeCounter}
				/>
			) : null}
		</div>
	);
}

function TreeFile({
	entry,
	depth,
	active,
	onSelect,
}: {
	entry: KbTreeEntry;
	depth: number;
	active: boolean;
	onSelect: (p: string) => void;
}) {
	return (
		<button
			type="button"
			onClick={() => onSelect(entry.path)}
			className={cn(
				"flex w-full items-center gap-1 px-2 py-1 text-left text-sm transition-colors",
				active ? "bg-accent-soft/40 text-ink" : "text-ink-2 hover:bg-paper-3",
			)}
			style={{ paddingLeft: 8 + depth * 12 + 16 }}
		>
			<FileText className="h-3.5 w-3.5 shrink-0 text-ink-3" />
			<span className="min-w-0 truncate">{entry.name.replace(/\.md$/i, "")}</span>
		</button>
	);
}

// ─── File pane ───────────────────────────────────────────────────────────

function KbFilePane({
	path,
	onNavigate,
	kbChangeCounter,
}: {
	path: string;
	onNavigate: (p: string) => void;
	kbChangeCounter: number;
}) {
	const [file, setFile] = useState<KbFileResponse | null>(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | undefined>();

	// Edit state. When `draft === null` we're in view mode; once the user
	// hits Edit, we capture the rawContent into `draft` and switch.
	const [draft, setDraft] = useState<string | null>(null);
	const [saving, setSaving] = useState(false);
	const [saveError, setSaveError] = useState<string | undefined>();

	const dirty = draft !== null && file !== null && draft !== file.rawContent;
	const editing = draft !== null;

	useEffect(() => {
		// Don't blow away the user's buffer when the watcher fires for a
		// file they're editing — defer the refetch until they exit edit mode.
		if (editing) return;
		let cancelled = false;
		setLoading(true);
		setError(undefined);
		kbApi
			.file(path)
			.then((d) => {
				if (cancelled) return;
				setFile(d);
			})
			.catch((e) => {
				if (cancelled) return;
				setError(String((e as Error).message ?? e));
				setFile(null);
			})
			.finally(() => {
				if (cancelled) return;
				setLoading(false);
			});
		return () => {
			cancelled = true;
		};
	}, [path, kbChangeCounter, editing]);

	const startEdit = useCallback(() => {
		if (!file) return;
		setDraft(file.rawContent);
		setSaveError(undefined);
	}, [file]);

	const cancelEdit = useCallback(() => {
		if (dirty && !window.confirm("Discard unsaved changes?")) return;
		setDraft(null);
		setSaveError(undefined);
	}, [dirty]);

	const save = useCallback(async () => {
		if (draft === null || !file) return;
		setSaving(true);
		setSaveError(undefined);
		try {
			const next = await kbApi.put(file.path, draft);
			setFile(next);
			setDraft(null);
		} catch (e) {
			setSaveError(String((e as Error).message ?? e));
		} finally {
			setSaving(false);
		}
	}, [draft, file]);

	// Ctrl/Cmd-S saves; Esc discards.
	useEffect(() => {
		if (!editing) return;
		function onKey(e: KeyboardEvent): void {
			if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
				e.preventDefault();
				void save();
			} else if (e.key === "Escape") {
				e.preventDefault();
				cancelEdit();
			}
		}
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [editing, save, cancelEdit]);

	const handleWikilink = useCallback(
		(href: string) => {
			if (href.startsWith("kb-link:")) {
				const raw = href.slice("kb-link:".length);
				const [target] = raw.split("?", 1);
				onNavigate(decodeURI(target));
				return true;
			}
			if (href.startsWith("kb-unresolved:")) {
				const target = decodeURIComponent(href.slice("kb-unresolved:".length));
				if (file) void createUnresolved(target, file.path, onNavigate);
				return true;
			}
			return false;
		},
		[onNavigate, file],
	);

	if (loading && !file) {
		return (
			<div className="flex items-center gap-2 px-4 py-3 text-sm text-ink-3">
				<Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading {path}…
			</div>
		);
	}
	if (error) {
		return (
			<div className="mx-3 mt-2 rounded-md border border-danger/30 bg-danger/10 px-3 py-2 font-mono text-xs text-danger">
				{error}
			</div>
		);
	}
	if (!file) return <KbEmpty />;

	return (
		<div className="flex h-full flex-col">
			<div className="border-b border-line px-4 py-3">
				<div className="flex items-center gap-2">
					<div className="min-w-0">
						<h1 className="truncate text-base font-medium text-ink">
							{typeof file.frontmatter?.name === "string" && (file.frontmatter.name as string).trim()
								? (file.frontmatter.name as string)
								: titleFromPath(file.path)}
							{dirty ? <span className="ml-1 text-warn" title="unsaved changes">●</span> : null}
						</h1>
						<div className="mt-1 font-mono text-2xs text-ink-3">{file.path}</div>
					</div>
					<div className="ml-auto flex items-center gap-1">
						{editing ? (
							<>
								<button
									type="button"
									onClick={() => void save()}
									disabled={!dirty || saving}
									className="btn-ghost inline-flex h-7 items-center gap-1 px-2 text-xs disabled:opacity-50"
									title="Save (Ctrl-S)"
								>
									{saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
									Save
								</button>
								<button
									type="button"
									onClick={cancelEdit}
									className="btn-ghost inline-flex h-7 items-center gap-1 px-2 text-xs"
									title="Discard (Esc)"
								>
									<X className="h-3.5 w-3.5" />
									Cancel
								</button>
							</>
						) : (
							<button
								type="button"
								onClick={startEdit}
								className="btn-ghost inline-flex h-7 items-center gap-1 px-2 text-xs"
								title="Edit (or click anywhere in the body)"
							>
								<Pencil className="h-3.5 w-3.5" />
								Edit
							</button>
						)}
					</div>
				</div>
				{file.frontmatterError ? (
					<div className="mt-2 rounded-md border border-warn/30 bg-warn/10 px-2 py-1 font-mono text-2xs text-warn">
						frontmatter: {file.frontmatterError}
					</div>
				) : null}
				{saveError ? (
					<div className="mt-2 rounded-md border border-danger/30 bg-danger/10 px-2 py-1 font-mono text-2xs text-danger">
						save failed: {saveError}
					</div>
				) : null}
			</div>
			<div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
				{editing ? (
					<textarea
						value={draft}
						onChange={(e) => setDraft(e.target.value)}
						spellCheck={false}
						autoFocus
						className="h-full min-h-[60vh] w-full resize-none whitespace-pre-wrap break-words rounded-md border border-line bg-paper-2 p-3 font-mono text-xs leading-relaxed text-ink focus:border-accent focus:outline-none"
					/>
				) : (
					<KbMarkdown body={file.bodyForRender} onWikilink={handleWikilink} />
				)}
			</div>
		</div>
	);
}

/**
 * Prompt the user to create a file for an unresolved wikilink target. The
 * filename defaults to the bare target (cleaned for filesystem safety);
 * directory defaults to the current file's parent. Cancel = no-op.
 */
async function createUnresolved(target: string, currentFilePath: string, onNavigate: (p: string) => void): Promise<void> {
	const currentDir = currentFilePath.includes("/") ? currentFilePath.slice(0, currentFilePath.lastIndexOf("/")) : "";
	const slug = target.replace(/[\\:*?"<>|]/g, "-").replace(/\.md$/i, "");
	const defaultPath = currentDir ? `${currentDir}/${slug}.md` : `${slug}.md`;
	const proposed = window.prompt(
		`Create a new kb file for unresolved wikilink "${target}"?\nPath (relative to kb root):`,
		defaultPath,
	);
	if (!proposed) return;
	const normalized = proposed.trim().replace(/\\/g, "/").replace(/^\/+/, "");
	if (!normalized.toLowerCase().endsWith(".md")) {
		window.alert("Path must end in .md");
		return;
	}
	const today = new Date().toISOString().slice(0, 10);
	const stub = `---\ntype: knowledge\ncreated: ${today}\nupdated: ${today}\ntags: []\n---\n\n# ${target}\n\n`;
	try {
		await kbApi.create(normalized, stub);
		onNavigate(normalized);
	} catch (e) {
		window.alert(`create failed: ${(e as Error).message ?? e}`);
	}
}

// ─── Inspector ───────────────────────────────────────────────────────────

function KbInspector({
	currentPath,
	kbChangeCounter,
}: {
	currentPath: string | undefined;
	kbChangeCounter: number;
}) {
	const [file, setFile] = useState<KbFileResponse | null>(null);
	useEffect(() => {
		if (!currentPath) {
			setFile(null);
			return;
		}
		let cancelled = false;
		kbApi.file(currentPath).then((d) => {
			if (!cancelled) setFile(d);
		}).catch(() => {
			if (!cancelled) setFile(null);
		});
		return () => {
			cancelled = true;
		};
	}, [currentPath, kbChangeCounter]);

	if (!currentPath) {
		return <div className="px-3 py-4 text-xs text-ink-3">Pick a file to inspect.</div>;
	}

	return (
		<div className="flex h-full flex-col">
			<div className="border-b border-line px-3 py-2">
				<div className="meta">Inspector</div>
				<div className="mt-0.5 text-xs text-ink-3">Frontmatter and outbound links.</div>
			</div>
			<div className="space-y-3 overflow-y-auto px-3 py-3 text-xs">
				{file ? (
					<>
						<DefRow k="path" v={<span className="break-all font-mono text-2xs">{file.path}</span>} />
						<DefRow k="size" v={<span className="font-mono text-2xs">{formatBytes(file.size)}</span>} />
						<DefRow k="updated" v={<span className="font-mono text-2xs">{formatTime(file.mtime)}</span>} />
						<FrontmatterBlock fm={file.frontmatter} />
						<OutboundBlock links={file.outgoingLinks} />
					</>
				) : (
					<div className="text-ink-3">loading…</div>
				)}
			</div>
		</div>
	);
}

function DefRow({ k, v }: { k: string; v: ReactNode }) {
	return (
		<div>
			<div className="font-mono text-2xs uppercase tracking-meta text-ink-4">{k}</div>
			<div className="mt-0.5 text-ink-2">{v}</div>
		</div>
	);
}

function FrontmatterBlock({ fm }: { fm: Record<string, unknown> }) {
	const entries = Object.entries(fm).filter(([k]) => k !== "_raw");
	if (entries.length === 0) {
		return <div className="text-2xs text-ink-3">no frontmatter</div>;
	}
	return (
		<div>
			<div className="font-mono text-2xs uppercase tracking-meta text-ink-4">frontmatter</div>
			<dl className="mt-1 space-y-0.5 font-mono text-2xs">
				{entries.map(([k, v]) => (
					<div key={k} className="flex items-baseline gap-2">
						<dt className="text-ink-4">{k}</dt>
						<dd className="break-all text-ink-2">{formatValue(v)}</dd>
					</div>
				))}
			</dl>
		</div>
	);
}

function OutboundBlock({ links }: { links: KbFileResponse["outgoingLinks"] }) {
	if (links.length === 0) {
		return <div className="text-2xs text-ink-3">no outbound links</div>;
	}
	const resolved = links.filter((l) => l.resolved);
	const unresolved = links.filter((l) => !l.resolved);
	return (
		<div>
			<div className="font-mono text-2xs uppercase tracking-meta text-ink-4">
				outbound ({links.length})
			</div>
			<ul className="mt-1 space-y-0.5 font-mono text-2xs">
				{resolved.map((l, i) => (
					<li key={`r-${i}`} className="flex items-center gap-1.5 text-ink-2">
						<Link2 className="h-3 w-3 shrink-0 text-ink-3" />
						<span className="truncate">{l.label}</span>
					</li>
				))}
				{unresolved.map((l, i) => (
					<li key={`u-${i}`} className="flex items-center gap-1.5 text-ink-3" title={l.unresolvedReason}>
						<Link2Off className="h-3 w-3 shrink-0" />
						<span className="truncate italic">{l.label}</span>
					</li>
				))}
			</ul>
		</div>
	);
}

// ─── Wikilink-aware Markdown ─────────────────────────────────────────────

interface WikiAnchorProps extends React.AnchorHTMLAttributes<HTMLAnchorElement> {
	href?: string;
	children?: ReactNode;
}

const KbMarkdown = memo(function KbMarkdown({
	body,
	onWikilink,
}: {
	body: string;
	onWikilink: (href: string) => boolean;
}) {
	const Anchor = useCallback(
		({ href, children, ...rest }: WikiAnchorProps) => {
			const isKbLink = href?.startsWith("kb-link:") ?? false;
			const isUnresolved = href?.startsWith("kb-unresolved:") ?? false;
			const cls = isKbLink
				? "text-accent underline decoration-accent/40 underline-offset-2 hover:decoration-accent"
				: isUnresolved
					? "text-ink-3 italic underline decoration-dotted decoration-ink-4 hover:text-ink-2"
					: undefined;
			const onClick: React.MouseEventHandler<HTMLAnchorElement> = (e) => {
				if (!href) return;
				if (isKbLink || isUnresolved) {
					if (onWikilink(href)) e.preventDefault();
				}
			};
			return (
				<a {...rest} href={href} onClick={onClick} className={cls}>
					{children}
				</a>
			);
		},
		[onWikilink],
	);
	return (
		<div className="markdown text-sm">
			<ReactMarkdown
				remarkPlugins={[remarkGfm]}
				rehypePlugins={[[rehypeHighlight, { detect: true, ignoreMissing: true }]]}
				urlTransform={kbUrlTransform}
				components={{ pre: CopyablePre, a: Anchor }}
			>
				{body}
			</ReactMarkdown>
		</div>
	);
});

/**
 * Allow `kb-link:` and `kb-unresolved:` URI schemes through react-markdown's
 * default sanitizer. Without this override, react-markdown rewrites unknown
 * schemes to empty strings before our custom `a` component sees them, so
 * wikilink clicks fall through to a default-href anchor that does nothing.
 */
function kbUrlTransform(url: string): string {
	if (url.startsWith("kb-link:") || url.startsWith("kb-unresolved:")) return url;
	if (/^(https?:|mailto:|tel:|#|\/)/i.test(url)) return url;
	return "";
}

function CopyablePre({ children, ...rest }: React.HTMLAttributes<HTMLPreElement> & { children?: ReactNode }) {
	return (
		<div className="group relative">
			<pre {...rest}>{children}</pre>
			<CopyButton />
		</div>
	);
}

// ─── helpers ─────────────────────────────────────────────────────────────

function titleFromPath(p: string): string {
	const last = p.split("/").pop() ?? p;
	return last.replace(/\.md$/i, "");
}

function formatBytes(n: number): string {
	if (n < 1024) return `${n}B`;
	if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}K`;
	return `${(n / (1024 * 1024)).toFixed(1)}M`;
}

function formatTime(iso: string): string {
	try {
		return new Date(iso).toLocaleString();
	} catch {
		return iso;
	}
}

function formatValue(v: unknown): string {
	if (v === null || v === undefined) return "—";
	if (Array.isArray(v)) return v.map((x) => formatValue(x)).join(", ");
	if (typeof v === "object") return JSON.stringify(v);
	return String(v);
}
