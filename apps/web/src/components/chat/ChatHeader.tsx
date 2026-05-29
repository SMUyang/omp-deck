import { useEffect, useRef, useState } from "react";
import { ChevronDown, Plus } from "lucide-react";
import type { SessionUi } from "@/lib/types";
import { selectActiveSession, useStore } from "@/lib/store";
import { cn, shortPath } from "@/lib/utils";
import { ContextIndicator } from "./ContextIndicator";
import { ModelPickerModal } from "./ModelPickerModal";

/**
 * Sticky header row above the chat scroll area when a session is selected.
 * Shows the session name (click to rename) + a small dropdown listing other
 * live sessions for quick switching and a "+ new" affordance.
 *
 * Renders inline above the chat so the user never needs the sidebar to
 * orient themselves to the current session.
 */
export function ChatHeader() {
	const session = useStore(selectActiveSession);
	if (!session) return null;
	return <Inner session={session} />;
}

function Inner({ session }: { session: SessionUi }) {
	const renameSession = useStore((s) => s.renameSession);
	const createSession = useStore((s) => s.createSession);
	const selectSession = useStore((s) => s.selectSession);
	const defaultCwd = useStore((s) => s.defaultCwd);
	const sessionsById = useStore((s) => s.sessionsById);

	const [editing, setEditing] = useState(false);
	const [draft, setDraft] = useState(session.sessionName ?? "");
	const [renameError, setRenameError] = useState<string | undefined>(undefined);
	const [switcherOpen, setSwitcherOpen] = useState(false);
	const [modelOpen, setModelOpen] = useState(false);
	const switcherRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		setDraft(session.sessionName ?? "");
	}, [session.sessionName, session.sessionId]);

	useEffect(() => {
		if (!switcherOpen) return;
		function onDocClick(e: MouseEvent): void {
			if (!switcherRef.current) return;
			if (!switcherRef.current.contains(e.target as Node)) setSwitcherOpen(false);
		}
		document.addEventListener("mousedown", onDocClick);
		return () => document.removeEventListener("mousedown", onDocClick);
	}, [switcherOpen]);

	function commit(): void {
		const trimmed = draft.trim();
		if (!trimmed || trimmed === session.sessionName) {
			setEditing(false);
			setRenameError(undefined);
			return;
		}
		// Keep the input open until the API succeeds — otherwise a failure
		// (Windows-EPERM from the SDK's atomic-rename, server 404 on a
		// reaped session, etc.) silently reverts the visible name without
		// telling the user the rename never landed.
		renameSession(session.sessionId, trimmed).then(
			() => {
				setRenameError(undefined);
				setEditing(false);
			},
			(err: unknown) => {
				const message = err instanceof Error ? err.message : String(err);
				// Trim the long HTTP prefix the api helper prepends.
				const compact = message.replace(/^HTTP \d+ \/sessions\/[^:]+:\s*/, "");
				setRenameError(compact || "Rename failed");
			},
		);
	}

	const otherSessions = Object.values(sessionsById).filter((s) => s.sessionId !== session.sessionId);

	return (
		<div className="flex h-10 shrink-0 items-center gap-2 border-b border-line bg-paper px-4">
			{/* Live indicator + name */}
			<span className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" aria-label="live session" />
			{session.planMode?.enabled ? (
				<span
					className="inline-flex shrink-0 items-center gap-1 rounded border border-thinking/40 bg-thinking/10 px-1.5 py-0.5 text-2xs uppercase tracking-meta text-thinking"
					title="Plan mode — agent reads + proposes only (Shift+Tab to exit)"
				>
					Plan
				</span>
			) : null}
			{editing ? (
				<>
					<input
						autoFocus
						value={draft}
						onChange={(e) => {
							setDraft(e.target.value);
							if (renameError) setRenameError(undefined);
						}}
						onBlur={commit}
						onKeyDown={(e) => {
							if (e.key === "Enter") {
								e.preventDefault();
								(e.target as HTMLInputElement).blur();
							}
							if (e.key === "Escape") {
								setDraft(session.sessionName ?? "");
								setRenameError(undefined);
								setEditing(false);
							}
						}}
						placeholder="Untitled session"
						aria-invalid={renameError ? true : undefined}
						aria-describedby={renameError ? "rename-error" : undefined}
						className={cn(
							"min-w-0 flex-1 bg-transparent text-[13px] font-medium text-ink placeholder:text-ink-4 focus:outline-none",
							renameError && "text-danger placeholder:text-danger/60",
						)}
					/>
					{renameError ? (
						<span
							id="rename-error"
							role="alert"
							title={renameError}
							className="shrink-0 truncate font-mono text-2xs text-danger"
						>
							✕ {renameError.length > 80 ? `${renameError.slice(0, 77)}…` : renameError}
						</span>
					) : null}
				</>
			) : (
				<button
					type="button"
					onClick={() => setEditing(true)}
					title="Click to rename"
					className="min-w-0 flex-1 truncate text-left text-[13px] font-medium text-ink hover:text-accent"
				>
					{session.sessionName || `Untitled · ${shortId(session.sessionId)}`}
				</button>
			)}

			{session.planMode?.enabled ? (
				<span
					className="hidden h-6 shrink-0 items-center rounded-md border border-accent-plan/40 bg-accent-plan/10 px-1.5 font-mono text-2xs uppercase tracking-meta text-accent-plan sm:flex"
					title="Plan mode active — agent will read + propose a plan, then await approval before execution (Shift+Tab to exit)"
				>
					plan
				</span>
			) : null}

			{/* Metadata */}
			<span
				className="hidden font-mono text-2xs text-ink-3 sm:inline truncate"
				title={session.cwd}
			>
				{shortPath(session.cwd, 36)}
			</span>

			{session.model ? (
				<button
					type="button"
					onClick={() => setModelOpen(true)}
					title={`Switch model (${session.model.provider}/${session.model.id})`}
					className="hidden h-6 items-center gap-1 rounded-md border border-line bg-paper-2/60 px-2 font-mono text-2xs uppercase tracking-meta text-ink-3 hover:border-ink/30 hover:text-ink sm:flex"
				>
					<span className="truncate max-w-[180px]">{session.model.id}</span>
					<ChevronDown className="h-3 w-3" />
				</button>
			) : null}
			{session.planMode?.enabled ? (
				<span
					className="flex h-6 items-center rounded-md border border-thinking/60 bg-thinking/10 px-1.5 font-mono text-2xs uppercase tracking-meta text-thinking"
					title="Plan mode active — agent reads + proposes only. Shift+Tab to exit."
					aria-label="Plan mode active"
				>
					Plan
				</span>
			) : null}

			{/* Context-window indicator — clickable popover with manual /compact. */}
			<ContextIndicator sessionId={session.sessionId} usage={session.contextUsage} />

			{/* Switcher dropdown */}
			<div className="relative" ref={switcherRef}>
				<button
					type="button"
					onClick={() => setSwitcherOpen((v) => !v)}
					className="btn-ghost h-7 gap-1 px-1.5 text-xs"
					title="Switch sessions"
				>
					Switch
					<ChevronDown
						className={cn("h-3 w-3 transition-transform", switcherOpen && "rotate-180")}
					/>
				</button>
				{switcherOpen ? (
					<div className="absolute right-0 top-full mt-1 w-72 rounded-md border border-line bg-paper-2 shadow-[0_8px_24px_-8px_rgba(26,24,20,0.25)]">
						<button
							type="button"
							onClick={async () => {
								setSwitcherOpen(false);
								try {
									await createSession({ cwd: defaultCwd });
								} catch (err) {
									console.error(err);
								}
							}}
							className="flex w-full items-center gap-2 border-b border-line px-3 py-2 text-left text-sm text-accent hover:bg-paper-3/60"
						>
							<Plus className="h-3.5 w-3.5" />
							New session
						</button>
						{otherSessions.length === 0 ? (
							<div className="px-3 py-3 font-mono text-2xs text-ink-3">
								No other live sessions.
							</div>
						) : (
							<ul className="py-1">
								{otherSessions.map((s) => (
									<li key={s.sessionId}>
										<button
											type="button"
											onClick={() => {
												setSwitcherOpen(false);
												selectSession(s.sessionId);
											}}
											className="block w-full px-3 py-1.5 text-left text-sm hover:bg-paper-3/60"
										>
											<div className="truncate text-ink">
												{s.sessionName || `Untitled · ${shortId(s.sessionId)}`}
											</div>
											<div className="truncate font-mono text-2xs text-ink-3">
												{shortPath(s.cwd, 48)}
											</div>
										</button>
									</li>
								))}
							</ul>
						)}
					</div>
				) : null}
			</div>

			<ModelPickerModal
				open={modelOpen}
				sessionId={session.sessionId}
				onClose={() => setModelOpen(false)}
				onPicked={() => {
					// Snapshot will update on the SDK's next event; nothing else to do here.
				}}
			/>
		</div>
	);
}

function shortId(id: string): string {
	return id.length <= 8 ? id : id.slice(0, 6);
}
