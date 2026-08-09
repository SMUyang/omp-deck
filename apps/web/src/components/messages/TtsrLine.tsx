import type { TtsrMsg } from "@/lib/types";
import { memo } from "react";
import { useTranslation } from "react-i18next";

export const TtsrLine = memo(function TtsrLine({ msg }: { msg: TtsrMsg }) { const { t } = useTranslation(); return (
		<div className="border-l-2 border-thinking pl-2 py-1">
			<div className="font-mono text-2xs uppercase tracking-meta text-thinking">
				{t("messages.ttsrLine.injected", { count: msg.rules.length })}
			</div>
			<ul className="mt-1 space-y-0.5 text-[13px]">
				{msg.rules.map((r, i) => (
					<li key={i} className="text-ink-2">
						<span className="font-medium text-ink">{r.name ?? t("messages.ttsrLine.ruleNumber", { n: i + 1 })}</span>
						{r.description ? <span className="text-ink-3"> — {r.description}</span> : null}
					</li>
				))}
			</ul>
		</div>
	); });
