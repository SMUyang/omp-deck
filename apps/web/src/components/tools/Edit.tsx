import type { ToolRendererProps } from "./ToolCallCard";
import { ArgRow, PathChip, Pre, extractResultText } from "./shared";
import { shortPath } from "@/lib/utils";
import { CopyButton } from "@/lib/CopyButton";
import { useTranslation } from "react-i18next";

export function EditTool({ args, stream }: ToolRendererProps) {
	const { t } = useTranslation();
	const path = String((args.path as string | undefined) ?? "");
	const patch = String((args.patch ?? args.input ?? args.edits ?? "") as string);
	const result = stream?.result ?? stream?.partialResult;
	const text = result ? extractResultText(result) : "";

	return (
		<div className="space-y-1.5">
			<ArgRow k="path" v={<PathChip title={path}>{shortPath(path, 72)}</PathChip>} />
			{patch ? <HashlinePatch patch={patch} /> : null}
			{text ? (
				<details open>
					<summary className="cursor-pointer font-mono text-2xs uppercase tracking-meta text-ink-3 hover:text-ink">
						{t("tools.edit.result")}
					</summary>
					<div className="mt-1">
						<Pre>{text}</Pre>
					</div>
				</details>
			) : null}
		</div>
	);
}

function HashlinePatch({ patch }: { patch: string }) {
	const lines = patch.split(/\r?\n/);
	return (
		<div className="group relative">
			<pre className="max-h-72 overflow-auto border-y border-line bg-paper-code px-4 py-3 font-mono text-2xs leading-relaxed">
				{lines.map((line, i) => (
					<div key={i} className={classifyLine(line)}>
						{line || "\u00A0"}
					</div>
				))}
			</pre>
			<CopyButton text={patch} />
		</div>
	);
}

function classifyLine(line: string): string {
	if (line.startsWith("@@ ")) return "text-accent font-medium";
	if (line.startsWith("+ ")) return "text-success";
	if (line.startsWith("- ")) return "text-danger";
	if (line.startsWith("= ")) return "text-warn";
	if (line.startsWith("< ")) return "text-thinking";
	if (line.startsWith("~")) return "text-ink";
	return "text-ink-3";
}
