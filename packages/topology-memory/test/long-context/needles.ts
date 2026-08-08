/**
 * 12 Needle Memories — the same core memories embedded at every context level.
 *
 * Each needle is a (role, content) pair that simulates a real OMP conversation.
 * The benchmark tests whether topology memory can retrieve these needles
 * after context replacement, at any position, at any context length.
 */

export interface Needle {
	id: string;
	category: "goal" | "constraint" | "decision" | "artifact" | "issue" | "resolution" | "supersession";
	/** Group id — needles in the same group are placed adjacently (related memories stay together). */
	group: string;
	role: "user" | "assistant" | "toolResult";
	content: string;
	/** Expected kind from classifier. */
	expectedKind: string;
}

export const NEEDLES: Needle[] = [
	// 3 Goals
	{ id: "g1", group: "goals", category: "goal", role: "user", content: "目标是实现 topology memory 扩展", expectedKind: "goal" },
	{ id: "g2", group: "goals", category: "goal", role: "user", content: "目标是在 128K 上下文中保持 88% 召回率", expectedKind: "goal" },
	{ id: "g3", group: "goals", category: "goal", role: "user", content: "目标是支持跨 agent 记忆同步", expectedKind: "goal" },

	// 4 Constraints
	{ id: "c1", group: "constraints", category: "constraint", role: "user", content: "必须使用 SQLite 作为存储引擎", expectedKind: "constraint" },
	{ id: "c2", group: "constraints", category: "constraint", role: "user", content: "保留最近 3 轮对话上下文", expectedKind: "constraint" },
	{ id: "c3", group: "constraints", category: "constraint", role: "user", content: "不能修改原始 BAM 文件", expectedKind: "constraint" },
	{ id: "c4", group: "constraints", category: "constraint", role: "user", content: "文件命名必须使用完整 sample name", expectedKind: "constraint" },

	// 2 Decisions
	{ id: "d1", group: "decisions", category: "decision", role: "assistant", content: "方案选择 hybrid IDF + char bigram 检索策略，推荐使用 inverse document frequency", expectedKind: "decision" },
	{ id: "d2", group: "decisions", category: "decision", role: "assistant", content: "architecture 决定用 character n-gram 解决中文分词问题", expectedKind: "decision" },

	// 1 Artifact
	{ id: "a1", group: "artifact", category: "artifact", role: "assistant", content: "实现了 retrieve.ts 负责检索逻辑", expectedKind: "action" },

	// 1 Issue / Resolution
	{ id: "ir1", group: "issue-res", category: "issue", role: "toolResult", content: "Jaccard merge 把 keep 3 turns 和 keep 30 turns 合并了，2 tests failed", expectedKind: "issue" },
	{ id: "ir2", group: "issue-res", category: "resolution", role: "assistant", content: "加入了 parameter variant protection。```ts\nif (isParameterVariant(a, b)) return false;\n```", expectedKind: "resolution" },

	// 1 Supersession chain: CSV → Parquet
	{ id: "s1_old", group: "sup-csv", category: "supersession", role: "user", content: "输出使用 CSV 格式", expectedKind: "user_intent" },
	{ id: "s1_new", group: "sup-csv", category: "supersession", role: "user", content: "改成 Parquet，不要 CSV 了", expectedKind: "user_intent" },

	// 1 Supersession chain: Python → Rust → Python
	{ id: "s2_old", group: "sup-py", category: "supersession", role: "user", content: "用 Python 实现", expectedKind: "user_intent" },
	{ id: "s2_mid", group: "sup-py", category: "supersession", role: "user", content: "改成 Rust", expectedKind: "user_intent" },
	{ id: "s2_new", group: "sup-py", category: "supersession", role: "user", content: "还是 Python 吧", expectedKind: "user_intent" },
];
