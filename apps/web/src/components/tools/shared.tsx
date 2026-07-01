import type { ReactNode } from "react";
import { cn, truncate } from "@/lib/utils";
import { CopyButton } from "@/lib/CopyButton";
import { ImagePreviewGrid } from "@/components/ui/ImagePreviewGrid";

export function extractResultText(result: unknown): string {
	if (result == null) return "";
	if (typeof result === "string") return result;
	if (typeof result !== "object") return String(result);

	const r = result as Record<string, unknown>;
	if (Array.isArray(r.content)) {
		const parts: string[] = [];
		let imageCount = 0;
		for (const c of r.content) {
			if (!c || typeof c !== "object") continue;
			const block = c as Record<string, unknown>;
			if (block.type === "text" && typeof block.text === "string") {
				parts.push(block.text as string);
			} else if (block.type === "image") {
				imageCount += 1;
			}
		}
		if (parts.length > 0) return parts.join("\n");
		// Image-only result: caller (e.g. `ResultImages`) renders the visual; we
		// emit a tiny placeholder so the `<pre>` block stays empty instead of
		// dumping a megabyte of base64 from the JSON.stringify fallback below.
		if (imageCount > 0) return "";
	}
	if (typeof r.text === "string") return r.text;
	if (typeof r.output === "string") return r.output;
	if (typeof r.stdout === "string") return r.stdout;
	if (typeof r.summary === "string") return r.summary;
	try {
		return JSON.stringify(r, null, 2);
	} catch {
		return "[unserializable]";
	}
}

/**
 * Pull `{type: "image", data, mimeType}` blocks out of an SDK tool result's
 * `content[]` array. Returns an empty list when the tool has no images so
 * callers can render conditionally without prep.
 */
export function extractResultImages(
	result: unknown,
): Array<{ data: string; mimeType: string }> {
	if (!result || typeof result !== "object") return [];
	const r = result as Record<string, unknown>;
	if (!Array.isArray(r.content)) return [];
	const out: Array<{ data: string; mimeType: string }> = [];
	for (const c of r.content) {
		if (!c || typeof c !== "object") continue;
		const block = c as Record<string, unknown>;
		if (block.type === "image" && typeof block.data === "string") {
			out.push({
				data: block.data as string,
				mimeType: String(block.mimeType ?? "image/png"),
			});
		}
	}
	return out;
}

/**
 * Shared image grid for any tool whose result includes image content blocks
 * (browser screenshots, `generate_image`, MCP tools returning visuals, etc.).
 * Caps height per image so a 1080p screenshot doesn't push the rest of the
 * conversation offscreen — user can click through to the raw data URL.
 */
export function ResultImages({ result }: { result: unknown }) {
	const images = extractResultImages(result);
	return (
		<ImagePreviewGrid
			images={images}
			altPrefix="tool output"
			thumbnailClassName="max-h-96 w-auto rounded border border-line object-contain"
			containerClassName="space-y-1.5"
		/>
	);
}

export function extractResultDetails(result: unknown): Record<string, unknown> | undefined {
	if (!result || typeof result !== "object") return undefined;
	const r = result as Record<string, unknown>;
	if (r.details && typeof r.details === "object") return r.details as Record<string, unknown>;
	return undefined;
}

export function Pre({ className, children }: { className?: string; children: string }) {
	return (
		<div className="group relative">
			<pre
				className={cn(
					"max-h-72 overflow-auto whitespace-pre-wrap break-words bg-paper-code border-y border-line px-4 py-3 font-mono text-2xs leading-relaxed text-ink",
					className,
				)}
			>
				{children}
			</pre>
			<CopyButton text={children} />
		</div>
	);
}

export function ArgRow({
	k,
	v,
	mono = false,
}: {
	k: string;
	v: ReactNode;
	mono?: boolean;
}) {
	return (
		<div className="grid grid-cols-[max-content_1fr] items-baseline gap-x-3 py-0.5 font-mono text-2xs">
			<span className="text-ink-3">{k}</span>
			<span className={cn("truncate text-ink", mono ? "" : "normal-case")}>{v}</span>
		</div>
	);
}

export function PathChip({ children, title }: { children: ReactNode; title?: string }) {
	return (
		<code
			title={title}
			className="inline rounded bg-paper-3 px-1 py-0.5 font-mono text-2xs text-ink"
		>
			{children}
		</code>
	);
}

export function summarizeArg(value: unknown, max = 80): string {
	if (value == null) return "";
	if (typeof value === "string") return truncate(value, max);
	try {
		return truncate(JSON.stringify(value), max);
	} catch {
		return "[unserializable]";
	}
}

export function SectionLabel({ children }: { children: ReactNode }) {
	return <div className="meta mt-2 mb-1">{children}</div>;
}
