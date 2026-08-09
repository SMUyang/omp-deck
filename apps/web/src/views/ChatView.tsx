import { useTranslation } from "react-i18next";
import { Layout } from "@/components/Layout";
import { Sidebar } from "@/components/Sidebar";
import { Chat } from "@/components/Chat";
import { Composer } from "@/components/Composer";
import { ChatInspector } from "@/components/chat/ChatInspector";
import { StatusBar } from "@/components/chrome/StatusBar";
import { ExtUiDialog } from "@/components/chat/ExtUiDialog";

export function ChatView() {
	const { t } = useTranslation();
	return (
		<>
				<Layout
				sidebar={{ content: <Sidebar />, label: t("views.chatView.sessions") }}
				main={
					<div className="flex h-full min-h-0 flex-col">
						<Chat />
						<Composer />
					</div>
				}
				inspector={{ content: <ChatInspector />, label: t("views.chatView.inspector") }}
				toolCardsToggle={true}
				topBar={<StatusBar />}
			/>
			<ExtUiDialog />
		</>
	);
}
