import type { UserMsg } from "@/lib/types";
import { memo } from "react";
import { useTranslation } from "react-i18next";
import { Markdown } from "@/lib/markdown";
import { ImagePreviewGrid } from "@/components/ui/ImagePreviewGrid";

export const UserMessage = memo(function UserMessage({ msg }: { msg: UserMsg }) { const { t } = useTranslation(); return (
		<div className="space-y-1.5">
			<div className="meta">
				{t("messages.userMessage.you")}
				{msg.synthetic ? <span className="ml-1.5 text-thinking">{t("messages.userMessage.synthetic")}</span> : null}
			</div>
			<ImagePreviewGrid
				images={msg.images ?? []}
				altPrefix={t("messages.userMessage.altPrefix")}
				thumbnailClassName="h-28 w-28 rounded border border-line object-cover"
			/>
			{msg.text ? <Markdown>{msg.text}</Markdown> : null}
		</div>
	); });
