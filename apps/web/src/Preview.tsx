/**
 * /preview — static gallery of every tool renderer with mock data.
 *
 * Exists so design + highlighting changes can be inspected without firing a
 * real omp turn. Mounted by App.tsx when `?preview=1` is in the URL.
 */

import { useTranslation } from "react-i18next";
import type { AssistantContentBlock, ToolCallStream } from "@/lib/types";
import { AssistantMessage } from "./components/messages/AssistantMessage";
import { UserMessage } from "./components/messages/UserMessage";
import { ThinkingBlock } from "./components/messages/ThinkingBlock";
import { Notice } from "./components/messages/Notice";

const NOW = Date.now();

function tcStream(partial: Partial<ToolCallStream> & { id: string; name: string }): ToolCallStream {
	return {
		id: partial.id,
		name: partial.name,
		args: partial.args,
		intent: partial.intent,
		status: partial.status ?? "complete",
		isError: partial.isError ?? false,
		startedAt: partial.startedAt ?? NOW - 1200,
		endedAt: partial.endedAt ?? NOW - 1100,
		partialResult: partial.partialResult,
		result: partial.result,
		resultContent: partial.resultContent,
	};
}

// One assistant message per tool-renderer so we exercise the lifecycle shell
// (header + content + status badge) the same way real omp turns do.
function makeMsg(id: string, blocks: AssistantContentBlock[]): {
	id: string;
	role: "assistant";
	blocks: AssistantContentBlock[];
	isStreaming: boolean;
	model: string;
	provider: string;
	durationMs: number;
	usage: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		totalTokens: number;
		cost: number;
	};
} {
	return {
		id,
		role: "assistant",
		blocks,
		isStreaming: false,
		model: "claude-opus-4-7",
		provider: "anthropic",
		durationMs: 2400,
		usage: {
			input: 4200,
			output: 312,
			cacheRead: 18000,
			cacheWrite: 6400,
			totalTokens: 28912,
			cost: 0.024,
		},
	};
}

const toolCalls: Record<string, ToolCallStream> = {
	"tc-read": tcStream({
		id: "tc-read",
		name: "read",
		args: { path: "~/projects/sample/package.json" },
		result: {
			content: [
				{
					type: "text",
					text: `{\n  "name": "omp-deck",\n  "version": "0.1.0",\n  "scripts": {\n    "dev": "bun run --filter='@omp-deck/*' dev",\n    "build": "bun run --filter '@omp-deck/web' build"\n  }\n}`,
				},
			],
		},
	}),
	"tc-write": tcStream({
		id: "tc-write",
		name: "write",
		args: {
			path: "~/projects/sample/notes.md",
			content: "# Notes\n\nA new file.\n",
		},
		result: "Wrote 22 bytes",
	}),
	"tc-edit": tcStream({
		id: "tc-edit",
		name: "edit",
		args: {
			path: "src/server.ts",
			patch: `@@ src/server.ts\n= 3oo..3oo\n~  hostname: \"0.0.0.0\",\n+ 9xx\n~  // graceful shutdown\n- 12yz..12yz`,
		},
		result: "Applied 3 hunks: +2 -1",
	}),
	"tc-bash": tcStream({
		id: "tc-bash",
		name: "bash",
		args: { command: "bun run typecheck && bun run --filter '@omp-deck/web' build" },
		result: { exitCode: 0, output: "tsc -b — OK\nvite v5.4.21 building for production...\n✓ 2081 modules transformed.\n✓ built in 3.44s" },
	}),
	"tc-search": tcStream({
		id: "tc-search",
		name: "search",
		args: { pattern: "ImageAttachment", paths: ["apps/web/src/**/*.tsx"] },
		result: {
			summary: { totalMatches: 4 },
			content: [{ type: "text", text: "apps/web/src/components/Composer.tsx:7\napps/web/src/components/Composer.tsx:18\napps/web/src/lib/store.ts:9\napps/web/src/lib/store.ts:115" }],
		},
	}),
	"tc-lsp": tcStream({
		id: "tc-lsp",
		name: "lsp",
		args: { action: "rename", file: "apps/web/src/lib/store.ts", symbol: "sendPrompt", new_name: "submitPrompt" },
		result: { content: [{ type: "text", text: "Renamed 6 references across 3 files." }] },
	}),
	"tc-task": tcStream({
		id: "tc-task",
		name: "task",
		args: {
			agent: "explore",
			tasks: [
				{ id: "MapTools", description: "Catalog every tool renderer under components/tools/" },
				{ id: "AuditChrome", description: "Audit chrome/ for inconsistent token usage" },
			],
		},
		result: {
			subagents: [
				{ id: "MapTools", status: "complete", durationMs: 8400, cost: 0.04 },
				{ id: "AuditChrome", status: "complete", durationMs: 6100, cost: 0.03 },
			],
		},
	}),
	"tc-web": tcStream({
		id: "tc-web",
		name: "web_search",
		args: { query: "tailwind 3 vs 4 migration", provider: "auto" },
		result: { content: [{ type: "text", text: "**Top result** — *Tailwind v4 alpha release notes*\nNew Oxide engine, native CSS variables. Breaking: `theme.extend` flattened." }] },
	}),
	"tc-eval-js": tcStream({
		id: "tc-eval-js",
		name: "eval",
		args: {
			cells: [
				{
					language: "js",
					code: `const x = 42;\nconsole.log("hello, " + new Date().toISOString());\nfor (const n of [1, 2, 3]) {\n  console.log(\`item \${n}\`);\n}`,
				},
				{
					language: "py",
					title: "math.pi",
					code: `import math\n\ndef ratio(a: float, b: float) -> float:\n    \"\"\"Compute a / b safely.\"\"\"\n    if b == 0:\n        return float(\"inf\")\n    return a / b\n\nprint(math.pi)\nprint(ratio(22, 7))`,
				},
			],
		},
		result: "[1/2] hello, 2026-05-19T20:00:00.000Z\nitem 1\nitem 2\nitem 3\n\n[2/2] 3.141592653589793\n3.142857142857143",
	}),
	"tc-todo": tcStream({
		id: "tc-todo",
		name: "todo_write",
		args: {
			ops: [
				{ op: "init", phase: "Phase 1", items: ["Map renderer surface", "Wire highlight.js"] },
				{ op: "start", task: "Wire highlight.js" },
				{ op: "done", task: "Map renderer surface" },
			],
		},
	}),
	"tc-gen": tcStream({
		id: "tc-gen",
		name: "generate_image",
		args: { subject: "A misty Scottish loch at dawn, hand-drawn ink wash style" },
		result: { content: [{ type: "text", text: "(image data omitted in preview)" }] },
	}),
	"tc-browser": tcStream({
		id: "tc-browser",
		name: "browser",
		args: { action: "goto", url: "https://omp.sh/docs", name: "main" },
		result: { content: [{ type: "text", text: "Loaded omp.sh/docs (title: \"omp documentation\")." }] },
	}),
	"tc-running": tcStream({
		id: "tc-running",
		name: "search",
		args: { pattern: "still going" },
		status: "running",
		endedAt: undefined,
	}),
	"tc-err": tcStream({
		id: "tc-err",
		name: "bash",
		args: { command: "exit 1" },
		status: "error",
		isError: true,
		result: { exitCode: 1, output: "command exited 1" },
	}),
};

export function PreviewPage() {
	const { t } = useTranslation();
	return (
		<div className="h-full w-full overflow-y-auto bg-paper">
			<div className="mx-auto max-w-[920px] space-y-10 px-6 py-10">
				<header className="space-y-2 border-b border-line pb-4">
					<div className="meta">{t("core.preview.tagline")}</div>
					<h1 className="font-mono text-lg text-ink">{t("core.preview.title")}</h1>
					<p className="text-sm text-ink-3">{t("core.preview.description")}</p>
				</header>

				<Section title={t("core.preview.sectionMessages")}>
					<UserMessage
						msg={{
							id: "u-1",
							role: "user",
							text: "Run a quick eval and tell me the pi value. Use the read tool first to grab `package.json` for context.",
							timestamp: NOW - 60000,
						}}
					/>
					<AssistantMessage
						msg={makeMsg("a-1", [
							{
								type: "thinking",
								thinking:
									"Plan:\n1. Read package.json to know the project shape\n2. Run a tiny eval cell with math.pi\n3. Stop after one turn",
							},
							{ type: "text", text: "Reading the manifest first." },
							{
								type: "toolCall",
								id: "tc-read",
								name: "read",
								arguments: { path: "~/projects/sample/package.json" },
							},
							{ type: "text", text: "Now the eval:" },
							{
								type: "toolCall",
								id: "tc-eval-js",
								name: "eval",
								arguments: (toolCalls["tc-eval-js"]?.args ?? {}) as Record<string, unknown>,
							},
							{
								type: "text",
								text: "**Pi is** `3.141592653589793`. Inline `code`, **bold**, _italic_, and a fenced block:\n\n```rust\nfn main() {\n    println!(\"hello, world\");\n    let xs: Vec<i32> = (1..=5).collect();\n    for x in xs { println!(\"{x}\"); }\n}\n```",
							},
						])}
						toolCalls={toolCalls}
					/>
				</Section>

				<Section title={t("core.preview.sectionThinking")}>
					<ThinkingBlock
						text={`Reasoning step by step\n1. Plan\n2. Execute\n3. Report\n\n**Sub-plan:** explore, then act.`}
					/>
				</Section>

				<Section title={t("core.preview.sectionNotices")}>
					<Notice msg={{ id: "n1", role: "notice", level: "info", source: "ttsr", message: "Fallback applied: gpt-4o → claude-opus-4-7 (default)", timestamp: NOW }} />
					<Notice msg={{ id: "n2", role: "notice", level: "warning", message: "Auto-compaction starting (context > 80%)", timestamp: NOW }} />
					<Notice msg={{ id: "n3", role: "notice", level: "error", source: "provider", message: "429 rate limit — backing off 4s", timestamp: NOW }} />
				</Section>

				<Section title={t("core.preview.sectionTools")}>
					{(
						[
							["tc-read", "read"],
							["tc-write", "write"],
							["tc-edit", "edit"],
							["tc-bash", "bash"],
							["tc-search", "search"],
							["tc-lsp", "lsp"],
							["tc-task", "task"],
							["tc-web", "web_search"],
							["tc-eval-js", "eval"],
							["tc-todo", "todo_write"],
							["tc-gen", "generate_image"],
							["tc-browser", "browser"],
							["tc-running", "search"],
							["tc-err", "bash"],
						] as Array<[keyof typeof toolCalls, string]>
					).map(([id, name]) => (
						<AssistantMessage
							key={id as string}
							msg={makeMsg(`a-${id as string}`, [
								{
									type: "toolCall",
									id: id as string,
									name,
									arguments: (toolCalls[id as string]?.args ?? {}) as Record<string, unknown>,
								},
							])}
							toolCalls={toolCalls}
						/>
					))}
				</Section>
			</div>
		</div>
	);
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
	return (
		<section className="space-y-4">
			<div className="meta">{title}</div>
			<div className="space-y-6">{children}</div>
		</section>
	);
}
