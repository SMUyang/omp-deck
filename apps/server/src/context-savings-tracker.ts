import type { ContextUsage } from "@omp-deck/protocol";
import { logger } from "./log.ts";

const log = logger("context-savings");

export interface ReplacementRecord {
	sessionId: string;
	before: { tokens: number; percent: number };
	after?: { tokens: number; percent: number };
	triggeredAt: number;
	completedAt?: number;
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
}

class ContextSavingsTracker {
	#records: ReplacementRecord[] = [];
	#pendingRpc: Map<string, PendingRpc> = new Map();
	#maxRecent = 100;

	recordTriggered(sessionId: string, before: ContextUsage): ReplacementRecord {
		const record: ReplacementRecord = {
			sessionId,
			before: { tokens: before.tokens ?? 0, percent: before.percent ?? 0 },
			triggeredAt: Date.now(),
		};
		this.#records.push(record);
		this.#trim();
		this.#pendingRpc.set(sessionId, {
			beforeTokens: record.before.tokens,
			beforePercent: record.before.percent,
			triggeredAt: record.triggeredAt,
		});
		log.info(`recorded context replacement trigger for ${sessionId} (${record.before.percent}% / ${record.before.tokens} tokens)`);
		return record;
	}

	recordCompleted(sessionId: string, after: ContextUsage): ReplacementRecord | undefined {
		// Find the most recent uncompleted record for this session.
		const record = [...this.#records].reverse().find(
			(r) => r.sessionId === sessionId && !r.completedAt,
		);
		if (!record) return undefined;

		record.after = { tokens: after.tokens ?? 0, percent: after.percent ?? 0 };
		record.completedAt = Date.now();
		this.#pendingRpc.delete(sessionId);
		const saved = Math.max(0, record.before.tokens - record.after.tokens);
		log.info(
			`recorded context replacement completion for ${sessionId}: ${record.before.percent}% → ${record.after.percent}%, saved ~${saved} tokens`,
		);
		return record;
	}

	/**
	 * For RPC mode: when a context_usage event arrives after a compact was sent,
	 * treat the first usage update that is lower than the pending trigger as the
	 * post-compaction state. If no pending trigger exists, this is a no-op.
	 */
	maybeCompleteFromRpcUpdate(sessionId: string, usage: ContextUsage): ReplacementRecord | undefined {
		const pending = this.#pendingRpc.get(sessionId);
		if (!pending) return undefined;

		const tokens = usage.tokens ?? 0;
		const percent = usage.percent ?? 0;
		// Only complete if usage dropped meaningfully (more than 5% or 50 tokens)
		// and not too much time has passed (30s window).
		const tokenDrop = pending.beforeTokens - tokens;
		const percentDrop = pending.beforePercent - percent;
		const elapsed = Date.now() - pending.triggeredAt;
		if (elapsed > 30_000) {
			this.#pendingRpc.delete(sessionId);
			return undefined;
		}
		if (tokenDrop < 50 && percentDrop < 5) return undefined;

		return this.recordCompleted(sessionId, usage);
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

export const contextSavingsTracker = new ContextSavingsTracker();
