import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useStore, selectActiveSession } from "@/lib/store";
import { TodoPanel } from "@/components/todos/TodoPanel";
import { StatusPanel } from "@/components/status/StatusPanel";
import { TopologyFocusPanel } from "@/components/session/TopologyFocusPanel";
import { cn } from "@/lib/utils";

const STORAGE_KEY = "omp-deck:chat-inspector-tab";
type TabId = "focus" | "todos" | "status";

const TAB_IDS: ReadonlyArray<TabId> = ["focus", "todos", "status"];

function readStoredTab(): TabId {
	if (typeof localStorage === "undefined") return "focus";
	const raw = localStorage.getItem(STORAGE_KEY);
	return TAB_IDS.includes(raw as TabId) ? (raw as TabId) : "focus";
}

export function ChatInspector() {
	const { t } = useTranslation();
	const [tab, setTab] = useState<TabId>(readStoredTab);
	const phases = useStore((s) => selectActiveSession(s)?.todoPhases);

	useEffect(() => {
		try {
			localStorage.setItem(STORAGE_KEY, tab);
		} catch {
			// localStorage may be unavailable
		}
	}, [tab]);

	return (
		<div className="flex h-full min-h-0 flex-col">
			<div
				role="tablist"
				aria-label={t("nav.chat")}
				className="flex shrink-0 border-b border-line bg-paper-2/40"
			>
				<TabButton active={tab === "focus"} onClick={() => setTab("focus")}>
					{t("chatInspector.tabs.focus")}
				</TabButton>
				<TabButton active={tab === "todos"} onClick={() => setTab("todos")}>
					{t("chatInspector.tabs.todos")}
				</TabButton>
				<TabButton active={tab === "status"} onClick={() => setTab("status")}>
					{t("chatInspector.tabs.status")}
				</TabButton>
			</div>
			<div className="min-h-0 flex-1">
				{tab === "focus" ? <TopologyFocusPanel /> : null}
				{tab === "todos" ? <TodoPanel phases={phases ?? []} /> : null}
				{tab === "status" ? <StatusPanel /> : null}
			</div>
		</div>
	);
}

function TabButton({
	active,
	onClick,
	children,
}: {
	active: boolean;
	onClick: () => void;
	children: React.ReactNode;
}) {
	return (
		<button
			type="button"
			role="tab"
			aria-selected={active}
			onClick={onClick}
			className={cn(
				"relative flex-1 px-3 py-2 text-xs font-medium transition-colors",
				active
					? "text-ink"
					: "text-ink-3 hover:bg-paper-3/60 hover:text-ink-2",
			)}
		>
			{children}
			{active ? (
				<span className="absolute inset-x-2 bottom-0 h-0.5 rounded-t bg-accent" aria-hidden="true" />
			) : null}
		</button>
	);
}
