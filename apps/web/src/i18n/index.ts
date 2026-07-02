import i18n from "i18next";
import { initReactI18next } from "react-i18next";

const STORAGE_KEY = "omp-deck-lang";

function getInitialLang(): string {
	try {
		const saved = localStorage.getItem(STORAGE_KEY);
		if (saved === "en" || saved === "zh-CN") return saved;
	} catch {
		// localStorage may be unavailable
	}
	// Auto-detect from browser
	const navLang = navigator.language;
	if (navLang.startsWith("zh")) return "zh-CN";
	return "en";
}

export const SUPPORTED_LANGS = ["en", "zh-CN"] as const;
export type Lang = (typeof SUPPORTED_LANGS)[number];

export const LANG_LABELS: Record<Lang, string> = {
	en: "English",
	"zh-CN": "中文",
};

export function changeLang(lang: Lang): void {
	void i18n.changeLanguage(lang);
	try {
		localStorage.setItem(STORAGE_KEY, lang);
	} catch {
		// ignore
	}
}

export function getCurrentLang(): Lang {
	const current = i18n.language;
	if (current === "zh-CN") return "zh-CN";
	return "en";
}

void i18n.use(initReactI18next).init({
	resources: {
		en: {
			translation: {
				nav: {
					chat: "Chat",
					tasks: "Tasks",
					routines: "Routines",
					inbox: "Inbox",
					marketplace: "Marketplace",
					skills: "Skills",
					knowledge: "Knowledge",
					integrations: "Integrations",
					memory: "Memory",
					settings: "Settings",
				},
				sidebar: {
					workspace: "Workspace",
					allWorkspaces: "(all workspaces)",
					newSession: "New session",
					sessions: "Sessions",
					noSessions: "No sessions yet.",
					refreshWorkspaces: "Refresh workspaces",
					refreshSessions: "Refresh sessions",
					live: "live",
					plan: "plan",
					addWorkspace: "Add workspace",
					removeWorkspace: "Remove workspace",
					workspaceLabelPrompt: "Optional display label",
					workspaceRemoveConfirm: "Remove this workspace from omp-deck? Files and sessions will not be deleted.",
					workspaceCreateFailed: "Failed to add workspace",
					workspaceDeleteFailed: "Failed to remove workspace",
					deleteSession: "Delete session",
					sessionDeleteConfirm: "Delete session \"{{title}}\" from history? This removes the session file.",
					sessionDeleteFailed: "Failed to delete session",
					showHiddenDirectories: "Show hidden directories",
					selectThisFolder: "Select this folder",
					parentDirectory: "Parent",
					noChildDirectories: "No child directories.",
				},
				composer: {
					attachImage: "Attach image",
					stopStreaming: "Stop streaming (Ctrl+.)",
					send: "Send",
					removeImage: "Remove image",
					stop: "stop",
					queuedCancel: "queued · cancel",
					dropQueued: "Drop every queued prompt for this session",
					queuedCount: "{{count}} queued · cancel",
				},
				connection: {
					connected: "connected",
					disconnected: "disconnected",
					reconnecting: "reconnecting",
					noHeartbeat: "no heartbeat yet",
				},
				language: {
					label: "Language",
					description: "Interface language",
				},
				memory: {
					title: "Memory Cockpit",
					backend: "Backend",
					agentDir: "Agent directory",
					memoryDir: "Memory directory",
					banks: "Banks",
					working: "Working",
					episodic: "Episodic",
					facts: "Facts",
					embeddings: "Embeddings",
					graphEdges: "Graph edges",
					search: "Search memories",
					searchPlaceholder: "Search across all memory banks…",
					noResults: "No memories found.",
					noQuery: "Enter a query to search, or browse all memories.",
					unavailable: "Memory is not available.",
					topology: "Memory topology",
					topologyHint: "Click a bank to filter results.",
					topologyAria: "Topology graph of Mnemopi memory banks and stores",
					allBanks: "all banks",
					clearBankFilter: "clear {{bank}} filter",
					noBankResults: "No visible memories in {{bank}}.",
					bankTopologyTitle: "{{bank}} has {{count}} memory records",
					graphSearchPlaceholder: "Search topology nodes…",
					graphSearch: "Search topology",
					graphLoading: "Loading topology…",
					graphEmpty: "No topology nodes.",
					graphStats: "{{nodes}} nodes · {{edges}} edges",
					graphTruncated: "showing partial graph of {{total}} nodes",
					graphSelectedNode: "selected node",
					statusLoadFailed: "Failed to load memory status.",
					retry: "Retry",
					recallCount: "recalled {{count}}×",
					importance: "importance",
					type: "type",
					source: "source",
					bank: "bank",
					timestamp: "timestamp",
				},
			},
		},
		"zh-CN": {
			translation: {
				nav: {
					chat: "聊天",
					tasks: "任务",
					routines: "例行任务",
					inbox: "收件箱",
					marketplace: "市场",
					skills: "技能",
					knowledge: "知识库",
					integrations: "集成",
					memory: "记忆",
					settings: "设置",
				},
				sidebar: {
					workspace: "工作区",
					allWorkspaces: "（全部工作区）",
					newSession: "新建会话",
					sessions: "会话",
					noSessions: "暂无会话",
					refreshWorkspaces: "刷新工作区",
					refreshSessions: "刷新会话",
					live: "活跃",
					plan: "计划",
					addWorkspace: "添加工作区",
					removeWorkspace: "移除工作区",
					workspaceLabelPrompt: "可选的显示名称",
					workspaceRemoveConfirm: "确定从 omp-deck 移除该工作区？文件和会话不会被删除。",
					workspaceCreateFailed: "添加工作区失败",
					workspaceDeleteFailed: "移除工作区失败",
					deleteSession: "删除会话",
					sessionDeleteConfirm: "从历史记录删除会话“{{title}}”？这会移除会话文件。",
					sessionDeleteFailed: "删除会话失败",
					showHiddenDirectories: "显示隐藏目录",
					selectThisFolder: "选择此文件夹",
					parentDirectory: "上一级",
					noChildDirectories: "没有子目录。",
				},
				composer: {
					attachImage: "添加图片",
					stopStreaming: "停止生成 (Ctrl+.)",
					send: "发送",
					removeImage: "移除图片",
					stop: "停止",
					queuedCancel: "排队 · 取消",
					dropQueued: "清空该会话的所有排队消息",
					queuedCount: "{{count}} 排队 · 取消",
				},
				connection: {
					connected: "已连接",
					disconnected: "未连接",
					reconnecting: "重连中",
					noHeartbeat: "等待心跳",
				},
				language: {
					label: "语言",
					description: "界面语言",
				},
				memory: {
					title: "记忆控制台",
					backend: "后端",
					agentDir: "Agent 目录",
					memoryDir: "记忆目录",
					banks: "记忆库",
					working: "工作记忆",
					episodic: "情景记忆",
					facts: "事实",
					embeddings: "向量嵌入",
					graphEdges: "图谱边",
					search: "搜索记忆",
					searchPlaceholder: "跨所有记忆库搜索…",
					noResults: "未找到相关记忆。",
					noQuery: "输入关键词搜索，或浏览全部记忆。",
					unavailable: "记忆功能不可用。",
					topology: "记忆拓扑",
					topologyHint: "点击记忆库过滤结果。",
					topologyAria: "Mnemopi 记忆库与存储类型的拓扑图",
					allBanks: "全部记忆库",
					clearBankFilter: "清除 {{bank}} 过滤",
					noBankResults: "{{bank}} 中没有可见记忆。",
					bankTopologyTitle: "{{bank}} 有 {{count}} 条记忆记录",
					graphSearchPlaceholder: "搜索拓扑节点…",
					graphSearch: "搜索拓扑",
					graphLoading: "正在加载拓扑…",
					graphEmpty: "没有拓扑节点。",
					graphStats: "{{nodes}} 个节点 · {{edges}} 条边",
					graphTruncated: "当前仅显示 {{total}} 个节点中的一部分",
					graphSelectedNode: "选中节点",
					statusLoadFailed: "记忆状态加载失败。",
					retry: "重试",
					recallCount: "召回 {{count}} 次",
					importance: "重要性",
					type: "类型",
					source: "来源",
					bank: "记忆库",
					timestamp: "时间",
				},
			},
		},
	},
	lng: getInitialLang(),
	fallbackLng: "en",
	interpolation: {
		escapeValue: false,
	},
});

export default i18n;
