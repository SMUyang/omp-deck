import type { ToolRendererProps } from "./ToolCallCard";
import { ArgRow, PathChip, extractResultText, SectionLabel } from "./shared";
import { CodeBlock, detectLangFromPath } from "@/lib/code";
import { formatBytes, shortPath } from "@/lib/utils";
import { useTranslation } from "react-i18next";

export function WriteTool({ args, stream }: ToolRendererProps) {
	const { t } = useTranslation();
	const path = String((args.path as string | undefined) ?? "");
	const content = String((args.content as string | undefined) ?? "");
	const bytes = new Blob([content]).size;
	const result = stream?.result;
	const resultText = result ? extractResultText(result) : "";
	const lineCount = content.split(/\r?\n/).length;
	const language = detectLangFromPath(path);

	return (
		<div className="space-y-1.5">
			<ArgRow k="path" v={<PathChip title={path}>{shortPath(path, 72)}</PathChip>} />
			<ArgRow k="size" v={t("tools.write.size", { bytes: formatBytes(bytes), count: lineCount })} />
			{content ? (
				<details>
					<summary className="cursor-pointer font-mono text-2xs uppercase tracking-meta text-ink-3 hover:text-ink">
						{t("tools.write.body")}
					</summary>
					<div className="mt-1">
						<CodeBlock code={content} language={language} />
					</div>
				</details>
			) : null}
			{resultText ? <div className="font-mono text-2xs text-ink-3">{resultText}</div> : null}
		</div>
	);
}
