import type { ToolRendererProps } from "./ToolCallCard";
import { ResultImages, extractResultText } from "./shared";
import { CodeBlock, MaybeJsonBlock } from "@/lib/code";
import { useTranslation } from "react-i18next";

export function GenericTool({ args, stream }: ToolRendererProps) {
	const { t } = useTranslation();
	const result = stream?.result;
	const partial = stream?.partialResult;
	const text = result ? extractResultText(result) : partial ? extractResultText(partial) : "";
	// Args are always a structured object at this protocol boundary — render
	// as JSON so keys/strings/numbers colorize. Pretty-print for readability.
	const argsText = JSON.stringify(args, null, 2);

	return (
		<div className="space-y-1.5">
			<details>
				<summary className="cursor-pointer font-mono text-2xs uppercase tracking-meta text-ink-3 hover:text-ink">
					{t("tools.generic.args")}
				</summary>
				<div className="mt-1">
					<CodeBlock code={argsText} language="json" className="max-h-48" />
				</div>
			</details>
			{/* Render image blocks first — they're the headline output when a tool
			    returns visuals (MCP screenshots, future inspection tools, etc.). */}
			<ResultImages result={result ?? partial} />
			{text ? (
				<details open={!result}>
					<summary className="cursor-pointer font-mono text-2xs uppercase tracking-meta text-ink-3 hover:text-ink">
						{result ? t("tools.generic.result") : t("tools.generic.partial")}
					</summary>
					<div className="mt-1">
						{/* Tool results are commonly JSON (extractResultText falls back to
						    JSON.stringify on object payloads) but not guaranteed —
						    MaybeJsonBlock highlights when parseable, plain otherwise. */}
						<MaybeJsonBlock text={text} className="max-h-64" />
					</div>
				</details>
			) : null}
		</div>
	);
}
