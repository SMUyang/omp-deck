import type { RoutineStep } from "@omp-deck/protocol";

import { createInbox, getInbox, listInbox, updateInbox } from "../../db/inbox.ts";
import {
	createTask,
	findStateByName,
	findTaskByDisplayOrId,
	getDefaultState,
	getState,
	getTask,
	listTasks,
	moveTask,
} from "../../db/tasks.ts";
import { renderString } from "../template.ts";
import type { RunContext, StepResult } from "../types.ts";

type DeckStep = Extract<RoutineStep, { type: "deck" }>;

export async function executeDeckStep(
	step: DeckStep,
	context: RunContext,
	_signal: AbortSignal,
): Promise<StepResult> {
	const startedMs = Date.now();
	try {
		switch (step.action) {
			case "create_inbox_item": {
				const item = createInbox({
					kind: step.kind,
					title: renderString(step.title, context as unknown as Record<string, unknown>),
					body:
						step.body === undefined
							? undefined
							: renderString(step.body, context as unknown as Record<string, unknown>),
					source:
						step.source === undefined
							? undefined
							: renderString(step.source, context as unknown as Record<string, unknown>),
				});
				return ok(
					startedMs,
					`created inbox item ${item.id} (${item.kind}): ${item.title}`,
					item,
				);
			}
			case "create_task": {
				const stateId =
					step.state_ref === undefined
						? undefined
						: resolveStateRef(renderString(step.state_ref, context as unknown as Record<string, unknown>));
				const task = createTask({
					title: renderString(step.title, context as unknown as Record<string, unknown>),
					body:
						step.body === undefined
							? undefined
							: renderString(step.body, context as unknown as Record<string, unknown>),
					stateId,
					cwd:
						step.cwd === undefined
							? undefined
							: renderString(step.cwd, context as unknown as Record<string, unknown>),
				});
				return ok(startedMs, `created task T-${task.displayId}: ${task.title}`, task);
			}
			case "move_task": {
				const taskRef = renderString(step.task_ref, context as unknown as Record<string, unknown>);
				const stateRef = renderString(step.state_ref, context as unknown as Record<string, unknown>);
				const task = findTaskByDisplayOrId(taskRef);
				if (!task) return fail(startedMs, `task not found: ${taskRef}`);
				const moved = moveTask(task.id, resolveStateRef(stateRef), step.index ?? 0);
				if (!moved) return fail(startedMs, `move failed for task: ${taskRef}`);
				return ok(startedMs, `moved task T-${moved.displayId} -> ${moved.stateId} @${step.index ?? 0}`, moved);
			}
			case "promote_inbox_item_to_task": {
				const inboxRef = renderString(step.inbox_ref, context as unknown as Record<string, unknown>);
				const item = getInbox(inboxRef);
				if (!item) return fail(startedMs, `inbox item not found: ${inboxRef}`);
				const stateId =
					step.state_ref === undefined
						? getDefaultState().id
						: resolveStateRef(renderString(step.state_ref, context as unknown as Record<string, unknown>));
				const stamp = new Date(item.createdAt).toISOString().slice(0, 10);
				const provenance = `_Promoted from inbox · ${item.kind} · ${stamp} · ${item.id}_`;
				const taskBody = item.body.trim().length > 0 ? `${item.body}\n\n---\n${provenance}` : provenance;
				const task = createTask({ title: item.title, body: taskBody, stateId });
				const shouldMark = step.mark_processed !== false;
				const inbox = shouldMark ? updateInbox(item.id, { processed: true }) ?? item : item;
				return ok(startedMs, `promoted inbox ${item.id} -> T-${task.displayId}`, { task, inbox });
			}
			case "list_tasks": {
				const stateFilterId =
					step.state_ref === undefined
						? undefined
						: resolveStateRef(
								renderString(
									step.state_ref,
									context as unknown as Record<string, unknown>,
								),
						  );
				const cutoffMs =
					step.since_hours === undefined ? undefined : Date.now() - step.since_hours * 3_600_000;
				let tasks = listTasks({ includeArchived: step.include_archived === true });
				if (stateFilterId !== undefined) {
					tasks = tasks.filter((t) => t.stateId === stateFilterId);
				}
				if (cutoffMs !== undefined) {
					tasks = tasks.filter((t) => new Date(t.updatedAt).getTime() >= cutoffMs);
				}
				if (step.limit !== undefined) tasks = tasks.slice(0, step.limit);
				const summaries = tasks.map((t) => ({
					id: t.id,
					displayId: t.displayId,
					ref: `T-${t.displayId}`,
					title: t.title,
					stateId: t.stateId,
					updatedAt: t.updatedAt,
					createdAt: t.createdAt,
				}));
				return ok(startedMs, `listed ${summaries.length} task(s)`, summaries);
			}
			case "list_inbox": {
				const cutoffMs =
					step.since_hours === undefined ? undefined : Date.now() - step.since_hours * 3_600_000;
				const opts: { kind?: typeof step.kind; includeProcessed?: boolean } = {
					includeProcessed: step.include_processed === true,
				};
				if (step.kind !== undefined) opts.kind = step.kind;
				let items = listInbox(opts);
				if (cutoffMs !== undefined) {
					items = items.filter((i) => new Date(i.createdAt).getTime() >= cutoffMs);
				}
				if (step.limit !== undefined) items = items.slice(0, step.limit);
				const summaries = items.map((i) => ({
					id: i.id,
					kind: i.kind,
					title: i.title,
					source: i.source,
					createdAt: i.createdAt,
					processedAt: i.processedAt,
				}));
				return ok(startedMs, `listed ${summaries.length} inbox item(s)`, summaries);
			}
			case "get_task": {
				const ref = renderString(
					step.task_ref,
					context as unknown as Record<string, unknown>,
				);
				const task = findTaskByDisplayOrId(ref) ?? getTask(ref);
				if (!task) return fail(startedMs, `task not found: ${ref}`);
				return ok(startedMs, `fetched task T-${task.displayId}: ${task.title}`, task);
			}
			case "get_inbox_item": {
				const ref = renderString(
					step.inbox_ref,
					context as unknown as Record<string, unknown>,
				);
				const item = getInbox(ref);
				if (!item) return fail(startedMs, `inbox item not found: ${ref}`);
				return ok(startedMs, `fetched inbox ${item.id}: ${item.title}`, item);
			}
		}
	} catch (err) {
		return fail(startedMs, String(err));
	}
}

function resolveStateRef(ref: string): string {
	const exact = getState(ref);
	if (exact) return exact.id;
	const byName = findStateByName(ref);
	if (byName) return byName.id;
	throw new Error(`unknown state_ref: ${ref}`);
}

function ok(startedMs: number, stdoutExcerpt: string, json: unknown): StepResult {
	return {
		status: "success",
		stdoutExcerpt,
		stderrExcerpt: "",
		json,
		durationMs: Date.now() - startedMs,
	};
}

function fail(startedMs: number, error: string): StepResult {
	return {
		status: "failed",
		stdoutExcerpt: "",
		stderrExcerpt: "",
		error,
		durationMs: Date.now() - startedMs,
	};
}
