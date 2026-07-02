import { useMemo, useState } from "react";
import { Plus, RefreshCw, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useStore } from "@/lib/store";
import { cn, shortPath } from "@/lib/utils";

export function Sidebar() {
	const workspaces = useStore((s) => s.workspaces);
	const { t } = useTranslation();
	const defaultCwd = useStore((s) => s.defaultCwd);
	const sessions = useStore((s) => s.sessions);
	const activeId = useStore((s) => s.activeId);
	const sessionsById = useStore((s) => s.sessionsById);
	const refreshSessions = useStore((s) => s.refreshSessions);
	const refreshWorkspaces = useStore((s) => s.refreshWorkspaces);
	const createWorkspace = useStore((s) => s.createWorkspace);
	const deleteWorkspace = useStore((s) => s.deleteWorkspace);
	const createSession = useStore((s) => s.createSession);
	const selectSession = useStore((s) => s.selectSession);

	const [selectedCwd, setSelectedCwd] = useState<string | "">("");
	const [creating, setCreating] = useState(false);
	const [workspaceBusy, setWorkspaceBusy] = useState(false);

	const cwdInUse = selectedCwd || defaultCwd;
	const selectedWorkspace = workspaces.find((workspace) => workspace.cwd === selectedCwd);
	const canDeleteSelectedWorkspace = selectedWorkspace?.source === "user" && Boolean(selectedWorkspace.id);

	const filtered = useMemo(() => {
		if (!selectedCwd) return sessions;
		return sessions.filter((s) => s.cwd === selectedCwd);
	}, [sessions, selectedCwd]);

	async function handleNew(): Promise<void> {
		setCreating(true);
		try {
			await createSession({ cwd: cwdInUse });
		} catch (err) {
			console.error(err);
			alert(`Failed to create session: ${String(err)}`);
		} finally {
			setCreating(false);
		}
	}

	async function handleResume(p: string): Promise<void> {
		setCreating(true);
		try {
			await createSession({ cwd: cwdInUse, resumeFromPath: p });
		} catch (err) {
			console.error(err);
			alert(`Failed to resume: ${String(err)}`);
		} finally {
			setCreating(false);
		}
	}

	async function handleAddWorkspace(): Promise<void> {
		if (workspaceBusy) return;
		const cwd = window.prompt(t("sidebar.workspacePathPrompt"));
		if (!cwd?.trim()) return;
		const label = window.prompt(t("sidebar.workspaceLabelPrompt")) ?? undefined;
		setWorkspaceBusy(true);
		try {
			await createWorkspace({ cwd: cwd.trim(), label, createDirectory: true });
			setSelectedCwd(cwd.trim());
			void refreshSessions(cwd.trim());
		} catch (err) {
			console.error(err);
			alert(`${t("sidebar.workspaceCreateFailed")}: ${String(err)}`);
		} finally {
			setWorkspaceBusy(false);
		}
	}

	async function handleDeleteWorkspace(): Promise<void> {
		if (workspaceBusy) return;
		if (!selectedWorkspace?.id || !canDeleteSelectedWorkspace) return;
		if (!window.confirm(t("sidebar.workspaceRemoveConfirm"))) return;
		setWorkspaceBusy(true);
		try {
			await deleteWorkspace(selectedWorkspace.id);
			setSelectedCwd("");
			void refreshSessions(undefined);
		} catch (err) {
			console.error(err);
			alert(`${t("sidebar.workspaceDeleteFailed")}: ${String(err)}`);
		} finally {
			setWorkspaceBusy(false);
		}
	}

	const liveSessions = Object.values(sessionsById);
	const persisted = filtered.filter((s) => !sessionsById[s.id]);

	return (
		<div className="flex h-full min-h-0 flex-col">
			<div className="space-y-3 px-3 py-3 border-b border-line">
				<div className="flex items-center justify-between">
					<div className="meta">{t("sidebar.workspace")}</div>
					<div className="flex items-center gap-1">
						<button
							type="button"
							className="text-ink-3 hover:text-ink"
							onClick={() => void handleAddWorkspace()}
							aria-label={t("sidebar.addWorkspace")}
							disabled={workspaceBusy}
						>
							<Plus className="h-3 w-3" />
						</button>
						{canDeleteSelectedWorkspace ? (
							<button
								type="button"
								className="text-ink-3 hover:text-ink"
								onClick={() => void handleDeleteWorkspace()}
								aria-label={t("sidebar.removeWorkspace")}
								disabled={workspaceBusy}
							>
								<Trash2 className="h-3 w-3" />
							</button>
						) : null}
						<button
							type="button"
							className="text-ink-3 hover:text-ink"
							onClick={() => void refreshWorkspaces()}
							aria-label={t("sidebar.refreshWorkspaces")}
						>
							<RefreshCw className="h-3 w-3" />
						</button>
					</div>
				</div>

				<select
					value={selectedCwd}
					onChange={(e) => {
						setSelectedCwd(e.target.value);
						void refreshSessions(e.target.value || undefined);
					}}
					className="field h-7 w-full px-2 font-mono text-xs"
				>
					<option value="">{t("sidebar.allWorkspaces")}</option>
					{workspaces.map((w) => (
						<option key={w.cwd} value={w.cwd}>
							{w.label} · {w.sessionCount}
						</option>
					))}
				</select>
				<div className="truncate font-mono text-2xs text-ink-3" title={cwdInUse}>
					{cwdInUse}
				</div>
				<button
					type="button"
					className="btn-primary h-8 w-full text-[13px]"
					onClick={() => void handleNew()}
					disabled={creating}
				>
					<Plus className="h-3.5 w-3.5" />
					{t("sidebar.newSession")}
				</button>
			</div>

			<div className="flex items-center justify-between px-3 pt-3 pb-1">
				<div className="meta">{t("sidebar.sessions")} · {filtered.length}</div>
				<button
					type="button"
					className="text-ink-3 hover:text-ink"
					onClick={() => void refreshSessions(selectedCwd || undefined)}
					aria-label={t("sidebar.refreshSessions")}
				>
					<RefreshCw className="h-3 w-3" />
				</button>
			</div>

			<div className="flex-1 overflow-y-auto px-1 pb-3">
				{liveSessions.map((s) => (
					<SessionRow
						key={s.sessionId}
						title={s.sessionName || formatSessionId(s.sessionId)}
						subtitle={shortPath(s.cwd, 30)}
						active={s.sessionId === activeId}
						live
						planMode={s.planMode?.enabled === true}
						onClick={() => selectSession(s.sessionId)}
					/>
				))}

				{liveSessions.length > 0 && persisted.length > 0 ? (
					<div className="my-2 mx-2 border-t border-line" />
				) : null}

				{persisted.map((s) => (
					<SessionRow
						key={s.id}
						title={s.title || formatSessionId(s.id)}
						subtitle={`${shortPath(s.cwd, 26)} · ${s.messageCount}m`}
						meta={formatRelative(s.updatedAt || s.createdAt)}
						onClick={() => void handleResume(s.path)}
					/>
				))}

				{filtered.length === 0 && liveSessions.length === 0 ? (
					<div className="px-3 py-6 text-center font-mono text-2xs text-ink-3">
						{t("sidebar.noSessions")}
					</div>
				) : null}
			</div>
		</div>
	);
}

function SessionRow({
	title,
	subtitle,
	meta,
	active,
	live,
	planMode,
	onClick,
}: {
	title: string;
	subtitle?: string;
	meta?: string;
	active?: boolean;
	live?: boolean;
	planMode?: boolean;
	onClick: () => void;
}) {
	const { t } = useTranslation();
	return (
		<button
			type="button"
			onClick={onClick}
			className={cn(
				"group block w-full rounded-md px-2 py-1.5 text-left text-[13px] transition-colors",
				active ? "bg-paper-3 text-ink" : "text-ink-2 hover:bg-paper-3/60",
			)}
		>
			<div className="flex items-center gap-1.5">
				{live ? (
				<span className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" aria-label={t("sidebar.live")} />
				) : (
					<span className="h-1.5 w-1.5 shrink-0 rounded-full bg-line-strong" />
				)}
				<span className="truncate">{title}</span>
				{planMode ? (
					<span
						className="ml-auto shrink-0 rounded border border-thinking/40 bg-thinking/10 px-1 py-px font-mono text-[10px] uppercase tracking-meta text-thinking"
						title={t("sidebar.plan")}
					>
						{t("sidebar.plan")}
					</span>
				) : null}
			</div>
			{subtitle ? (
				<div className="mt-0.5 truncate pl-3 font-mono text-2xs text-ink-3">
					{subtitle}
				</div>
			) : null}
			{meta ? (
				<div className="truncate pl-3 font-mono text-2xs text-ink-4">{meta}</div>
			) : null}
		</button>
	);
}

function formatSessionId(id: string): string {
	if (id.length <= 8) return id;
	return `${id.slice(0, 4)}…${id.slice(-4)}`;
}

const RELATIVE_THRESHOLDS: Array<[number, string]> = [
	[60_000, "just now"],
	[3_600_000, "m"],
	[86_400_000, "h"],
	[2_592_000_000, "d"],
];

function formatRelative(ts: string): string {
	if (!ts) return "";
	const d = new Date(ts);
	if (Number.isNaN(d.getTime())) return ts;
	const diff = Date.now() - d.getTime();
	if (diff < 0) return d.toLocaleDateString();
	const first = RELATIVE_THRESHOLDS[0];
	if (!first || diff < first[0]) return "just now";
	for (let i = 1; i < RELATIVE_THRESHOLDS.length; i++) {
		const cur = RELATIVE_THRESHOLDS[i];
		const prev = RELATIVE_THRESHOLDS[i - 1];
		if (!cur || !prev) continue;
		if (diff < cur[0]) return `${Math.floor(diff / prev[0])}${cur[1]} ago`;
	}
	return d.toLocaleDateString();
}
