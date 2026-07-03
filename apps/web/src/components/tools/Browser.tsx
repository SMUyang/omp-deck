import type { ToolRendererProps } from "./ToolCallCard";
import { ArgRow, extractResultText } from "./shared";
import { MaybeJsonBlock } from "@/lib/code";
import { ImagePreviewGrid } from "@/components/ui/ImagePreviewGrid";

export function BrowserTool({ args, stream }: ToolRendererProps) {
	const action = String((args.action as string | undefined) ?? "");
	const url = (args.url as string | undefined) ?? undefined;
	const name = (args.name as string | undefined) ?? "main";
	const result = stream?.result ?? stream?.partialResult;
	const text = result ? extractResultText(result) : "";
	const screenshot = extractScreenshot(result);

	return (
		<div className="space-y-1.5">
			<div className="font-mono text-2xs">
				<span className="text-accent">{action || "?"}</span>
				<span className="text-ink-3"> · </span>
				<span className="text-ink">{name}</span>
			</div>
			{url ? <ArgRow k="url" v={url} /> : null}
			{screenshot ? (
				<ImagePreviewGrid
					images={[{ data: screenshot.data, mimeType: screenshot.mimeType }]}
					altPrefix="screenshot"
					thumbnailClassName="max-h-96 w-auto rounded border border-line object-contain"
				/>
			) : null}
			{text ? <MaybeJsonBlock text={text} /> : null}
		</div>
	);
}

function extractScreenshot(result: unknown): { data: string; mimeType: string } | undefined {
	if (!result || typeof result !== "object") return undefined;
	const r = result as Record<string, unknown>;
	if (Array.isArray(r.content)) {
		for (const c of r.content) {
			if (c && typeof c === "object") {
				const obj = c as Record<string, unknown>;
				if (obj.type === "image" && typeof obj.data === "string") {
					return { data: obj.data as string, mimeType: String(obj.mimeType ?? "image/png") };
				}
			}
		}
	}
	return undefined;
}
