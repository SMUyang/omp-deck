/**
 * Golden Test Dataset for Topology Memory Benchmark
 *
 * Format: each fixture is a simulated session with:
 *   - messages: AgentMessage[] (what agent_end receives)
 *   - expected_nodes: ground truth nodes that SHOULD be extracted
 *   - expected_edges: ground truth edges
 *   - queries: retrieval queries to test
 *   - expected_retrieval: which node titles each query should find
 *   - metadata: scenario description and test tier
 */

export interface GoldenMessage {
	role: "user" | "assistant" | "toolResult";
	content: string;
	id?: string;
	timestamp?: string;
}

export interface ExpectedNode {
	kind: string;
	title_contains: string;
	min_importance?: number;
}

export interface ExpectedEdge {
	relation: string;
	from_title_contains: string;
	to_title_contains: string;
}

export interface RetrievalQuery {
	query: string;
	must_find: string[];  // node title_contains that MUST appear in top-K
	should_not_find?: string[];  // nodes that should NOT appear (stale/superseded)
}

export interface GoldenFixture {
	id: string;
	description: string;
	tier: "T1" | "T2" | "T3" | "T4" | "T5" | "T6";
	messages: GoldenMessage[];
	expected_nodes: ExpectedNode[];
	expected_edges: ExpectedEdge[];
	queries: RetrievalQuery[];
}

export const FIXTURES: GoldenFixture[] = [
	// ── Scenario 1: Single task (basic extraction) ──────────────────────
	{
		id: "s1-single-task",
		description: "Single user request, single response",
		tier: "T1",
		messages: [
			{ role: "user", content: "Write hello world in Python" },
			{ role: "toolResult", content: "File written: /tmp/hello.py" },
			{ role: "toolResult", content: "Hello, World!" },
		],
		expected_nodes: [
			{ kind: "user_intent", title_contains: "hello world", min_importance: 1.0 },
			{ kind: "evidence", title_contains: "hello.py" },
			{ kind: "evidence", title_contains: "Hello, World!" },
		],
		expected_edges: [],
		queries: [
			{ query: "hello world python", must_find: ["hello world"] },
		],
	},

	// ── Scenario 2: Goal + Decision (edge construction) ─────────────────
	{
		id: "s2-goal-decision",
		description: "User states goal, assistant makes architectural decision",
		tier: "T2",
		messages: [
			{ role: "user", content: "目标是减少 memory token 用量" },
			{ role: "assistant", content: "方案选择 topology compression，推荐使用 IDF 评分压缩历史上下文。" },
		],
		expected_nodes: [
			{ kind: "goal", title_contains: "减少 memory token" },
			{ kind: "decision", title_contains: "topology compression" },
		],
		expected_edges: [
			{ relation: "depends_on", from_title_contains: "topology", to_title_contains: "减少" },
		],
		queries: [
			{ query: "为什么选择 topology compression", must_find: ["减少 memory token"] },
		],
	},

	// ── Scenario 3: Goal + Constraint (retention) ───────────────────────
	{
		id: "s3-goal-constraint",
		description: "User sets goal and then adds a constraint",
		tier: "T4",
		messages: [
			{ role: "user", content: "帮我画 GC/AT biased 4-mer 图" },
			{ role: "user", content: "图例必须使用完整 batch name，不要缩写" },
			{ role: "user", content: "另外改成 name-indexed sample mapping" },
		],
		expected_nodes: [
			{ kind: "user_intent", title_contains: "GC/AT biased 4-mer" },
			{ kind: "constraint", title_contains: "完整 batch name" },
			{ kind: "user_intent", title_contains: "name-indexed sample mapping" },
		],
		expected_edges: [],
		queries: [
			{
				query: "继续优化刚才那个图",
				must_find: ["GC/AT biased 4-mer", "完整 batch name", "name-indexed"],
			},
		],
	},

	// ── Scenario 4: File + Test (artifact/evidence) ─────────────────────
	{
		id: "s4-file-test",
		description: "Code file created and tested",
		tier: "T1",
		messages: [
			{ role: "user", content: "Write auth.ts with JWT verification" },
			{ role: "toolResult", content: "Created auth.ts with verify(jwt) function" },
			{ role: "toolResult", content: "bun test auth.test.ts\n5 pass 0 fail 10 expect" },
		],
		expected_nodes: [
			{ kind: "user_intent", title_contains: "auth.ts" },
			{ kind: "evidence", title_contains: "pass" },
		],
		expected_edges: [],
		queries: [
			{ query: "auth verification test", must_find: ["auth.ts"] },
		],
	},

	// ── Scenario 5: Test failure → Fix (issue→resolution) ───────────────
	{
		id: "s5-test-fail-fix",
		description: "Test fails, then assistant fixes and passes",
		tier: "T1",
		messages: [
			{ role: "user", content: "Run the prime number tests" },
			{ role: "toolResult", content: "3 tests failed, 2 passed, 15 expect() calls" },
			{ role: "assistant", content: "Fixed the edge case. ```ts\nreturn n > 1;\n```" },
			{ role: "toolResult", content: "5 pass 0 fail" },
		],
		expected_nodes: [
			{ kind: "user_intent", title_contains: "prime number" },
			{ kind: "issue", title_contains: "3 tests failed" },
			{ kind: "resolution", title_contains: "Fixed" },
			{ kind: "evidence", title_contains: "5 pass" },
		],
		expected_edges: [],
		queries: [],
	},

	// ── Scenario 6: Requirement modification (stale memory) ─────────────
	{
		id: "s6-requirement-change",
		description: "User changes output format from CSV to Parquet",
		tier: "T4",
		messages: [
			{ role: "user", content: "输出使用 CSV 格式" },
			{ role: "assistant", content: "好的，输出 CSV。" },
			{ role: "user", content: "改成 Parquet，不要 CSV 了" },
		],
		expected_nodes: [
			{ kind: "user_intent", title_contains: "CSV" },
			{ kind: "user_intent", title_contains: "Parquet" },
		],
		expected_edges: [],
		queries: [
			{
				query: "输出用什么格式",
				must_find: ["Parquet"],
				should_not_find: ["输出使用 CSV"],  // old node only, not the new "不要 CSV" node
			},
		],
	},

	// ── Scenario 7: Double requirement change (latest state) ────────────
	{
		id: "s7-double-change",
		description: "Python → Rust → back to Python",
		tier: "T4",
		messages: [
			{ role: "user", content: "用 Python 实现" },
			{ role: "user", content: "改成 Rust" },
			{ role: "user", content: "还是 Python 吧" },
		],
		expected_nodes: [
			{ kind: "user_intent", title_contains: "Python" },
			{ kind: "user_intent", title_contains: "Rust" },
		],
		expected_edges: [],
		queries: [
			{
				query: "用什么语言实现",
				must_find: ["还是 Python"],
				should_not_find: ["Rust"],
			},
		],
	},

	// ── Scenario 8: Two unrelated projects (contamination) ──────────────
	{
		id: "s8-unrelated-projects",
		description: "Fix auth bug, then work on README — should NOT create edge",
		tier: "T2",
		messages: [
			{ role: "user", content: "帮我修 auth bug" },
			{ role: "assistant", content: "Fixed auth.ts" },
			{ role: "user", content: "再帮我修改 README" },
		],
		expected_nodes: [
			{ kind: "user_intent", title_contains: "auth bug" },
			{ kind: "user_intent", title_contains: "README" },
		],
		expected_edges: [],  // NO edge between unrelated goals
		queries: [
			{ query: "auth bug fix", must_find: ["auth bug"], should_not_find: ["README"] },
			{ query: "README", must_find: ["README"], should_not_find: ["auth bug"] },
		],
	},

	// ── Scenario 9: Long conversation (context replacement) ─────────────
	{
		id: "s9-long-session",
		description: "50-turn conversation with early constraints",
		tier: "T4",
		messages: [
			{ role: "user", content: "文件命名必须使用完整 sample name" },
			{ role: "user", content: "输出目录是 results/fragmentomics" },
			{ role: "user", content: "不要修改原始 BAM 文件" },
			{ role: "user", content: "GC 分层使用 90-150 / 151-220 / 221-500" },
			...Array.from({ length: 40 }, (_, i) => ({
				role: "user" as const,
				content: `Processing step ${i + 1}: align reads and call peaks`,
			})),
		],
		expected_nodes: [
			{ kind: "constraint", title_contains: "完整 sample name" },
			{ kind: "user_intent", title_contains: "GC 分层" },
		],
		expected_edges: [],
		queries: [
			{ query: "输出目录", must_find: ["results/fragmentomics"] },
			{ query: "文件命名规则", must_find: ["完整 sample name"] },
			{ query: "BAM 文件", must_find: ["不要修改"] },
		],
	},

	// ── Scenario 10: High-similarity opposite meaning (merge safety) ────
	{
		id: "s10-anti-merge",
		description: "Nearly identical text but opposite meaning",
		tier: "T5",
		messages: [
			{ role: "user", content: "必须使用 PostgreSQL database" },
			{ role: "user", content: "必须不要使用 PostgreSQL database" },
		],
		expected_nodes: [
			{ kind: "constraint", title_contains: "必须使用 PostgreSQL" },
			{ kind: "constraint", title_contains: "必须不要使用 PostgreSQL" },
		],
		expected_edges: [],
		queries: [
			{ query: "database 选择", must_find: ["必须不要使用 PostgreSQL"] },
		],
	},

	// ── Scenario 11: Large node count (pruning) ────────────────────────
	{
		id: "s11-pruning",
		description: "600 nodes to trigger pruning; verify critical constraints survive",
		tier: "T5",
		messages: [],  // Generated programmatically in test
		expected_nodes: [],  // Checked programmatically
		expected_edges: [],
		queries: [],
	},

	// ── Scenario 12: Old memory (decay) ─────────────────────────────────
	{
		id: "s12-decay",
		description: "90-day-old critical constraint should not be pruned by decay",
		tier: "T5",
		messages: [],  // Generated programmatically in test
		expected_nodes: [],
		expected_edges: [],
		queries: [],
	},
];

// ── Anti-Merge Adversarial Dataset ───────────────────────────────────────

export interface AntiMergeCase {
	a: string;
	b: string;
	why: string;
}

export const ANTI_MERGE_CASES: AntiMergeCase[] = [
	{ a: "必须使用完整 batch name", b: "必须不要使用完整 batch name", why: "negation" },
	{ a: "Use PostgreSQL database", b: "Do not use PostgreSQL database", why: "negation" },
	{ a: "MAPQ >= 20", b: "MAPQ >= 30", why: "threshold difference" },
	{ a: "Python 3.11", b: "Python 3.12", why: "version difference" },
	{ a: "keep 3 turns", b: "keep 30 turns", why: "parameter difference" },
	{ a: "输出到 results/v1", b: "输出到 results/v2", why: "path difference" },
	{ a: "Use cosine similarity", b: "Use dot product similarity", why: "method difference" },
	{ a: "保留所有 evidence 节点", b: "删除所有 evidence 节点", why: "opposite action" },
];

// ── Adversarial Classification Cases ─────────────────────────────────────

export interface AdversarialClassCase {
	text: string;
	role: string;
	expected: string | "skip";
	why: string;
}

export const ADVERSARIAL_CLASSIFICATIONS: AdversarialClassCase[] = [
	// Negation attacks
	{ text: "You don't have to use SQLite.", role: "user", expected: "user_intent", why: "negation should not trigger constraint" },
	{ text: "不能说这个方案不能工作。", role: "assistant", expected: "decision", why: "KNOWN LIMITATION: regex classifier sees 方案 → decision; double negation not handled without NLP" },
	{ text: "测试结果没有 error。", role: "toolResult", expected: "evidence", why: "'error' in text but means no error" },

	// False triggers
	{ text: "I recommend against using CSV.", role: "assistant", expected: "decision", why: "recommend triggers decision (correct)" },
	{ text: "The goal is not to optimize.", role: "user", expected: "goal", why: "goal keyword present (may be false positive)" },
	{ text: "constraint: none", role: "user", expected: "constraint", why: "constraint keyword present but means none" },

	// Edge cases
	{ text: "ok", role: "assistant", expected: "skip", why: "too short, no value" },
	{ text: "Done.", role: "assistant", expected: "skip", why: "no action keywords for <20 chars" },
	{ text: "修改了 auth.ts 文件，添加了 JWT 验证逻辑。", role: "assistant", expected: "action", why: "Chinese action verb + >20 chars" },
	{ text: "0 fail 0 error", role: "toolResult", expected: "evidence", why: "zero failures = evidence not issue" },
];
