/**
 * Stacked in-app toasts for notifications. Always rendered (regardless of
 * OS-notification permission); when permission IS granted, the OS notif and
 * the toast both appear — the toast still serves as an in-app trail until
 * dismissed, which is useful when the deck tab is the focused window
 * (browsers suppress OS notifications when the originating tab is focused).
 *
 * Recent, undismissed notifications stack bottom-right. Auto-dismiss after
 * `AUTO_DISMISS_MS` for info/warn; error/critical stay until user closes.
 */

import { useEffect } from "react";
import { useTranslation } from "react-i18next";

import { useStore, type NotificationItem } from "../lib/store";

const AUTO_DISMISS_MS = 6000;
const MAX_VISIBLE = 4;

function levelClass(level: NotificationItem["level"]): string {
	switch (level) {
		case "info":
			return "border-sky-700/50 bg-sky-950/80 text-sky-100";
		case "warn":
			return "border-amber-700/60 bg-amber-950/80 text-amber-100";
		case "error":
			return "border-rose-700/60 bg-rose-950/80 text-rose-100";
		case "critical":
			return "border-fuchsia-700/60 bg-fuchsia-950/85 text-fuchsia-100";
	}
}

export function NotificationToast(): JSX.Element | null {
	const { t } = useTranslation();
	const notifications = useStore((s) => s.notifications);
	const dismissNotification = useStore((s) => s.dismissNotification);

	const visible = notifications
		.filter((n) => !n.dismissed)
		.slice(-MAX_VISIBLE);

	// Schedule auto-dismiss for info/warn levels. Each visible toast gets its
	// own timer; cleared in cleanup.
	useEffect(() => {
		const timers: ReturnType<typeof setTimeout>[] = [];
		for (const n of visible) {
			if (n.level === "info" || n.level === "warn") {
				const remaining = Math.max(0, AUTO_DISMISS_MS - (Date.now() - n.receivedAtMs));
				const t = setTimeout(() => dismissNotification(n.id), remaining);
				timers.push(t);
			}
		}
		return () => {
			for (const t of timers) clearTimeout(t);
		};
	}, [visible, dismissNotification]);

	if (visible.length === 0) return null;

	return (
		<div className="pointer-events-none fixed bottom-4 right-4 z-50 flex flex-col gap-2">
			{visible.map((n) => (
				<div
					key={n.id}
					className={`pointer-events-auto w-80 max-w-[90vw] rounded-md border px-3 py-2 shadow-lg ${levelClass(n.level)}`}
					role="status"
					aria-live={n.level === "error" || n.level === "critical" ? "assertive" : "polite"}
				>
					<div className="flex items-start justify-between gap-2">
						<div className="min-w-0 flex-1">
							<div className="truncate text-sm font-medium">{n.title}</div>
							{n.body && (
								<div className="mt-0.5 line-clamp-3 text-xs opacity-80">{n.body}</div>
							)}
							{n.actionUrl && (
								<a
									href={n.actionUrl}
									className="mt-1 inline-block text-xs underline opacity-90 hover:opacity-100"
									onClick={() => dismissNotification(n.id)}
								>
									{t("core.notificationToast.view")}
								</a>
							)}
						</div>
						<button
							type="button"
							onClick={() => dismissNotification(n.id)}
							className="rounded p-0.5 text-xs opacity-60 hover:opacity-100"
							aria-label={t("core.notificationToast.dismissNotification")}
						>
							&times;
						</button>
					</div>
				</div>
			))}
		</div>
	);
}
