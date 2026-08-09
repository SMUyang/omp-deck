import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { FileText, Hash, Loader2, Search, Tag, Type, X } from "lucide-react";
import type { KbSearchResponse, KbSearchResult } from "@omp-deck/protocol";

import { kbApi } from "@/lib/kb-api";
import { cn } from "@/lib/utils";

/**
 * Quick-open palette. Opens on Ctrl/Cmd-P inside /kb, Esc closes, arrow
 * keys move the selection, Enter opens. Input is autofocused. Search runs
 * debounced (140ms) so typing doesn't fire a request on every keystroke.
 */
export function KbCommandPalette({
	open,
	onClose,
	onSelect,
	initialQuery,
}: {
	open: boolean;
	onClose: () => void;
	onSelect: (path: string) => void;
	initialQuery?: string;
}) {
	const { t } = useTranslation();
	const [query, setQuery] = useState(initialQuery ?? "");
	const [response, setResponse] = useState<KbSearchResponse | null>(null);
	const [loading, setLoading] = useState(false);
	const [activeIdx, setActiveIdx] = useState(0);
	const inputRef = useRef<HTMLInputElement | null>(null);
	const listRef = useRef<HTMLUListElement | null>(null);

	// Reset state on open + autofocus the input.
	useEffect(() => {
		if (!open) return;
		setQuery(initialQuery ?? "");
		setResponse(null);
		setActiveIdx(0);
		queueMicrotask(() => inputRef.current?.focus());
	}, [open, initialQuery]);

	// Debounced search.
	useEffect(() => {
		if (!open) return;
		const q = query.trim();
		if (!q) {
			setResponse(null);
			setLoading(false);
			return;
		}
		setLoading(true);
		const handle = setTimeout(async () => {
			try {
				const r = await kbApi.search(q, 30);
				setResponse(r);
				setActiveIdx(0);
			} catch {
				setResponse(null);
			} finally {
				setLoading(false);
			}
		}, 140);
		return () => clearTimeout(handle);
	}, [query, open]);

	// Esc + arrow keys + Enter.
	const handleKeyDown = useCallback(
		(e: React.KeyboardEvent<HTMLDivElement>) => {
			if (!open) return;
			if (e.key === "Escape") {
				e.preventDefault();
				onClose();
				return;
			}
			const results = response?.results ?? [];
			if (e.key === "ArrowDown") {
				e.preventDefault();
				setActiveIdx((i) => Math.min(results.length - 1, i + 1));
			} else if (e.key === "ArrowUp") {
				e.preventDefault();
				setActiveIdx((i) => Math.max(0, i - 1));
			} else if (e.key === "Enter") {
				e.preventDefault();
				const r = results[activeIdx];
				if (r) {
					onSelect(r.path);
					onClose();
				}
			}
		},
		[open, response, activeIdx, onClose, onSelect],
	);

	// Keep the active row in view.
	useEffect(() => {
		const list = listRef.current;
		if (!list) return;
		const el = list.querySelector<HTMLLIElement>(`[data-row="${activeIdx}"]`);
		if (el) el.scrollIntoView({ block: "nearest" });
	}, [activeIdx]);

	if (!open) return null;
	const results = response?.results ?? [];

	return (
		<div
			role="dialog"
			aria-label={t("views.kbCommandPalette.searchKb")}
			className="fixed inset-0 z-50 flex items-start justify-center bg-ink/30 px-4 pt-[10vh] backdrop-blur-sm"
			onKeyDown={handleKeyDown}
			// Click backdrop to close
			onClick={(e) => {
				if (e.target === e.currentTarget) onClose();
			}}
		>
			<div className="w-full max-w-2xl overflow-hidden rounded-lg border border-line bg-paper shadow-2xl">
				<div className="flex items-center gap-2 border-b border-line px-3 py-2">
					<Search className="h-4 w-4 text-ink-3" />
					<input
						ref={inputRef}
						value={query}
						onChange={(e) => setQuery(e.target.value)}
						placeholder={t("views.kbCommandPalette.searchPlaceholder")}
						className="flex-1 bg-transparent text-sm text-ink placeholder:text-ink-4 focus:outline-none"
						spellCheck={false}
						autoComplete="off"
					/>
					{loading ? <Loader2 className="h-3.5 w-3.5 animate-spin text-ink-3" /> : null}
					<button
						type="button"
						onClick={onClose}
						aria-label={t("views.kbCommandPalette.close")}
						className="rounded-md p-1 text-ink-3 transition-colors hover:bg-paper-3 hover:text-ink"
					>
						<X className="h-3.5 w-3.5" />
					</button>
				</div>

				<ul
					ref={listRef}
					className="max-h-[60vh] overflow-y-auto"
				>
					{query.trim() === "" ? (
						<li className="px-4 py-6 text-center text-xs text-ink-3">
							{t("views.kbCommandPalette.hint")}
						</li>
					) : results.length === 0 && !loading ? (
						<li className="px-4 py-6 text-center text-sm text-ink-3">
							{t("views.kbCommandPalette.noMatches", { query })}
						</li>
					) : (
						results.map((r, i) => (
							<PaletteRow
								key={r.path}
								idx={i}
								active={i === activeIdx}
								result={r}
								onClick={() => {
									onSelect(r.path);
									onClose();
								}}
								onHover={() => setActiveIdx(i)}
							/>
						))
					)}
				</ul>

				{response ? (
					<div className="flex items-center gap-3 border-t border-line bg-paper-2 px-3 py-1.5 font-mono text-2xs text-ink-3">
						<span>
							{t("views.kbCommandPalette.matches", { count: response.totalMatches })}
							{response.truncated ? <span className="ml-1 text-warn">{t("views.kbCommandPalette.top30")}</span> : null}
						</span>
						<span className="ml-auto">{t("views.kbCommandPalette.openCloseHint")}</span>
					</div>
				) : null}
			</div>
		</div>
	);
}

function PaletteRow({
	idx,
	active,
	result,
	onClick,
	onHover,
}: {
	idx: number;
	active: boolean;
	result: KbSearchResult;
	onClick: () => void;
	onHover: () => void;
}) {
	const KindIcon = matchKindIcon(result.matchKind);
	return (
		<li data-row={idx}>
			<button
				type="button"
				onClick={onClick}
				onMouseEnter={onHover}
				className={cn(
					"flex w-full items-start gap-2 px-3 py-2 text-left transition-colors",
					active ? "bg-accent-soft/40" : "hover:bg-paper-3",
				)}
			>
				<KindIcon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-accent" />
				<div className="min-w-0 flex-1">
					<div className="flex items-baseline gap-2">
						<span className="truncate text-sm text-ink">{result.title}</span>
						<span className="truncate font-mono text-2xs text-ink-3">{result.path}</span>
					</div>
					{result.snippet ? (
						<div className="mt-0.5 truncate font-mono text-2xs text-ink-3">
							{result.snippet}
						</div>
					) : null}
				</div>
				<span className="shrink-0 font-mono text-2xs uppercase text-ink-4">
					{result.matchKind}
				</span>
			</button>
		</li>
	);
}

function matchKindIcon(kind: KbSearchResult["matchKind"]) {
	switch (kind) {
		case "stem":
			return FileText;
		case "title":
			return Type;
		case "tag":
			return Tag;
		case "body":
			return Hash;
	}
}
