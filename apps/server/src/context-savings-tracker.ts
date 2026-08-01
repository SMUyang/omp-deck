import { createHash } from "node:crypto";
import type { ContextReplacementStatus, ContextUsage } from "@omp-deck/protocol";
import { ContextEvidenceTracker } from "./context-evidence-tracker.ts";
import { logger } from "./log.ts";
const log = logger("context-savings");

export interface ReplacementRecord {
	sessionId: string;
	status: ContextReplacementStatus;
	before: { tokens: number; percent: number };
	focus?: string;
	after?: { tokens: number; percent: number };
	afterStatus: "unknown" | "below_threshold" | "populated";
	triggeredAt: number;
	completedAt?: number;
	evidenceEventId?: string;
	createdAtMs: number;
}

export interface SessionSavingsStats {
	replacements: number;
	tokensSaved: number;
	lastBeforePercent?: number;
	lastAfterPercent?: number;
	lastTriggeredAt?: number;
	lastCompletedAt?: number;
}

export interface ContextSavingsStats {
	totalReplacements: number;
	totalSessions: number;
	totalTokensSaved: number;
	averageTokensSaved: number;
	sessions: Record<string, SessionSavingsStats>;
	recent: ReplacementRecord[];
}

interface PendingRpc {
	beforeTokens: number;
	beforePercent: number;
	triggeredAt: number;
	evidenceEventId?: string;
	cancelTimeout: () => void;
}

export interface ContextSavingsScheduler {
	schedule(callback: () => void, delayMs: number): () => void;
}

const RPC_USAGE_UPDATE_TIMEOUT_MS = 30_000;
const defaultScheduler: ContextSavingsScheduler = {
	schedule(callback, delayMs) {
		const timeout = setTimeout(callback, delayMs);
		return () => clearTimeout(timeout);
	},
};

export class ContextSavingsTracker {
	#records: ReplacementRecord[] = [];
	#pendingRpc: Map<string, PendingRpc> = new Map();
	#maxRecent = 100;

	constructor(
		private readonly evidence?: ContextEvidenceTracker,
		private readonly scheduler: ContextSavingsScheduler = defaultScheduler,
	) {}

	recordTriggered(sessionId: string, before: ContextUsage, focus?: string): ReplacementRecord {
		const triggeredAt = Date.now();
		const record: ReplacementRecord = {
			sessionId,
			status: "compact_requested" as ContextReplacementStatus,
			before: { tokens: before.tokens ?? 0, percent: before.percent ?? 0 },
			afterStatus: "unknown",
			triggeredAt,
			createdAtMs: triggeredAt,
		};
		if (focus !== undefined) record.focus = focus;
		if (this.evidence) {
			const evidenceFocus = focus ?? "[auto compact focus unavailable]";
			record.evidenceEventId = this.evidence.recordReplacement({
				sessionId,
				status: "compact_requested",
				mechanism: "auto_compact",
				beforeTokens: before.tokens,
				beforePercent: before.percent,
				focusHash: createHash("sha256").update(evidenceFocus).digest("hex"),
				focusPreview: evidenceFocus.slice(0, 240),
				focusEstimatedTokens: Math.ceil(evidenceFocus.length / 4),
			});
		}
		this.#records.push(record);
		this.#trim();
		this.#clearPending(sessionId);
		const pending: PendingRpc = {
			beforeTokens: record.before.tokens,
			beforePercent: record.before.percent,
			triggeredAt: record.triggeredAt,
			evidenceEventId: record.evidenceEventId,
			cancelTimeout: () => {},
		};
		pending.cancelTimeout = this.scheduler.schedule(() => {
			this.#recordTimedOut(sessionId, pending);
		}, RPC_USAGE_UPDATE_TIMEOUT_MS);
		this.#pendingRpc.set(sessionId, pending);
		log.info(`recorded context replacement trigger for ${sessionId} (${record.before.percent}% / ${record.before.tokens} tokens)`);
		return record;
	}

	recordCompleted(
		sessionId: string,
		after?: ContextUsage,
		status: ContextReplacementStatus = "compact_completed",
	): ReplacementRecord | undefined {
		// Find the most recent uncompleted record for this session.
		const record = [...this.#records].reverse().find(
			(r) => r.sessionId === sessionId && !r.completedAt,
		);
		if (!record) return undefined;

		if (after) record.after = { tokens: after.tokens ?? 0, percent: after.percent ?? 0 };
		record.completedAt = Date.now();
		this.#clearPending(sessionId);
		if (record.evidenceEventId && this.evidence) {
			this.evidence.updateStatus(record.evidenceEventId, status, {
				afterTokens: after?.tokens ?? null,
				afterPercent: after?.percent ?? null,
				errorMessage: null,
			});
		}
		const saved = record.after ? Math.max(0, record.before.tokens - record.after.tokens) : null;
		log.info(
			`recorded context replacement completion for ${sessionId}: ${record.before.percent}% → ${record.after?.percent ?? "unknown"}%, saved ${saved === null ? "unknown" : `~${saved} tokens`}`,
		);
		return record;
	}

	/**
	 * For RPC mode: when a context_usage event arrives after a compact was sent,
	 * treat the first usage update that is lower than the pending trigger as the
	 * post-compaction state. If no pending trigger exists, this is a no-op.
	 */
	maybeCompleteFromRpcUpdate(
		sessionId: string,
		usage: ContextUsage,
		now = Date.now(),
	): ReplacementRecord | undefined {
		const pending = this.#pendingRpc.get(sessionId);
		if (!pending) return undefined;

		const tokens = usage.tokens ?? 0;
		const percent = usage.percent ?? 0;
		// Only complete if usage dropped meaningfully (more than 5% or 50 tokens)
		// and not too much time has passed (30s window).
		const tokenDrop = pending.beforeTokens - tokens;
		const percentDrop = pending.beforePercent - percent;
		const elapsed = now - pending.triggeredAt;
		if (elapsed > RPC_USAGE_UPDATE_TIMEOUT_MS) {
			this.#recordTimedOut(sessionId, pending);
			return this.completePendingFromUsage(sessionId, usage, now);
		}
		if (tokenDrop < 50 && percentDrop < 5) return undefined;

		return this.recordCompleted(sessionId, usage, "usage_drop_observed");
	}

	discardPending(sessionId: string): void {
		this.#clearPending(sessionId);
	}

	recordFailed(sessionId: string, error: unknown): void {
		const pending = this.#pendingRpc.get(sessionId);
		if (!pending) return;

		if (pending.evidenceEventId && this.evidence) {
			this.evidence.updateStatus(pending.evidenceEventId, "failed", {
				errorMessage: error instanceof Error ? error.message : String(error),
			});
		}
		this.#clearPending(sessionId, pending);
	}

	markAwaitingUsage(sessionId: string, pending: PendingRpc): void {
		if (this.#pendingRpc.get(sessionId) !== pending) return;
		if (pending.evidenceEventId && this.evidence) {
			this.evidence.updateStatus(pending.evidenceEventId, "awaiting_usage", {
				errorMessage: `awaiting post-replace usage update (>${RPC_USAGE_UPDATE_TIMEOUT_MS}ms)`,
			});
		}
	}

	/**
	 * Backfill a still-open (awaiting_usage) pending record with a fresh
	 * `usage` snapshot. Returns the completed record, or undefined if no
	 * pending entry exists / the usage didn't drop meaningfully.
	 */
	completePendingFromUsage(
		sessionId: string,
		usage: ContextUsage,
		now = Date.now(),
	): ReplacementRecord | undefined {
		const pending = this.#pendingRpc.get(sessionId);
		if (!pending) return undefined;

		const tokens = usage.tokens ?? 0;
		const percent = usage.percent ?? 0;
		const tokenDrop = pending.beforeTokens - tokens;
		const percentDrop = pending.beforePercent - percent;

		// Below threshold: usage didn't actually drop (or OMP usage is stale).
		// Stay in awaiting_usage; future polls can complete this record.
		if (tokenDrop < 50 && percentDrop < 5) {
			const idx = this.#records.findIndex((r) => r.evidenceEventId === pending.evidenceEventId);
			const rec = idx >= 0 ? this.#records[idx] : undefined;
			if (rec) rec.afterStatus = "below_threshold";
			return undefined;
		}

		const completed = this.recordCompleted(sessionId, usage, "usage_drop_observed");
		if (completed) completed.afterStatus = "populated";
		return completed;
	}

	#recordTimedOut(sessionId: string, pending: PendingRpc): void {
		if (this.#pendingRpc.get(sessionId) !== pending) return;
		// Move the evidence event to `awaiting_usage` (focus was confirmed at
		// provider_payload_observed; we just couldn't observe a usage drop in
		// time). Keeps the pending entry alive for a later backfill via
		// `completePendingFromUsage` once a poll returns a fresh usage.
		this.markAwaitingUsage(sessionId, pending);
		if (pending.evidenceEventId) {
			const idx = this.#records.findIndex((r) => r.evidenceEventId === pending.evidenceEventId);
			const rec = idx >= 0 ? this.#records[idx] : undefined;
			if (rec) rec.status = "awaiting_usage";
		}
	}

	hasPending(sessionId: string): boolean {
		return this.#pendingRpc.has(sessionId);
	}

	#clearPending(sessionId: string, expected?: PendingRpc): void {
		const pending = this.#pendingRpc.get(sessionId);
		if (!pending || (expected && pending !== expected)) return;
		pending.cancelTimeout();
		this.#pendingRpc.delete(sessionId);
	}

	getStats(): ContextSavingsStats {
		const sessions: Record<string, SessionSavingsStats> = {};
		let totalTokensSaved = 0;

		for (const r of this.#records) {
			if (!sessions[r.sessionId]) {
				sessions[r.sessionId] = {
					replacements: 0,
					tokensSaved: 0,
				};
			}
			const s = sessions[r.sessionId]!;
			s.replacements += 1;
			if (r.after) {
				const saved = Math.max(0, r.before.tokens - r.after.tokens);
				s.tokensSaved += saved;
				totalTokensSaved += saved;
			}
			if (r.triggeredAt) {
				s.lastTriggeredAt = r.triggeredAt;
				s.lastBeforePercent = r.before.percent;
			}
			if (r.completedAt) {
				s.lastCompletedAt = r.completedAt;
				s.lastAfterPercent = r.after?.percent;
			}
		}

		const completed = this.#records.filter((r) => r.completedAt).length;
		return {
			totalReplacements: completed,
			totalSessions: Object.keys(sessions).length,
			totalTokensSaved,
			averageTokensSaved: completed > 0 ? Math.round(totalTokensSaved / completed) : 0,
			sessions,
			recent: this.#recentRecords(),
		};
	}

	#trim(): void {
		if (this.#records.length > this.#maxRecent) {
			this.#records = this.#records.slice(-this.#maxRecent);
		}
	}

	#recentRecords(): ReplacementRecord[] {
		return this.#records.slice(-20).reverse();
	}
}

export const contextSavingsTracker = new ContextSavingsTracker(new ContextEvidenceTracker());
