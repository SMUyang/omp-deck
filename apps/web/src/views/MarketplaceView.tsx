import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Download, Loader2, Plus, RotateCcw, Search, Trash2, X } from "lucide-react";
import type {
	ListMarketplaceResponse,
	MarketplaceCatalogEntry,
	MarketplaceSource,
} from "@omp-deck/protocol";

import { Layout } from "@/components/Layout";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { marketplaceApi } from "@/lib/marketplace-api";
import { cn } from "@/lib/utils";

type ScopeFilter = "all" | "installed" | "available";

export function MarketplaceView() {
	const { t } = useTranslation();
	const [data, setData] = useState<ListMarketplaceResponse | null>(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | undefined>();
	const [search, setSearch] = useState("");
	const [scope, setScope] = useState<ScopeFilter>("all");
	const [marketplaceFilter, setMarketplaceFilter] = useState<string | "all">("all");
	const [selectedId, setSelectedId] = useState<string | undefined>();
	const [busyId, setBusyId] = useState<string | undefined>();
	const [refreshing, setRefreshing] = useState(false);
	const [addOpen, setAddOpen] = useState(false);

	const refresh = useCallback(async (): Promise<void> => {
		try {
			const next = await marketplaceApi.list();
			setData(next);
			setError(undefined);
		} catch (e) {
			setError(String((e as Error).message ?? e));
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	const filtered = useMemo(() => {
		const catalog = data?.catalog ?? [];
		const q = search.trim().toLowerCase();
		return catalog
			.filter((entry) => {
				if (marketplaceFilter !== "all" && entry.marketplace !== marketplaceFilter) return false;
				if (scope === "installed" && !entry.installed) return false;
				if (scope === "available" && entry.installed) return false;
				if (!q) return true;
				const haystack = [
					entry.name,
					entry.marketplace,
					entry.description ?? "",
					entry.author ?? "",
					(entry.tags ?? []).join(" "),
				]
					.join(" ")
					.toLowerCase();
				return haystack.includes(q);
			})
			.sort((a, b) => a.name.localeCompare(b.name));
	}, [data, search, scope, marketplaceFilter]);

	const selected = filtered.find((entry) => entry.id === selectedId) ?? filtered[0];

	async function install(entry: MarketplaceCatalogEntry, installScope: "user" | "project" = "user"): Promise<void> {
		setBusyId(entry.id);
		setError(undefined);
		try {
			await marketplaceApi.install({ name: entry.name, marketplace: entry.marketplace, scope: installScope });
			await refresh();
		} catch (e) {
			setError(String((e as Error).message ?? e));
		} finally {
			setBusyId(undefined);
		}
	}

	async function uninstall(info: { id: string; scope: "user" | "project" }): Promise<void> {
		setBusyId(info.id);
		setError(undefined);
		try {
			await marketplaceApi.uninstall({ id: info.id, scope: info.scope });
			await refresh();
		} catch (e) {
			setError(String((e as Error).message ?? e));
		} finally {
			setBusyId(undefined);
		}
	}

	async function refreshSources(): Promise<void> {
		setRefreshing(true);
		setError(undefined);
		try {
			await marketplaceApi.refresh();
			await refresh();
		} catch (e) {
			setError(String((e as Error).message ?? e));
		} finally {
			setRefreshing(false);
		}
	}

	async function removeSource(name: string): Promise<void> {
		setError(undefined);
		try {
			await marketplaceApi.removeMarketplace(name);
			await refresh();
		} catch (e) {
			setError(String((e as Error).message ?? e));
		}
	}

	return (
		<>
			<Layout
				sidebar={{
					content: (
						<MarketplaceSidebar
							sources={data?.sources ?? []}
							counts={{
								all: data?.catalog.length ?? 0,
								installed: data?.installed.length ?? 0,
								available: (data?.catalog.length ?? 0) - (data?.installed.length ?? 0),
							}}
							scope={scope}
							onScope={setScope}
							marketplaceFilter={marketplaceFilter}
							onMarketplaceFilter={setMarketplaceFilter}
							onAdd={() => setAddOpen(true)}
							onRefresh={() => void refreshSources()}
							refreshing={refreshing}
							onRemoveSource={(name) => void removeSource(name)}
						/>
					),
					label: t("views.marketplace.sources"),
				}}
				inspector={{ content: <MarketplaceInspector entry={selected} />, label: t("views.marketplace.details") }}
				main={
					<div className="flex h-full min-h-0 flex-col">
						<div className="flex h-10 shrink-0 items-center gap-2 border-b border-line bg-paper px-3">
							<div className="meta">{t("views.marketplace.title")}</div>
							<div className="text-xs text-ink-3">
								{loading ? t("views.marketplace.loading") : `${filtered.length} / ${data?.catalog.length ?? 0}`}
							</div>
							<div className="flex-1" />
							<div className="flex items-center gap-2 rounded-md border border-line bg-paper-2 px-2 py-1 text-xs">
								<Search className="h-3.5 w-3.5 text-ink-3" />
								<input
									value={search}
									onChange={(e) => setSearch(e.target.value)}
									placeholder={t("views.marketplace.searchPlaceholder")}
									className="w-56 bg-transparent text-ink placeholder:text-ink-4 focus:outline-none"
								/>
							</div>
						</div>
						{error ? (
							<div className="mx-3 mt-2 rounded-md border border-danger/30 bg-danger/10 px-3 py-2 font-mono text-xs text-danger">
								{error}
							</div>
						) : null}
						<div className="min-h-0 flex-1 overflow-y-auto p-3">
							{loading && !data ? (
								<div className="px-3 py-6 text-center text-sm text-ink-3">{t("views.marketplace.loadingCatalog")}</div>
							) : null}
							{!loading && (data?.sources.length ?? 0) === 0 ? (
								<EmptySources onAdd={() => setAddOpen(true)} onAdded={() => void refresh()} />
							) : null}
							{filtered.length === 0 && !loading && (data?.sources.length ?? 0) > 0 ? (
								<div className="px-3 py-6 text-center text-sm text-ink-3">
									{t("views.marketplace.noMatches")}
								</div>
							) : null}
							<div className="grid grid-cols-1 gap-2 md:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2">
								{filtered.map((entry) => (
									<EntryCard
										key={entry.id}
										entry={entry}
										isSelected={selected?.id === entry.id}
										busy={busyId === entry.id}
										onSelect={() => setSelectedId(entry.id)}
										onInstall={() => void install(entry)}
										onUninstall={() =>
											entry.installed ? void uninstall({ id: entry.id, scope: entry.installed.scope }) : undefined
										}
									/>
								))}
							</div>
						</div>
					</div>
				}
			/>
			<AddMarketplaceModalHost
				open={addOpen}
				onClose={() => setAddOpen(false)}
				onAdded={() => void refresh()}
			/>
		</>
	);
}

function MarketplaceSidebar({
	sources,
	counts,
	scope,
	onScope,
	marketplaceFilter,
	onMarketplaceFilter,
	onAdd,
	onRefresh,
	refreshing,
	onRemoveSource,
}: {
	sources: MarketplaceSource[];
	counts: { all: number; installed: number; available: number };
	scope: ScopeFilter;
	onScope: (s: ScopeFilter) => void;
	marketplaceFilter: string | "all";
	onMarketplaceFilter: (s: string | "all") => void;
	onAdd: () => void;
	onRefresh: () => void;
	refreshing: boolean;
	onRemoveSource: (name: string) => void;
}) {
	const { t } = useTranslation();
	return (
		<div className="flex h-full min-h-0 flex-col">
			<div className="flex h-10 shrink-0 items-center gap-2 border-b border-line px-3">
				<div className="meta">{t("views.marketplace.catalog")}</div>
			</div>
			<div className="space-y-2 px-2 pt-2">
				<ScopeRow label={t("views.marketplace.all")} count={counts.all} active={scope === "all"} onClick={() => onScope("all")} />
				<ScopeRow
					label={t("views.marketplace.installed")}
					count={counts.installed}
					active={scope === "installed"}
					onClick={() => onScope("installed")}
				/>
				<ScopeRow
					label={t("views.marketplace.available")}
					count={counts.available}
					active={scope === "available"}
					onClick={() => onScope("available")}
				/>
			</div>
			<div className="mt-4 flex h-7 items-center justify-between px-3">
				<div className="meta">{t("views.marketplace.sources")}</div>
				<div className="flex items-center gap-1">
					<button
						type="button"
						className="text-ink-3 hover:text-ink"
						onClick={onRefresh}
						title={t("views.marketplace.refreshTitle")}
						disabled={refreshing}
					>
						{refreshing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RotateCcw className="h-3.5 w-3.5" />}
					</button>
					<button type="button" className="text-ink-3 hover:text-ink" onClick={onAdd} title={t("views.marketplace.addMarketplace")}>
						<Plus className="h-3.5 w-3.5" />
					</button>
				</div>
			</div>
			<div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
				<button
					type="button"
					onClick={() => onMarketplaceFilter("all")}
					className={cn(
						"flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-sm",
						marketplaceFilter === "all" ? "bg-accent-soft text-accent" : "text-ink-2 hover:bg-paper-3",
					)}
				>
					<span className="truncate">{t("views.marketplace.allMarketplaces")}</span>
				</button>
				{sources.map((source) => (
					<div
						key={source.name}
						className={cn(
							"group flex w-full items-center gap-1 rounded-md px-2 py-1.5 text-sm",
							marketplaceFilter === source.name ? "bg-accent-soft text-accent" : "text-ink-2 hover:bg-paper-3",
						)}
					>
						<button
							type="button"
							onClick={() => onMarketplaceFilter(source.name)}
							className="min-w-0 flex-1 truncate text-left"
							title={source.sourceUri}
						>
							{source.name}
						</button>
						<button
							type="button"
							className="opacity-0 transition-opacity hover:text-danger group-hover:opacity-100"
							title={t("views.marketplace.removeSource", { name: source.name })}
							onClick={() => onRemoveSource(source.name)}
						>
							<X className="h-3.5 w-3.5" />
						</button>
					</div>
				))}
			</div>
		</div>
	);
}

function ScopeRow({ label, count, active, onClick }: { label: string; count: number; active: boolean; onClick: () => void }) {
	return (
		<button
			type="button"
			onClick={onClick}
			className={cn(
				"flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-sm",
				active ? "bg-accent-soft text-accent" : "text-ink-2 hover:bg-paper-3",
			)}
		>
			<span>{label}</span>
			<span className="font-mono text-2xs text-ink-3">{count}</span>
		</button>
	);
}

const SUGGESTED_MARKETPLACES: ReadonlyArray<{ source: string; label: string; descriptionKey: string }> = [
	{
		source: "anthropics/claude-plugins-official",
		label: "Anthropic official",
		descriptionKey: "views.marketplace.suggestedAnthropic",
	},
];

function EmptySources({ onAdd, onAdded }: { onAdd: () => void; onAdded: () => void }) {
	const { t } = useTranslation();
	const [adding, setAdding] = useState<string | undefined>();
	const [error, setError] = useState<string | undefined>();
	const [addedName, setAddedName] = useState<string | undefined>();

	async function addSuggested(source: string): Promise<void> {
		setAdding(source);
		setError(undefined);
		try {
			const resp = await marketplaceApi.addMarketplace(source);
			setAddedName(resp.marketplace.name);
			onAdded();
		} catch (e) {
			setError(String((e as Error).message ?? e));
		} finally {
			setAdding(undefined);
		}
	}
	return (
		<div className="mx-auto max-w-xl space-y-3 rounded-md border border-dashed border-line bg-paper-2 p-6">
			<div className="text-center">
				<div className="meta">{t("views.marketplace.noMarketplaces")}</div>
				<p className="mt-1 text-sm text-ink-3">
					{t("views.marketplace.noMarketplacesHint")}
				</p>
			</div>
			<div className="space-y-2">
				<div className="meta">{t("views.marketplace.suggested")}</div>
				{SUGGESTED_MARKETPLACES.map((m) => (
					<div
						key={m.source}
						className="flex items-start gap-3 rounded-md border border-line bg-paper px-3 py-2"
					>
						<div className="min-w-0 flex-1">
							<div className="text-sm font-medium text-ink">{m.label}</div>
							<div className="mt-0.5 font-mono text-2xs text-ink-3">{m.source}</div>
							<div className="mt-1 text-xs text-ink-3">{t(m.descriptionKey)}</div>
						</div>
						<Button
							variant="primary"
							size="sm"
							disabled={adding !== undefined}
							onClick={() => void addSuggested(m.source)}
						>
							{adding === m.source ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
							{t("views.marketplace.add")}
						</Button>
					</div>
				))}
			</div>
			{addedName ? (
				<div className="rounded-md border border-success/30 bg-success/10 px-3 py-2 font-mono text-xs text-success">
					{t("views.marketplace.added", { name: addedName })}
				</div>
			) : null}
			{error ? (
				<div className="rounded-md border border-danger/30 bg-danger/10 px-3 py-2 font-mono text-xs text-danger">
					{error}
				</div>
			) : null}
			<div className="flex justify-center pt-1">
				<Button variant="outline" size="sm" onClick={onAdd}>
					<Plus className="h-3.5 w-3.5" />
					{t("views.marketplace.addCustom")}
				</Button>
			</div>
		</div>
	);
}

function EntryCard({
	entry,
	isSelected,
	busy,
	onSelect,
	onInstall,
	onUninstall,
}: {
	entry: MarketplaceCatalogEntry;
	isSelected: boolean;
	busy: boolean;
	onSelect: () => void;
	onInstall: () => void;
	onUninstall: () => void;
}) {
	const { t } = useTranslation();
	const caps = [
		entry.capabilities.commands && "cmds",
		entry.capabilities.agents && "agents",
		entry.capabilities.hooks && "hooks",
		entry.capabilities.mcpServers && "mcp",
		entry.capabilities.lspServers && "lsp",
	].filter(Boolean) as string[];
	return (
		<button
			type="button"
			onClick={onSelect}
			className={cn(
				"flex flex-col gap-2 rounded-md border bg-paper p-3 text-left transition-colors",
				isSelected ? "border-accent ring-1 ring-accent/40" : "border-line hover:border-ink/30",
			)}
		>
			<div className="flex items-start justify-between gap-2">
				<div className="min-w-0">
					<div className="truncate text-sm font-semibold text-ink">{entry.name}</div>
					<div className="mt-0.5 truncate font-mono text-2xs text-ink-3">{entry.marketplace}</div>
				</div>
				<div className="flex shrink-0 items-center gap-1">
					{entry.installed ? (
						<>
							<Badge tone="success">{t("views.marketplace.installed")}</Badge>
							<button
								type="button"
								className="text-ink-3 hover:text-danger"
								title={t("views.marketplace.uninstall")}
								onClick={(e) => {
									e.stopPropagation();
									onUninstall();
								}}
								disabled={busy}
							>
								{busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
							</button>
						</>
					) : (
						<button
							type="button"
							className="inline-flex items-center gap-1 rounded-md border border-line bg-paper-2 px-2 py-1 text-2xs uppercase tracking-meta text-ink hover:border-ink/30"
							onClick={(e) => {
								e.stopPropagation();
								onInstall();
							}}
							disabled={busy}
						>
							{busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Download className="h-3 w-3" />}
							{t("views.marketplace.install")}
						</button>
					)}
				</div>
			</div>
			{entry.description ? <div className="line-clamp-2 text-xs text-ink-3">{entry.description}</div> : null}
			{caps.length > 0 ? (
				<div className="flex flex-wrap gap-1">
					{caps.map((cap) => (
						<Badge key={cap} tone="muted">
							{cap}
						</Badge>
					))}
				</div>
			) : null}
		</button>
	);
}

function MarketplaceInspector({ entry }: { entry: MarketplaceCatalogEntry | undefined }) {
	const { t } = useTranslation();
	if (!entry) {
		return (
			<div className="space-y-2 p-3 text-xs text-ink-3">
				<div className="meta">{t("views.marketplace.pluginDetails")}</div>
				<p>{t("views.marketplace.selectPlugin")}</p>
			</div>
		);
	}
	return (
		<div className="space-y-3 p-3">
			<div>
				<div className="meta">{entry.marketplace}</div>
				<div className="mt-0.5 text-sm font-semibold text-ink">{entry.name}</div>
				{entry.version ? <div className="font-mono text-2xs text-ink-3">v{entry.version}</div> : null}
			</div>
			{entry.description ? <p className="text-xs text-ink-2">{entry.description}</p> : null}
			<dl className="space-y-1.5 text-xs">
				{entry.author ? <DefRow k={t("views.marketplace.author")} v={entry.author} /> : null}
				{entry.homepage ? (
					<DefRow
						k={t("views.marketplace.homepage")}
						v={
							<a className="text-accent underline" href={entry.homepage} target="_blank" rel="noreferrer">
								{entry.homepage}
							</a>
						}
					/>
				) : null}
				{entry.category ? <DefRow k={t("views.marketplace.category")} v={entry.category} /> : null}
				{entry.tags && entry.tags.length > 0 ? (
					<DefRow
						k={t("views.marketplace.tags")}
						v={
							<span className="flex flex-wrap gap-1">
								{entry.tags.map((tag) => (
									<Badge key={tag} tone="muted">
										{tag}
									</Badge>
								))}
							</span>
						}
					/>
				) : null}
				{entry.installed ? (
					<DefRow
						k={t("views.marketplace.installed")}
						v={
							<span>
								<Badge tone="success">{entry.installed.scope}</Badge>
								<span className="ml-1 font-mono text-2xs text-ink-3">v{entry.installed.version}</span>
							</span>
						}
					/>
				) : null}
			</dl>
		</div>
	);
}

function DefRow({ k, v }: { k: string; v: ReactNode }) {
	return (
		<div className="grid grid-cols-[80px_1fr] gap-2">
			<dt className="meta">{k}</dt>
			<dd className="min-w-0 break-words text-ink-2">{v}</dd>
		</div>
	);
}

export function AddMarketplaceModalHost({ open, onClose, onAdded }: { open: boolean; onClose: () => void; onAdded: () => void }) {
	const { t } = useTranslation();
	const [source, setSource] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | undefined>();

	async function submit(): Promise<void> {
		if (!source.trim()) return;
		setBusy(true);
		setError(undefined);
		try {
			await marketplaceApi.addMarketplace(source.trim());
			onAdded();
			onClose();
			setSource("");
		} catch (e) {
			setError(String((e as Error).message ?? e));
		} finally {
			setBusy(false);
		}
	}

	return (
		<Modal open={open} onClose={onClose} widthClass="max-w-lg">
			<div className="flex h-11 items-center gap-2 border-b border-line px-3">
				<div className="meta">{t("views.marketplace.addMarketplace")}</div>
				<div className="flex-1" />
				<Button variant="ghost" size="icon" onClick={onClose} aria-label={t("views.marketplace.close")}>
					<X className="h-4 w-4" />
				</Button>
			</div>
			<div className="space-y-3 p-3">
				<p className="text-xs text-ink-3">
					{t("views.marketplace.sourceHint")} <code className="font-mono">owner/repo</code>,{" "}
					{t("views.marketplace.sourceHint2")}
				</p>
				<input
					value={source}
					onChange={(e) => setSource(e.target.value)}
					placeholder={t("views.marketplace.sourcePlaceholder")}
					className="field h-9 w-full px-2 font-mono text-sm"
				/>
				{error ? (
					<div className="rounded-md border border-danger/30 bg-danger/10 px-3 py-2 font-mono text-xs text-danger">
						{error}
					</div>
				) : null}
			</div>
			<div className="flex items-center justify-end gap-2 border-t border-line px-3 py-3">
				<Button variant="ghost" size="sm" onClick={onClose} disabled={busy}>
					{t("views.marketplace.cancel")}
				</Button>
				<Button variant="primary" size="sm" onClick={() => void submit()} disabled={busy || !source.trim()}>
					{busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
					{t("views.marketplace.add")}
				</Button>
			</div>
		</Modal>
	);
}
