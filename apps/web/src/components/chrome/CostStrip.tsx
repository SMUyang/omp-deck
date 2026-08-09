import type { UsageRollup } from "@/lib/types";
import { formatCost, formatTokens } from "@/lib/utils";
import { useTranslation } from "react-i18next";

interface Props {
	usage: UsageRollup;
	turns: number;
}

export function CostStrip({ usage, turns }: Props) {
	const { t } = useTranslation();
	return (
		<section className="border-b border-line px-4 py-4">
			<div className="meta mb-2">{t("core.costStrip.usage")}</div>
			<div className="grid grid-cols-2 gap-x-3 gap-y-1.5 font-mono text-2xs">
				<Row k={t("core.costStrip.turns")} v={String(turns)} />
				<Row k={t("core.costStrip.cost")} v={formatCost(usage.cost)} accent />
				<Row k={t("core.costStrip.input")} v={formatTokens(usage.input)} />
				<Row k={t("core.costStrip.output")} v={formatTokens(usage.output)} />
				<Row k={t("core.costStrip.cacheRead")} v={formatTokens(usage.cacheRead)} />
				<Row k={t("core.costStrip.cacheWrite")} v={formatTokens(usage.cacheWrite)} />
				{usage.reasoningTokens !== undefined ? (
					<Row k={t("core.costStrip.reasoning")} v={formatTokens(usage.reasoningTokens)} />
				) : null}
			</div>
		</section>
	);
}

function Row({ k, v, accent }: { k: string; v: string; accent?: boolean }) {
	return (
		<div className="flex items-center justify-between">
			<span className="text-ink-3">{k}</span>
			<span className={accent ? "text-accent" : "text-ink"}>{v}</span>
		</div>
	);
}
