/**
 * Update notifier pill rendered in the StatusBar. Polls `/api/version` on
 * mount; if the server says an update is available, shows a small link
 * pointing at the GitHub releases page so the user can read what's new
 * and decide to upgrade.
 *
 * Design constraints (mirrored from `apps/server/src/update-check.ts`):
 *
 *   - **Hidden by default.** Renders nothing while the request is in
 *     flight, when no update is available, when the check is disabled,
 *     or when the server can't reach the registry. The pill only
 *     appears when there's a real actionable update.
 *   - **Click-through, not click-to-update.** We never trigger the
 *     install ourselves; the user runs `npm install -g omp-deck@latest`
 *     in their terminal. The link opens the releases page in a new tab
 *     so they can read the changelog first.
 *   - **One fetch per mount.** No polling, no WS subscription. Update
 *     announcements aren't real-time; checking again on the next page
 *     load is enough.
 */
import { useEffect, useState } from "react";
import { ArrowUpCircle } from "lucide-react";
import { useTranslation } from "react-i18next";

import type { VersionInfo } from "@omp-deck/protocol";

export function UpdatePill() {
	const { t } = useTranslation();
	const [info, setInfo] = useState<VersionInfo | null>(null);

	useEffect(() => {
		let cancelled = false;
		void fetch("/api/version")
			.then((r) => (r.ok ? (r.json() as Promise<VersionInfo>) : null))
			.then((data) => {
				if (cancelled) return;
				setInfo(data);
			})
			.catch(() => {
				// Probe failed (network blip, server bouncing) — leave info null.
				// User just sees no pill; the next page load retries.
			});
		return () => {
			cancelled = true;
		};
	}, []);

	if (!info || info.disabled || !info.updateAvailable || !info.latest) return null;

	return (
		<>
			<span className="text-ink-4">·</span>
			<a
				href={info.releaseUrl}
				target="_blank"
				rel="noopener noreferrer"
				title={t("core.updatePill.title", { current: info.current, latest: info.latest })}
				className="flex items-center gap-1 text-accent hover:text-accent/80"
			>
				<ArrowUpCircle className="h-3 w-3" />
				<span>{t("core.updatePill.available", { version: info.latest })}</span>
			</a>
		</>
	);
}
