import { selectActiveSession, useStore } from "@/lib/store";
import { UpdatePill } from "./UpdatePill";
import { cn, formatTokens } from "@/lib/utils";
import { useTranslation } from "react-i18next";

const STATUS_TONE: Record<string, string> = {
	idle: "text-ink-3",
	streaming: "text-accent",
	compacting: "text-warn",
	retrying: "text-warn",
};

export function StatusBar() {
	const { t } = useTranslation();
	const wsStatus = useStore((s) => s.wsStatus);
	const session = useStore(selectActiveSession);

	const wsText =
		wsStatus === "open"
			? t("core.statusBar.wsOpen")
			: wsStatus === "connecting"
				? t("core.statusBar.wsConnecting")
				: t("core.statusBar.wsClosed");
	const wsTone =
		wsStatus === "open"
			? "text-success"
			: wsStatus === "connecting"
				? "text-warn"
				: "text-danger";

	return (
		<div className="flex items-center gap-x-3 font-mono text-2xs uppercase tracking-meta">
			<span className={cn("flex items-center gap-1.5", wsTone)}>
				<Dot className={cn("h-1.5 w-1.5", wsTone)} />
				{wsText}
			</span>
			{session ? (
				<>
					<span className="text-ink-4">·</span>
					<span className={STATUS_TONE[session.status] ?? "text-ink-3"}>
						{session.status === "idle"
							? t("core.statusBar.ready")
							: session.status === "streaming"
								? t("core.statusBar.streaming")
								: session.status === "compacting"
									? t("core.statusBar.compacting")
									: t("core.statusBar.retrying")}
					</span>
					{session.retry ? (
						<>
							<span className="text-ink-4">·</span>
							<span className="text-warn">
								{t("core.statusBar.retry", { attempt: session.retry.attempt, maxAttempts: session.retry.maxAttempts })}
							</span>
						</>
					) : null}
					{session.compaction ? (
						<>
							<span className="text-ink-4">·</span>
							<span className="text-warn">{t("core.statusBar.compactingAction", { action: session.compaction.action })}</span>
						</>
					) : null}
					{session.ttsr && Date.now() - session.ttsr.at < 8000 ? (
						<>
							<span className="text-ink-4">·</span>
							<span className="text-thinking">{t("core.statusBar.ttsrCount", { count: session.ttsr.rules.length })}</span>
						</>
					) : null}
					{session.usage.totalTokens > 0 ? (
						<>
							<span className="text-ink-4">·</span>
							<span className="text-ink-3 normal-case tracking-normal">
								{t("core.statusBar.tokens", { count: formatTokens(session.usage.totalTokens) })}
							</span>
						</>
					) : null}
				</>
			) : null}
			<UpdatePill />
		</div>
	);
}

function Dot({ className }: { className?: string }) {
	return (
		<span
			className={cn("inline-block rounded-full bg-current", className)}
			aria-hidden="true"
		/>
	);
}
