/**
 * Distractor generation — padding messages to reach target context length.
 *
 * Distractors are realistic but semantically irrelevant messages
 * that simulate normal development conversation noise.
 */

const DISTRACTOR_TEMPLATES = [
	{ role: "user" as const, content: "帮我看一下这个函数的逻辑" },
	{ role: "user" as const, content: "Run the test suite again" },
	{ role: "user" as const, content: "What does this error mean?" },
	{ role: "assistant" as const, content: "Let me check the documentation for this API." },
	{ role: "assistant" as const, content: "The function takes two parameters and returns a promise." },
	{ role: "assistant" as const, content: "I've updated the config file. Here is the change:\n```json\n{ \"debug\": true }\n```" },
	{ role: "toolResult" as const, content: "Process completed with exit code 0" },
	{ role: "toolResult" as const, content: "File saved successfully at /tmp/output.txt" },
	{ role: "user" as const, content: "帮我修改这个变量的命名" },
	{ role: "user" as const, content: "Can you explain how this middleware works?" },
	{ role: "assistant" as const, content: "Sure, the middleware intercepts requests before they reach the handler." },
	{ role: "toolResult" as const, content: "Running benchmark...\n5000 iterations completed in 2.3s" },
	{ role: "user" as const, content: "增加日志输出" },
	{ role: "assistant" as const, content: "Added console.log at entry and exit points." },
	{ role: "user" as const, content: "这个性能不行，优化一下" },
	{ role: "assistant" as const, content: "Optimized by caching the result. 3x speedup." },
	{ role: "toolResult" as const, content: "Linting passed, no errors found." },
	{ role: "user" as const, content: "文档更新了吗？" },
];

const DISTRACTOR_LINE_TEMPLATES = [
	"Processing batch {n}: reading input files and validating schema.",
	"Step {n}: transform data frame and apply filter conditions.",
	"Checkpoint {n}: saved intermediate state to disk.",
	"Validation {n}: 42 records passed, 0 failed.",
	"Cache {n}: hit ratio 94%, evicting LRU entries.",
	"Pipeline {n}: stage completed in {ms}ms.",
	"Query {n}: returned {rows} rows from index scan.",
	"Sync {n}: {count} files uploaded, {size} total.",
];

export interface DistractorMessage {
	role: "user" | "assistant" | "toolResult";
	content: string;
}

/**
 * Generate enough distractor messages to approximately reach the target character count.
 */
export function generateDistractors(targetChars: number, count?: number): DistractorMessage[] {
	const messages: DistractorMessage[] = [];
	let totalChars = 0;
	const maxCount = count ?? 10000;

	let i = 0;
	while (totalChars < targetChars && messages.length < maxCount) {
		const template = DISTRACTOR_TEMPLATES[i % DISTRACTOR_TEMPLATES.length]!;
		const line = DISTRACTOR_LINE_TEMPLATES[i % DISTRACTOR_LINE_TEMPLATES.length]!
			.replace("{n}", String(i + 1))
			.replace("{ms}", String(Math.floor(Math.random() * 500 + 10)))
			.replace("{rows}", String(Math.floor(Math.random() * 10000 + 100)))
			.replace("{count}", String(Math.floor(Math.random() * 500 + 10)))
			.replace("{size}", `${Math.floor(Math.random() * 100 + 1)}MB`);

		messages.push({ role: template.role, content: `${template.content}\n${line}` });
		totalChars += template.content.length + line.length + 2;
		i++;
	}

	return messages;
}
