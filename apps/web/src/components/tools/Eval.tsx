import type { ToolRendererProps } from "./ToolCallCard";
import { extractResultText } from "./shared";
import { CodeBlock, MaybeJsonBlock } from "@/lib/code";
import { useTranslation } from "react-i18next";

interface Cell {
	language?: string;
	code?: string;
	title?: string;
}

export function EvalTool({ args, stream }: ToolRendererProps) {
	const { t } = useTranslation();
	const cells = Array.isArray((args as { cells?: Cell[] }).cells)
		? ((args as { cells: Cell[] }).cells)
		: typeof (args as { code?: string }).code === "string"
			? [
					{
						code: (args as { code: string }).code,
						language: (args as { language?: string }).language,
					},
				]
			: [];

	const result = stream?.result ?? stream?.partialResult;
	const text = result ? extractResultText(result) : "";

	return (
		<div className="space-y-2">
			{cells.map((c, i) => (
				<div key={i} className="space-y-1">
					<div className="flex items-baseline justify-between gap-2 font-mono text-2xs">
						<div>
							<span className="text-accent">{c.language ?? "?"}</span>
							{c.title ? <span className="ml-1.5 text-ink-3">· {c.title}</span> : null}
						</div>
						<span className="text-ink-4">{t("tools.eval.cellCount", { current: i + 1, total: cells.length })}</span>
					</div>
					<CodeBlock code={c.code ?? ""} language={c.language} />
				</div>
			))}
			{text ? (
				<details open>
					<summary className="cursor-pointer font-mono text-2xs uppercase tracking-meta text-ink-3 hover:text-ink">
						{t("tools.eval.output")}
					</summary>
					<div className="mt-1">
						<MaybeJsonBlock text={text} />
					</div>
				</details>
			) : null}
		</div>
	);
}
