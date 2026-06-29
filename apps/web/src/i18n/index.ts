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
