/**
 * 12 Question Types — tests different recall dimensions.
 *
 * Each question type targets a specific memory capability:
 *   A. Direct Recall — exact fact lookup
 *   B. Semantic Recall — paraphrase / CJK matching
 *   C. Current State — supersession / active state
 *   D. Historical State — superseded state recovery
 *   E. Indirect Graph Recall — multi-hop traversal
 *   F. Causal Recall — "why" reasoning
 *   G. Cross-lingual — mixed CJK/English/code
 *   H. Negative / Distractor — should return nothing
 */

export interface QAQuestion {
	id: string;
	type: "direct" | "semantic" | "current_state" | "historical_state" | "indirect" | "causal" | "cross_lingual" | "negative";
	query: string;
	/** Tokens that MUST appear in the retrieved focus. */
	mustContain: string[];
	/** Tokens that should NOT be prioritized (stale). */
	shouldNotContain?: string[];
	/** For negative questions: expect empty result. */
	expectEmpty?: boolean;
}

export const QUESTIONS: QAQuestion[] = [
	// A. Direct Recall ×2
	{ id: "q1", type: "direct", query: "数据库存储引擎用什么", mustContain: ["SQLite"] },
	{ id: "q2", type: "direct", query: "保留最近几轮对话", mustContain: ["3"] },

	// B. Semantic Recall ×2
	{ id: "q3", type: "semantic", query: "文件命名有什么要求", mustContain: ["完整", "sample"] },
	{ id: "q4", type: "semantic", query: "对上下文保留有什么限制", mustContain: ["3"] },

	// C. Current State ×2 (supersession active)
	{ id: "q5", type: "current_state", query: "当前输出格式是什么", mustContain: ["Parquet"], shouldNotContain: ["输出使用 CSV"] },
	{ id: "q6", type: "current_state", query: "现在用什么语言实现", mustContain: ["Python"], shouldNotContain: ["Rust"] },

	// D. Historical State ×1
	{ id: "q7", type: "historical_state", query: "最开始使用的输出格式", mustContain: ["CSV"] },

	// E. Indirect Graph Recall ×2
	{ id: "q8", type: "indirect", query: "负责检索的文件是什么", mustContain: ["retrieve"] },
	{ id: "q9", type: "indirect", query: "那个 merge bug 最后怎么解决的", mustContain: ["parameter", "variant"] },

	// F. Causal Recall ×1
	{ id: "q10", type: "causal", query: "为什么修改 merge 策略", mustContain: ["合并"] },

	// G. Cross-lingual ×1
	{ id: "q11", type: "cross_lingual", query: "retrieval 实现是哪个文件", mustContain: ["retrieve"] },

	// H. Negative / Distractor ×1
	{ id: "q12", type: "negative", query: "部署用了 Kubernetes 吗", mustContain: [], expectEmpty: true },
];
