import type {
	ContextReplacementEvent,
	ContextEvidenceStats,
	ContextReplacementStatus,
	ContextReplacementMechanism,
} from "@omp-deck/protocol";

import { getDb, id, nowIso } from "./db/index.ts";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface RecordReplacementParams {
	sessionId: string;
	status: string;
	mechanism: ContextReplacementMechanism;
	beforeTokens?: number | null;
	beforePercent?: number | null;
	afterTokens?: number | null;
	afterPercent?: number | null;
	focusHash: string;
	focusPreview: string;
	focusEstimatedTokens?: number;
	focusEstimateMethod?: "chars_div_4";
	providerRole?: string | null;
	errorMessage?: string | null;
}

export interface UpdateStatusParams {
	beforeTokens?: number | null;
	beforePercent?: number | null;
	afterTokens?: number | null;
	afterPercent?: number | null;
	providerRole?: string | null;
	errorMessage?: string | null;
}

// ─── Row shape from SQLite ───────────────────────────────────────────────────

interface EventRow {
	id: string;
	session_id: string;
	status: string;
	mechanism: string;
	before_tokens: number | null;
	before_percent: number | null;
	after_tokens: number | null;
	after_percent: number | null;
	saved_tokens: number | null;
	saved_percent: number | null;
	focus_hash: string;
	focus_preview: string;
	focus_estimated_tokens: number;
	focus_estimate_method: string;
	provider_role: string | null;
	error_message: string | null;
	retry_count: number;
	created_at: string;
	updated_at: string;
}

// ─── Token math ──────────────────────────────────────────────────────────────

function computeSavings(
	beforeTokens: number | null | undefined,
	afterTokens: number | null | undefined,
): { savedTokens: number | null; savedPercent: number | null } {
	if (beforeTokens == null || afterTokens == null) {
		return { savedTokens: null, savedPercent: null };
	}
	const saved = Math.max(0, beforeTokens - afterTokens);
	const pct = beforeTokens > 0
		? Number(((saved / beforeTokens) * 100).toFixed(1))
		: 0;
	return { savedTokens: saved, savedPercent: pct };
}

// ─── Row → protocol type ─────────────────────────────────────────────────────

function rowToEvent(row: EventRow): ContextReplacementEvent {
	return {
		id: row.id,
		sessionId: row.session_id,
		status: row.status as ContextReplacementStatus,
		mechanism: row.mechanism as ContextReplacementMechanism,
		beforeTokens: row.before_tokens,
		beforePercent: row.before_percent,
		afterTokens: row.after_tokens,
		afterPercent: row.after_percent,
		savedTokens: row.saved_tokens,
		savedPercent: row.saved_percent,
		focusHash: row.focus_hash,
		focusPreview: row.focus_preview,
		focusEstimatedTokens: row.focus_estimated_tokens,
		focusEstimateMethod: row.focus_estimate_method as "chars_div_4",
		providerRole: row.provider_role,
		errorMessage: row.error_message,
		retryCount: row.retry_count,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}


// ─── Class ───────────────────────────────────────────────────────────────────

export class ContextEvidenceTracker {
	recordReplacement(params: RecordReplacementParams): string {
		const db = getDb();
		const eventId = id();
		const now = nowIso();

		const { savedTokens, savedPercent } = computeSavings(
			params.beforeTokens,
			params.afterTokens,
		);

		db.run(
			`INSERT INTO context_replacement_events (
				id, session_id, status, mechanism,
				before_tokens, before_percent, after_tokens, after_percent,
				saved_tokens, saved_percent,
				focus_hash, focus_preview, focus_estimated_tokens, focus_estimate_method,
				provider_role, error_message, retry_count,
				created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				eventId,
				params.sessionId,
				params.status,
				params.mechanism,
				params.beforeTokens ?? null,
				params.beforePercent ?? null,
				params.afterTokens ?? null,
				params.afterPercent ?? null,
				savedTokens,
				savedPercent,
				params.focusHash,
				params.focusPreview,
				params.focusEstimatedTokens ?? 0,
				params.focusEstimateMethod ?? "chars_div_4",
				params.providerRole ?? null,
				params.errorMessage ?? null,
				0,
				now,
				now,
			],
		);

		return eventId;
	}

	updateStatus(
		eventId: string,
		status: string,
		updates?: UpdateStatusParams,
	): boolean {
		const db = getDb();
		const now = nowIso();

		// Read current row to merge with updates
		const current = db
			.query<EventRow, [string]>(
				"SELECT * FROM context_replacement_events WHERE id = ?",
			)
			.get(eventId);

		if (!current) return false;

		const beforeTokens = updates?.beforeTokens !== undefined
			? updates.beforeTokens
			: current.before_tokens;
		const beforePercent = updates?.beforePercent !== undefined
			? updates.beforePercent
			: current.before_percent;
		const afterTokens = updates?.afterTokens !== undefined
			? updates.afterTokens
			: current.after_tokens;
		const afterPercent = updates?.afterPercent !== undefined
			? updates.afterPercent
			: current.after_percent;

		const { savedTokens, savedPercent } = computeSavings(beforeTokens, afterTokens);

		db.run(
			`UPDATE context_replacement_events SET
				status = ?,
				before_tokens = ?, before_percent = ?,
				after_tokens = ?, after_percent = ?,
				saved_tokens = ?, saved_percent = ?,
				provider_role = ?,
				error_message = ?,
				updated_at = ?
			WHERE id = ?`,
			[
				status,
				beforeTokens,
				beforePercent,
				afterTokens,
				afterPercent,
				savedTokens,
				savedPercent,
				updates?.providerRole !== undefined ? updates.providerRole : current.provider_role,
				updates?.errorMessage !== undefined ? updates.errorMessage : current.error_message,
				now,
				eventId,
			],
		);
		return true;
	}

	getSessionEvidence(
		sessionId: string,
		limit?: number,
		offset?: number,
	): ContextReplacementEvent[] {
		const db = getDb();
		const rows = db
			.query<EventRow, [string, number, number]>(
				`SELECT * FROM context_replacement_events
				 WHERE session_id = ?
				 ORDER BY created_at DESC, rowid DESC
				 LIMIT ? OFFSET ?`,
			)
			.all(sessionId, limit ?? 1000, offset ?? 0);

		return rows.map(rowToEvent);
	}

	getStats(): ContextEvidenceStats {
		const db = getDb();

		const total = (
			db.query<{ n: number }, []>(
				"SELECT COUNT(*) as n FROM context_replacement_events",
			).get() ?? { n: 0 }
		).n;

		const completed = (
			db.query<{ n: number }, []>(
				"SELECT COUNT(*) as n FROM context_replacement_events WHERE status = 'provider_payload_observed'",
			).get() ?? { n: 0 }
		).n;

		const totalSaved = (
			db.query<{ n: number }, []>(
				"SELECT COALESCE(SUM(saved_tokens), 0) as n FROM context_replacement_events",
			).get() ?? { n: 0 }
		).n;

		const recentRows = db
			.query<EventRow, []>(
				`SELECT * FROM context_replacement_events
				 ORDER BY created_at DESC, rowid DESC
				 LIMIT 50`,
			)
			.all();

		const recent = recentRows.map(rowToEvent);

		return { total, completed, totalSaved, recent };
	}
}
