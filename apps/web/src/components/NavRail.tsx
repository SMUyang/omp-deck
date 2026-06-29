import { BookOpen, Clock, Globe, Inbox, KanbanSquare, MessagesSquare, Plug, Settings, Sparkles, Store } from "lucide-react";
import { NavLink } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { changeLang, getCurrentLang, type Lang } from "@/i18n";
import { cn } from "@/lib/utils";

const ITEMS: ReadonlyArray<{
	to: string;
	labelKey: string;
	icon: typeof MessagesSquare;
}> = [
	{ to: "/", labelKey: "nav.chat", icon: MessagesSquare },
	{ to: "/tasks", labelKey: "nav.tasks", icon: KanbanSquare },
	{ to: "/routines", labelKey: "nav.routines", icon: Clock },
	{ to: "/inbox", labelKey: "nav.inbox", icon: Inbox },
	{ to: "/marketplace", labelKey: "nav.marketplace", icon: Store },
	{ to: "/skills", labelKey: "nav.skills", icon: Sparkles },
	{ to: "/kb", labelKey: "nav.knowledge", icon: BookOpen },
	{ to: "/integrations", labelKey: "nav.integrations", icon: Plug },
];

/**
 * Vertical icon rail. 48px wide, fixed left edge. Active route gets the rust
 * accent + a thin left tab; inactive entries are muted ink-3 with a hover lift.
 */
export function NavRail() {
	const { t } = useTranslation();
	const settingsLabel = t("nav.settings");
	return (
		<nav className="flex h-full w-12 shrink-0 flex-col items-center gap-1 border-r border-line bg-paper py-2">
			{ITEMS.map((item) => {
				const label = t(item.labelKey);
				return (
					<NavLink
						key={item.to}
						to={item.to}
						end={item.to === "/"}
						title={label}
						aria-label={label}
						className={({ isActive }) =>
							cn(
								"relative flex h-9 w-9 items-center justify-center rounded-md transition-colors",
								isActive
									? "text-accent bg-accent-soft/40"
									: "text-ink-3 hover:bg-paper-3 hover:text-ink",
							)
						}
					>
						{({ isActive }) => (
							<>
								<item.icon className="h-[18px] w-[18px]" />
								{isActive ? (
									<span
										className="absolute left-0 top-1/2 h-5 w-[2px] -translate-y-1/2 rounded-r bg-accent"
										aria-hidden="true"
									/>
								) : null}
							</>
						)}
					</NavLink>
				);
			})}
			<button
				type="button"
				onClick={() => {
					const next: Lang = getCurrentLang() === "zh-CN" ? "en" : "zh-CN";
					changeLang(next);
				}}
				title={getCurrentLang() === "zh-CN" ? "切换到 English" : "切换到中文"}
				aria-label="Toggle language"
				className="relative flex h-9 w-9 items-center justify-center rounded-md text-ink-3 transition-colors hover:bg-paper-3 hover:text-ink"
			>
				<Globe className="h-[18px] w-[18px]" />
			</button>
			<div className="mt-auto h-px w-7 bg-line" aria-hidden="true" />
			<NavLink
				to="/settings"
				title={settingsLabel}
				aria-label={settingsLabel}
				className={({ isActive }) =>
					cn(
						"relative flex h-9 w-9 items-center justify-center rounded-md transition-colors",
						isActive
							? "text-accent bg-accent-soft/40"
							: "text-ink-3 hover:bg-paper-3 hover:text-ink",
					)
				}
			>
				{({ isActive }) => (
					<>
						<Settings className="h-[18px] w-[18px]" />
						{isActive ? (
							<span
								className="absolute left-0 top-1/2 h-5 w-[2px] -translate-y-1/2 rounded-r bg-accent"
								aria-hidden="true"
							/>
						) : null}
					</>
				)}
			</NavLink>
		</nav>
	);
}
