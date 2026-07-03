import type { UserMsg } from "@/lib/types";
import { Markdown } from "@/lib/markdown";
import { ImagePreviewGrid } from "@/components/ui/ImagePreviewGrid";

export function UserMessage({ msg }: { msg: UserMsg }) {
	return (
		<div className="space-y-1.5">
			<div className="meta">
				you
				{msg.synthetic ? <span className="ml-1.5 text-thinking">· synthetic</span> : null}
			</div>
			<ImagePreviewGrid
				images={msg.images ?? []}
				altPrefix="pasted"
				thumbnailClassName="h-28 w-28 rounded border border-line object-cover"
			/>
			{msg.text ? <Markdown>{msg.text}</Markdown> : null}
		</div>
	);
}
