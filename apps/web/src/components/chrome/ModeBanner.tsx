import type { SessionUi } from "@/lib/types";
import { useTranslation } from "react-i18next";

interface Props {
	mode: SessionUi["mode"];
	goal: SessionUi["goal"];
}

export function ModeBanner({ mode, goal }: Props) {
	const { t } = useTranslation();
	if (!mode && !goal) return null;
	return (
		<section className="border-b border-line px-4 py-4">
			<div className="meta mb-2">{t("core.modeBanner.mode")}</div>
			<div className="space-y-1.5 font-mono text-2xs">
				{mode ? (
					<div className="flex items-center gap-1.5">
						<span className="text-accent">{mode.mode}</span>
						{mode.data && typeof mode.data === "object" && "planFile" in (mode.data as Record<string, unknown>) ? (
							<span className="truncate text-ink-3 normal-case tracking-normal">
								{String((mode.data as Record<string, unknown>).planFile)}
							</span>
						) : null}
					</div>
				) : null}
				{goal && typeof goal === "object" && (goal as { goal?: unknown }).goal ? (
					<div className="text-ink-2 normal-case tracking-normal">
						<span className="text-ink-3">{t("core.modeBanner.goalLabel")} </span>
						{String(
							(goal as { goal?: { description?: unknown; summary?: unknown } }).goal?.description ??
								(goal as { goal?: { description?: unknown; summary?: unknown } }).goal?.summary ??
								t("core.modeBanner.notSet"),
						)}
					</div>
				) : null}
			</div>
		</section>
	);
}
