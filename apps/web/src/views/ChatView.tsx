import { Layout } from "@/components/Layout";
import { Sidebar } from "@/components/Sidebar";
import { Chat } from "@/components/Chat";
import { Composer } from "@/components/Composer";
import { StatusPanel } from "@/components/status/StatusPanel";
import { StatusBar } from "@/components/chrome/StatusBar";
import { ExtUiDialog } from "@/components/chat/ExtUiDialog";

export function ChatView() {
	return (
		<>
			<Layout
				sidebar={{ content: <Sidebar />, label: "Sessions" }}
				main={
					<div className="flex h-full min-h-0 flex-col">
						<Chat />
						<Composer />
					</div>
				}
				inspector={{ content: <StatusPanel />, label: "Status" }}
				toolCardsToggle={true}
				topBar={<StatusBar />}
			/>
			<ExtUiDialog />
		</>
	);
}
