/**
 * Per-step-type forms for the visual builder. Each form takes a strongly-typed
 * step extract and emits a new step of the same type. Common fields (id, when,
 * on_failure, retry, timeout_secs) live in <StepCommonFields/>; this file only
 * renders the type-specific tail.
 */
import type { RoutineStep } from "@omp-deck/protocol";

import { Field, KeyValueEditor, NumInput, TagInput, TextArea, TextInput } from "./form-primitives";

type Extract2<T extends RoutineStep["type"]> = Extract<RoutineStep, { type: T }>;

interface FormProps<T extends RoutineStep["type"]> {
	step: Extract2<T>;
	onChange: (next: Extract2<T>) => void;
}

// ─── run ──────────────────────────────────────────────────────────────────

export function RunStepForm({ step, onChange }: FormProps<"run">) {
	return (
		<div className="space-y-2">
			<Field label="command">
				<TextArea
					value={step.command}
					onChange={(v) => onChange({ ...step, command: v })}
					rows={2}
					placeholder="echo hello"
				/>
			</Field>
			<Field label="cwd (optional)">
				<TextInput
					value={step.cwd ?? ""}
					onChange={(v) => {
						const next = { ...step };
						if (v.trim() === "") delete next.cwd;
						else next.cwd = v;
						onChange(next);
					}}
					placeholder="C:/path/to/repo"
					mono
				/>
			</Field>
		</div>
	);
}

// ─── agent ────────────────────────────────────────────────────────────────

export function AgentStepForm({ step, onChange }: FormProps<"agent">) {
	function patch(p: Partial<Extract2<"agent">>): void {
		onChange({ ...step, ...p });
	}
	return (
		<div className="space-y-2">
			<Field label="prompt">
				<TextArea
					value={step.prompt}
					onChange={(v) => patch({ prompt: v })}
					rows={6}
					placeholder="Summarize {{ steps.fetch_tasks.json }} in 2 sentences."
				/>
			</Field>
			<Field label="model (optional)">
				<TextInput
					value={step.model ?? ""}
					onChange={(v) => {
						const next = { ...step };
						if (v.trim() === "") delete next.model;
						else next.model = v;
						onChange(next);
					}}
					placeholder="claude-sonnet-4-5 (defaults to omp's active model)"
					mono
				/>
			</Field>
			<div className="grid grid-cols-2 gap-2">
				<Field label="skills_allowed">
					<TagInput
						values={step.skills_allowed ?? []}
						onChange={(v) => {
							const next = { ...step };
							if (v.length === 0) delete next.skills_allowed;
							else next.skills_allowed = v;
							onChange(next);
						}}
						placeholder="skill-name"
					/>
				</Field>
				<Field label="mcp_servers_allowed">
					<TagInput
						values={step.mcp_servers_allowed ?? []}
						onChange={(v) => {
							const next = { ...step };
							if (v.length === 0) delete next.mcp_servers_allowed;
							else next.mcp_servers_allowed = v;
							onChange(next);
						}}
						placeholder="server-name"
					/>
				</Field>
			</div>
		</div>
	);
}

// ─── write ────────────────────────────────────────────────────────────────

export function WriteStepForm({ step, onChange }: FormProps<"write">) {
	function patch(p: Partial<Extract2<"write">>): void {
		onChange({ ...step, ...p });
	}
	return (
		<div className="space-y-2">
			<Field label="path">
				<TextInput
					value={step.path}
					onChange={(v) => patch({ path: v })}
					placeholder="inbox/captures/{{ run.date }}-briefing.md"
					mono
				/>
			</Field>
			<Field label="content">
				<TextArea
					value={step.content}
					onChange={(v) => patch({ content: v })}
					rows={5}
					placeholder="# Heading\n\n{{ steps.summarize.stdout }}"
				/>
			</Field>
			<label className="flex items-center gap-2 font-mono text-2xs text-ink-2">
				<input
					type="checkbox"
					checked={step.append === true}
					onChange={(e) => {
						const next = { ...step };
						if (e.target.checked) next.append = true;
						else delete next.append;
						onChange(next);
					}}
				/>
				<span>append (otherwise overwrite)</span>
			</label>
		</div>
	);
}

// ─── http ─────────────────────────────────────────────────────────────────

const HTTP_METHODS: Array<{ value: Extract2<"http">["method"]; label: string }> = [
	{ value: "GET", label: "GET" },
	{ value: "POST", label: "POST" },
	{ value: "PUT", label: "PUT" },
	{ value: "PATCH", label: "PATCH" },
	{ value: "DELETE", label: "DELETE" },
];

export function HttpStepForm({ step, onChange }: FormProps<"http">) {
	function patch(p: Partial<Extract2<"http">>): void {
		onChange({ ...step, ...p });
	}
	return (
		<div className="space-y-2">
			<div className="grid grid-cols-[5rem_1fr] gap-2">
				<Field label="method">
					<select
						value={step.method}
						onChange={(e) => patch({ method: e.target.value as Extract2<"http">["method"] })}
						className="field h-7 w-full px-2 font-mono text-2xs"
					>
						{HTTP_METHODS.map((m) => (
							<option key={m.value} value={m.value}>
								{m.label}
							</option>
						))}
					</select>
				</Field>
				<Field label="url">
					<TextInput
						value={step.url}
						onChange={(v) => patch({ url: v })}
						placeholder="http://127.0.0.1:8787/api/tasks"
						mono
					/>
				</Field>
			</div>
			<Field label="headers">
				<KeyValueEditor
					pairs={(step.headers as Record<string, string>) ?? {}}
					onChange={(v) => {
						const next = { ...step };
						if (Object.keys(v).length === 0) delete next.headers;
						else next.headers = v;
						onChange(next);
					}}
					keyPlaceholder="X-Header"
					valuePlaceholder="value"
				/>
			</Field>
			<Field label="query">
				<KeyValueEditor
					pairs={objToStringMap(step.query)}
					onChange={(v) => {
						const next = { ...step };
						if (Object.keys(v).length === 0) delete next.query;
						else next.query = v;
						onChange(next);
					}}
					keyPlaceholder="param"
					valuePlaceholder="value"
				/>
			</Field>
			{step.method !== "GET" && step.method !== "DELETE" ? (
				<Field label="body (JSON or template)">
					<TextArea
						value={bodyToString(step.body)}
						onChange={(v) => {
							const next = { ...step };
							if (v.trim() === "") delete next.body;
							else next.body = v;
							onChange(next);
						}}
						rows={3}
						placeholder='{ "title": "{{ run.id }}" }'
					/>
				</Field>
			) : null}
			<label className="flex items-center gap-2 font-mono text-2xs text-ink-2">
				<input
					type="checkbox"
					checked={step.expect_json !== false}
					onChange={(e) => {
						const next = { ...step };
						if (e.target.checked) delete next.expect_json;
						else next.expect_json = false;
						onChange(next);
					}}
				/>
				<span>expect JSON response (writes to steps.{step.id}.json)</span>
			</label>
		</div>
	);
}

function objToStringMap(o: unknown): Record<string, string> {
	if (!o || typeof o !== "object") return {};
	const out: Record<string, string> = {};
	for (const [k, v] of Object.entries(o)) {
		out[k] = String(v);
	}
	return out;
}

function bodyToString(b: unknown): string {
	if (b === undefined) return "";
	if (typeof b === "string") return b;
	try {
		return JSON.stringify(b, null, 2);
	} catch {
		return String(b);
	}
}


// ─── deck ─────────────────────────────────────────────────────────────────

type DeckStep = Extract2<"deck">;

export function DeckStepForm({ step, onChange }: FormProps<"deck">) {
	function swapAction(action: DeckStep["action"]): void {
		const common = {
			id: step.id,
			type: "deck" as const,
			when: step.when,
			on_failure: step.on_failure,
			retry: step.retry,
			timeout_secs: step.timeout_secs,
		};
		switch (action) {
			case "create_inbox_item":
				onChange({
					...common,
					action,
					kind: "capture",
					title: step.action === action ? step.title : "routine-output-{{ run.date }}",
					body:
						step.action === action
							? step.body
							: step.action === "create_task"
								? step.body
								: "{{ steps.X.stdout }}",
					source: step.action === action ? step.source : "routine:{{ run.id }}",
				});
				return;
			case "create_task":
				onChange({
					...common,
					action,
					title: step.action === action ? step.title : "Follow up on {{ run.date }}",
					body:
						step.action === action
							? step.body
							: step.action === "create_inbox_item"
								? step.body
								: "{{ steps.X.stdout }}",
					state_ref: step.action === action ? step.state_ref : undefined,
					cwd: step.action === action ? step.cwd : undefined,
				});
				return;
			case "move_task":
				onChange({
					...common,
					action,
					task_ref: step.action === action ? step.task_ref : "T-1",
					state_ref: step.action === action ? step.state_ref : "done",
					index: step.action === action ? step.index : 0,
				});
				return;
			case "promote_inbox_item_to_task":
				onChange({
					...common,
					action,
					inbox_ref: step.action === action ? step.inbox_ref : "i_...",
					state_ref: step.action === action ? step.state_ref : undefined,
					mark_processed: step.action === action ? step.mark_processed : undefined,
				});
				return;
			case "list_tasks":
				onChange({
					...common,
					action,
					state_ref: step.action === action ? step.state_ref : "active",
					since_hours: step.action === action ? step.since_hours : undefined,
					include_archived: step.action === action ? step.include_archived : undefined,
					limit: step.action === action ? step.limit : undefined,
				});
				return;
			case "list_inbox":
				onChange({
					...common,
					action,
					kind: step.action === action ? step.kind : undefined,
					since_hours: step.action === action ? step.since_hours : 24,
					include_processed: step.action === action ? step.include_processed : undefined,
					limit: step.action === action ? step.limit : undefined,
				});
				return;
			case "get_task":
				onChange({
					...common,
					action,
					task_ref: step.action === action ? step.task_ref : "T-1",
				});
				return;
			case "get_inbox_item":
				onChange({
					...common,
					action,
					inbox_ref: step.action === action ? step.inbox_ref : "i_...",
				});
				return;
		}
	}

	return (
		<div className="space-y-2">
			<Field label="action">
				<select
					value={step.action}
					onChange={(e) => swapAction(e.target.value as DeckStep["action"])}
					className="field h-7 w-full px-2 font-mono text-2xs"
				>
					<option value="create_inbox_item">create_inbox_item</option>
					<option value="create_task">create_task</option>
					<option value="move_task">move_task</option>
					<option value="promote_inbox_item_to_task">promote_inbox_item_to_task</option>
					<option value="list_tasks">list_tasks</option>
					<option value="list_inbox">list_inbox</option>
					<option value="get_task">get_task</option>
					<option value="get_inbox_item">get_inbox_item</option>
				</select>
			</Field>
			{step.action === "create_inbox_item" ? (
				<div className="space-y-2">
					<Field label="kind">
						<select
							value={step.kind}
							onChange={(e) => onChange({ ...step, kind: e.target.value as Extract<DeckStep, { action: "create_inbox_item" }>["kind"] })}
							className="field h-7 w-full px-2 font-mono text-2xs"
						>
							<option value="capture">capture</option>
							<option value="email">email</option>
							<option value="ticket">ticket</option>
							<option value="idea">idea</option>
							<option value="decision">decision</option>
							<option value="investigation">investigation</option>
						</select>
					</Field>
					<Field label="title">
						<TextInput value={step.title} onChange={(v) => onChange({ ...step, title: v })} placeholder="Morning briefing - {{ run.date }}" mono />
					</Field>
					<Field label="body">
						<TextArea value={step.body ?? ""} onChange={(v) => onChange({ ...step, body: v === "" ? undefined : v })} rows={5} placeholder="{{ steps.write_briefing.stdout }}" />
					</Field>
					<Field label="source (optional)">
						<TextInput value={step.source ?? ""} onChange={(v) => onChange({ ...step, source: v === "" ? undefined : v })} placeholder="routine:daily-briefing" mono />
					</Field>
				</div>
			) : null}
			{step.action === "create_task" ? (
				<div className="space-y-2">
					<Field label="title">
						<TextInput value={step.title} onChange={(v) => onChange({ ...step, title: v })} placeholder="Follow up on {{ run.date }}" mono />
					</Field>
					<Field label="body (optional)">
						<TextArea value={step.body ?? ""} onChange={(v) => onChange({ ...step, body: v === "" ? undefined : v })} rows={4} placeholder="{{ steps.digest.stdout }}" />
					</Field>
					<Field label="state_ref (optional)">
						<TextInput value={step.state_ref ?? ""} onChange={(v) => onChange({ ...step, state_ref: v === "" ? undefined : v })} placeholder="backlog or s_backlog" mono />
					</Field>
					<Field label="cwd (optional)">
						<TextInput value={step.cwd ?? ""} onChange={(v) => onChange({ ...step, cwd: v === "" ? undefined : v })} placeholder="C:/path/to/repo" mono />
					</Field>
				</div>
			) : null}
			{step.action === "move_task" ? (
				<div className="space-y-2">
					<Field label="task_ref">
						<TextInput value={step.task_ref} onChange={(v) => onChange({ ...step, task_ref: v })} placeholder="T-58 or t_01..." mono />
					</Field>
					<Field label="state_ref">
						<TextInput value={step.state_ref} onChange={(v) => onChange({ ...step, state_ref: v })} placeholder="done or s_done" mono />
					</Field>
					<Field label="index (0 = top of destination column)">
						<NumInput value={step.index} onChange={(v) => onChange({ ...step, index: v ?? 0 })} placeholder="0" />
					</Field>
				</div>
			) : null}
			{step.action === "promote_inbox_item_to_task" ? (
				<div className="space-y-2">
					<Field label="inbox_ref">
						<TextInput value={step.inbox_ref} onChange={(v) => onChange({ ...step, inbox_ref: v })} placeholder="i_..." mono />
					</Field>
					<Field label="state_ref (optional)">
						<TextInput value={step.state_ref ?? ""} onChange={(v) => onChange({ ...step, state_ref: v === "" ? undefined : v })} placeholder="backlog or s_backlog" mono />
					</Field>
					<label className="flex items-center gap-2 font-mono text-2xs text-ink-2">
						<input
							type="checkbox"
							checked={step.mark_processed !== false}
							onChange={(e) => {
								const next = { ...step };
								if (e.target.checked) delete next.mark_processed;
								else next.mark_processed = false;
								onChange(next);
							}}
						/>
						<span>mark inbox item processed after promotion</span>
					</label>
				</div>
			) : null}
			{step.action === "list_tasks" ? (
				<div className="space-y-2">
					<Field label="state_ref (optional — name like 'active' or id like 's_active')">
						<TextInput value={step.state_ref ?? ""} onChange={(v) => onChange({ ...step, state_ref: v === "" ? undefined : v })} placeholder="active" mono />
					</Field>
					<Field label="since_hours (optional — only tasks updated in last N hours)">
						<NumInput value={step.since_hours} onChange={(v) => onChange({ ...step, since_hours: v ?? undefined })} placeholder="24" />
					</Field>
					<Field label="limit (optional)">
						<NumInput value={step.limit} onChange={(v) => onChange({ ...step, limit: v ?? undefined })} placeholder="50" />
					</Field>
					<label className="flex items-center gap-2 font-mono text-2xs text-ink-2">
						<input
							type="checkbox"
							checked={step.include_archived === true}
							onChange={(e) => {
								const next = { ...step };
								if (e.target.checked) next.include_archived = true;
								else delete next.include_archived;
								onChange(next);
							}}
						/>
						<span>include archived tasks</span>
					</label>
				</div>
			) : null}
			{step.action === "list_inbox" ? (
				<div className="space-y-2">
					<Field label="kind (optional)">
						<select
							value={step.kind ?? ""}
							onChange={(e) => {
								const v = e.target.value;
								const next = { ...step };
								if (v === "") delete next.kind;
								else next.kind = v as Extract<DeckStep, { action: "list_inbox" }>["kind"];
								onChange(next);
							}}
							className="field h-7 w-full px-2 font-mono text-2xs"
						>
							<option value="">(any)</option>
							<option value="capture">capture</option>
							<option value="email">email</option>
							<option value="ticket">ticket</option>
							<option value="idea">idea</option>
							<option value="decision">decision</option>
							<option value="investigation">investigation</option>
						</select>
					</Field>
					<Field label="since_hours (optional)">
						<NumInput value={step.since_hours} onChange={(v) => onChange({ ...step, since_hours: v ?? undefined })} placeholder="24" />
					</Field>
					<Field label="limit (optional)">
						<NumInput value={step.limit} onChange={(v) => onChange({ ...step, limit: v ?? undefined })} placeholder="50" />
					</Field>
					<label className="flex items-center gap-2 font-mono text-2xs text-ink-2">
						<input
							type="checkbox"
							checked={step.include_processed === true}
							onChange={(e) => {
								const next = { ...step };
								if (e.target.checked) next.include_processed = true;
								else delete next.include_processed;
								onChange(next);
							}}
						/>
						<span>include already-processed items</span>
					</label>
				</div>
			) : null}
			{step.action === "get_task" ? (
				<div className="space-y-2">
					<Field label="task_ref">
						<TextInput value={step.task_ref} onChange={(v) => onChange({ ...step, task_ref: v })} placeholder="T-58 or t_01..." mono />
					</Field>
				</div>
			) : null}
			{step.action === "get_inbox_item" ? (
				<div className="space-y-2">
					<Field label="inbox_ref">
						<TextInput value={step.inbox_ref} onChange={(v) => onChange({ ...step, inbox_ref: v })} placeholder="i_..." mono />
					</Field>
				</div>
			) : null}
		</div>
	);
}

// ─── mcp ──────────────────────────────────────────────────────────────────

export function McpStepForm({ step, onChange }: FormProps<"mcp">) {
	function patch(p: Partial<Extract2<"mcp">>): void {
		onChange({ ...step, ...p });
	}
	return (
		<div className="space-y-2">
			<div className="rounded border border-warn/40 bg-warn/5 px-2 py-1.5 font-mono text-2xs text-warn">
				The <code>mcp</code> step type is stubbed in V1. Runs will fail with a clear V1.5 pointer.
				Use an <code>agent</code> step with <code>mcp_servers_allowed</code> for now.
			</div>
			<div className="grid grid-cols-2 gap-2">
				<Field label="server">
					<TextInput
						value={step.server}
						onChange={(v) => patch({ server: v })}
						placeholder="filesystem"
						mono
					/>
				</Field>
				<Field label="tool">
					<TextInput
						value={step.tool}
						onChange={(v) => patch({ tool: v })}
						placeholder="read_text_file"
						mono
					/>
				</Field>
			</div>
			<Field label="args (JSON)">
				<TextArea
					value={step.args ? JSON.stringify(step.args, null, 2) : "{}"}
					onChange={(v) => {
						try {
							const parsed = JSON.parse(v) as Record<string, unknown>;
							patch({ args: parsed });
						} catch {
							// keep prior — invalid JSON noted by the spec validator on save
						}
					}}
					rows={4}
					placeholder='{ "path": "{{ run.date }}.md" }'
				/>
			</Field>
		</div>
	);
}

// ─── transform ────────────────────────────────────────────────────────────

export function TransformStepForm({ step, onChange }: FormProps<"transform">) {
	return (
		<div className="space-y-2">
			<Field label="body (JS expression, returns the json output)">
				<TextArea
					value={step.body}
					onChange={(v) => onChange({ ...step, body: v })}
					rows={6}
					placeholder={"const tasks = steps.fetch_tasks.json.tasks;\nreturn { count: tasks.length };"}
				/>
			</Field>
			<div className="font-mono text-2xs text-ink-3">
				Sandboxed (quickjs, 100ms cap). Globals: <code>run</code>, <code>trigger</code>,{" "}
				<code>steps</code>, <code>state</code>, <code>env</code>, <code>secrets</code>.
			</div>
		</div>
	);
}

// ─── wait ─────────────────────────────────────────────────────────────────

export function WaitStepForm({ step, onChange }: FormProps<"wait">) {
	return (
		<Field label="duration_secs">
			<NumInput
				value={step.duration_secs}
				onChange={(v) => onChange({ ...step, duration_secs: v ?? 0 })}
				placeholder="5"
			/>
		</Field>
	);
}

// ─── set_state ────────────────────────────────────────────────────────────

export function SetStateStepForm({ step, onChange }: FormProps<"set_state">) {
	return (
		<Field label="state (keys to upsert, values may use {{ template }})">
			<KeyValueEditor
				pairs={objToStringMap(step.state)}
				onChange={(v) => onChange({ ...step, state: v })}
				keyPlaceholder="last_run_date"
				valuePlaceholder="{{ run.date }}"
			/>
		</Field>
	);
}
