import { useEffect, useState } from "react";
import { ChevronLeft, FolderIcon, FolderPlus, RefreshCw, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { BrowseDirectoryResponse } from "@omp-deck/protocol";
import { api } from "@/lib/api";
import { Modal } from "./Modal";

interface Props {
	open: boolean;
	initialCwd: string;
	title: string;
	onClose: () => void;
	onPick: (cwd: string) => void;
}

export function DirectoryPickerDialog({ open, initialCwd, title, onClose, onPick }: Props) {
	const { t } = useTranslation();
	const [cwd, setCwd] = useState(initialCwd);
	const [showHidden, setShowHidden] = useState(false);
	const [data, setData] = useState<BrowseDirectoryResponse | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(false);
	const [reloadNonce, setReloadNonce] = useState(0);
	const [pathInput, setPathInput] = useState("");
	const [newFolderName, setNewFolderName] = useState("");
	const [showNewFolder, setShowNewFolder] = useState(false);

	useEffect(() => {
		if (open) setCwd(initialCwd);
	}, [open, initialCwd]);

	useEffect(() => {
		if (!open || !cwd) return;
		let cancelled = false;
		setLoading(true);
		setError(null);
		void api
			.browseDirectory(cwd, showHidden)
			.then((next) => {
				if (!cancelled) setData(next);
			})
			.catch((err) => {
				if (!cancelled) setError(String(err));
			})
			.finally(() => {
				if (!cancelled) setLoading(false);
			});
		return () => {
			cancelled = true;
		};
	}, [open, cwd, showHidden, reloadNonce]);

	return (
		<Modal open={open} onClose={onClose} widthClass="max-w-3xl" heightClass="h-[72vh]">
			<div className="flex items-center justify-between border-b border-line px-4 py-3">
				<div>
					<div className="text-sm font-semibold text-ink">{title}</div>
					<div className="mt-0.5 truncate font-mono text-2xs text-ink-3" title={data?.cwd ?? cwd}>{data?.cwd ?? cwd}</div>
				</div>
				<button type="button" className="text-ink-3 hover:text-ink" onClick={onClose} aria-label="Close">
					<X className="h-4 w-4" />
				</button>
			</div>
			<div className="flex items-center gap-2 border-b border-line px-4 py-2">
				<button
					type="button"
					className="btn-secondary h-7 text-2xs"
					disabled={!data?.parent || loading}
					onClick={() => data?.parent && setCwd(data.parent)}
				>
					<ChevronLeft className="h-3.5 w-3.5" />
					{t("sidebar.parentDirectory")}
				</button>
				<button type="button" className="btn-secondary h-7 text-2xs" disabled={loading} onClick={() => setReloadNonce((value) => value + 1)}>
					<RefreshCw className="h-3.5 w-3.5" />
					Refresh
				</button>
				{/* Manual path entry — lets users type/paste a path directly, which is
				    essential on Windows where directories on different drives (C:\, D:\)
				    can't be reached by clicking up/down from the current drive. */}
				<input
					type="text"
					className="ml-auto h-7 flex-1 max-w-[280px] rounded border border-line bg-paper px-2 font-mono text-2xs text-ink placeholder:text-ink-4 focus:border-accent focus:outline-none"
					placeholder={t("sidebar.typePath")}
					value={pathInput}
					onChange={(e) => setPathInput(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === "Enter" && pathInput.trim()) {
							setCwd(pathInput.trim());
							setPathInput("");
						}
					}}
				/>
				{showNewFolder ? (
					<input
						type="text"
						autoFocus
						className="h-7 w-40 rounded border border-accent bg-paper px-2 font-mono text-2xs text-ink focus:outline-none"
						placeholder="Folder name"
						value={newFolderName}
						onChange={(e) => setNewFolderName(e.target.value)}
						onKeyDown={async (e) => {
							if (e.key === "Enter" && newFolderName.trim()) {
								try {
									await api.createDirectory(cwd, newFolderName.trim());
									setNewFolderName("");
									setShowNewFolder(false);
									setReloadNonce((v) => v + 1);
								} catch (err) {
									setError(String(err));
								}
							}
							if (e.key === "Escape") {
								setShowNewFolder(false);
								setNewFolderName("");
							}
						}}
						onBlur={() => { if (!newFolderName.trim()) setShowNewFolder(false); }}
					/>
				) : (
					<button type="button" className="btn-secondary h-7 text-2xs" disabled={loading} onClick={() => setShowNewFolder(true)}>
						<FolderPlus className="h-3.5 w-3.5" />
						New Folder
					</button>
				)}
				<label className="flex items-center gap-1.5 font-mono text-2xs text-ink-3">
					<input type="checkbox" checked={showHidden} onChange={(event) => setShowHidden(event.target.checked)} />
					{t("sidebar.showHiddenDirectories")}
				</label>
			</div>

			<div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
				{error ? <div className="px-2 py-3 font-mono text-xs text-danger">{error}</div> : null}
				{loading ? <div className="px-2 py-3 font-mono text-xs text-ink-3">Loading…</div> : null}
				{!loading && data?.entries.length === 0 ? <div className="px-2 py-3 font-mono text-xs text-ink-3">{t("sidebar.noChildDirectories")}</div> : null}
				{data?.entries.map((entry) => (
					<button
						key={entry.path}
						type="button"
						className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left font-mono text-xs hover:bg-paper-3/60"
						onClick={() => setCwd(entry.path)}
					>
						<FolderIcon className="h-3.5 w-3.5 shrink-0 text-accent" />
						<span className="truncate">{entry.name}/</span>
						{entry.hidden ? <span className="text-2xs text-ink-4">hidden</span> : null}
					</button>
				))}
			</div>

			<div className="flex items-center justify-end gap-2 border-t border-line px-4 py-3">
				<button type="button" className="btn-secondary h-8 text-xs" onClick={onClose}>Cancel</button>
				<button type="button" className="btn-primary h-8 text-xs" disabled={!data?.cwd} onClick={() => data?.cwd && onPick(data.cwd)}>
					{t("sidebar.selectThisFolder")}
				</button>
			</div>
		</Modal>
	);
}
