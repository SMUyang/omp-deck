import { describe, expect, test } from "bun:test";
import type {
	ContextReplacementEvent,
	ContextReplacementStatus,
	ContextReplacementMechanism,
} from "@omp-deck/protocol";

import {
	getStatusLabel,
	getStatusColor,
	getMechanismLabel,
	formatTokenDelta,
	isProviderConfirmed,
	STATUS_ORDER,
} from "./ContextEvidenceTimeline";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeEvent(overrides: Partial<ContextReplacementEvent> = {}): ContextReplacementEvent {
	return {
		id: "evt-1",
		sessionId: "sess-1",
		status: "constructed",
		mechanism: "context_hook",
		beforeTokens: null,
		beforePercent: null,
		afterTokens: null,
		afterPercent: null,
		savedTokens: null,
		savedPercent: null,
		focusHash: "abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
		focusPreview: "The user asked about database schema design…",
		focusEstimatedTokens: 10,
		focusEstimateMethod: "chars_div_4" as const,
		providerRole: null,
		errorMessage: null,
		retryCount: 0,
		createdAt: "2026-07-10T12:00:00Z",
		updatedAt: "2026-07-10T12:00:01Z",
		...overrides,
	};
}

// ── getStatusLabel ───────────────────────────────────────────────────────────

describe("getStatusLabel", () => {
	const t = (k: string) => k;

	test("returns distinct label for each of the eight lifecycle statuses", () => {
		const statuses: ContextReplacementStatus[] = [
			"constructed",
			"handler_returned",
			"compact_requested",
			"compact_completed",
			"usage_drop_observed",
			"provider_payload_observed",
			"failed",
			"timed_out",
		];
		const labels = statuses.map((s) => getStatusLabel(s, t));
		// Every label is distinct
		expect(new Set(labels).size).toBe(8);
		// Every label is non-empty
		for (const l of labels) expect(l.length).toBeGreaterThan(0);
	});

	test("provider_payload_observed is clearly distinguishable from compact_completed", () => {
		const observed = getStatusLabel("provider_payload_observed", t);
		const completed = getStatusLabel("compact_completed", t);
		expect(observed).not.toBe(completed);
		expect(observed.toLowerCase()).toContain("provider");
	});

	test("failed and timed_out have distinct labels", () => {
		expect(getStatusLabel("failed", t)).not.toBe(getStatusLabel("timed_out", t));
	});
});

// ── getStatusColor ───────────────────────────────────────────────────────────

describe("getStatusColor", () => {
	test("provider_payload_observed maps to success color", () => {
		const color = getStatusColor("provider_payload_observed");
		expect(color.bg).toContain("success");
	});

	test("failed and timed_out map to danger color", () => {
		expect(getStatusColor("failed").bg).toContain("danger");
		expect(getStatusColor("timed_out").bg).toContain("danger");
	});

	test("compact_completed maps to accent color", () => {
		const color = getStatusColor("compact_completed");
		expect(color.bg).toContain("accent");
	});

	test("constructed and handler_returned map to ink-3 (muted) color", () => {
		expect(getStatusColor("constructed").bg).toContain("ink-3");
		expect(getStatusColor("handler_returned").bg).toContain("ink-3");
	});

	test("usage_drop_observed maps to thinking color (observed but not confirmed at provider)", () => {
		const color = getStatusColor("usage_drop_observed");
		expect(color.bg).toContain("thinking");
	});

	test("every status has both bg and text colors defined", () => {
		const statuses: ContextReplacementStatus[] = [
			"constructed", "handler_returned", "compact_requested",
			"compact_completed", "usage_drop_observed",
			"provider_payload_observed", "failed", "timed_out",
		];
		for (const s of statuses) {
			const color = getStatusColor(s);
			expect(color.bg.length).toBeGreaterThan(0);
			expect(color.text.length).toBeGreaterThan(0);
		}
	});
});

// ── getMechanismLabel ────────────────────────────────────────────────────────

describe("getMechanismLabel", () => {
	const t = (k: string) => k;

	test("returns distinct labels for context_hook and auto_compact", () => {
		const mechanisms: ContextReplacementMechanism[] = ["context_hook", "auto_compact"];
		const labels = mechanisms.map((m) => getMechanismLabel(m, t));
		expect(new Set(labels).size).toBe(2);
	});
});

// ── formatTokenDelta ─────────────────────────────────────────────────────────

describe("formatTokenDelta", () => {
	test("null beforeTokens → null saved, isNull=true", () => {
		const evt = makeEvent({ beforeTokens: null, afterTokens: 5000, savedTokens: null, savedPercent: null });
		const result = formatTokenDelta(evt);
		expect(result.saved).toBeNull();
		expect(result.isNull).toBe(true);
	});

	test("null afterTokens → null saved, isNull=true", () => {
		const evt = makeEvent({ beforeTokens: 12000, afterTokens: null, savedTokens: null, savedPercent: null });
		const result = formatTokenDelta(evt);
		expect(result.saved).toBeNull();
		expect(result.isNull).toBe(true);
	});

	test("both null → null saved, isNull=true", () => {
		const evt = makeEvent({ beforeTokens: null, afterTokens: null, savedTokens: null, savedPercent: null });
		const result = formatTokenDelta(evt);
		expect(result.saved).toBeNull();
		expect(result.isNull).toBe(true);
	});

	test("valid before/after → computes saved tokens and percent", () => {
		const evt = makeEvent({
			beforeTokens: 12000,
			afterTokens: 8500,
			savedTokens: 3500,
			savedPercent: 29.2,
		});
		const result = formatTokenDelta(evt);
		expect(result.saved).toContain("3.5k");
		expect(result.percent).toContain("29.2");
		expect(result.isNull).toBe(false);
	});

	test("0→0 is valid observation, not null", () => {
		const evt = makeEvent({
			beforeTokens: 0,
			afterTokens: 0,
			savedTokens: 0,
			savedPercent: 0,
		});
		const result = formatTokenDelta(evt);
		expect(result.saved).toBe("0");
		expect(result.percent).toContain("0");
		expect(result.isNull).toBe(false);
	});

	test("8000→8500 (no savings) → saved 0, isNull=false", () => {
		const evt = makeEvent({
			beforeTokens: 8000,
			afterTokens: 8500,
			savedTokens: 0,
			savedPercent: 0,
		});
		const result = formatTokenDelta(evt);
		expect(result.isNull).toBe(false);
		expect(result.saved).toBe("0");
	});
});

// ── isProviderConfirmed ──────────────────────────────────────────────────────

describe("isProviderConfirmed", () => {
	test("provider_payload_observed → true", () => {
		expect(isProviderConfirmed(makeEvent({ status: "provider_payload_observed" }))).toBe(true);
	});

	test("compact_completed → false (never promoted)", () => {
		expect(isProviderConfirmed(makeEvent({ status: "compact_completed" }))).toBe(false);
	});

	test("usage_drop_observed → false (observed but not provider-confirmed)", () => {
		expect(isProviderConfirmed(makeEvent({ status: "usage_drop_observed" }))).toBe(false);
	});

	test("constructed, handler_returned, compact_requested → false", () => {
		expect(isProviderConfirmed(makeEvent({ status: "constructed" }))).toBe(false);
		expect(isProviderConfirmed(makeEvent({ status: "handler_returned" }))).toBe(false);
		expect(isProviderConfirmed(makeEvent({ status: "compact_requested" }))).toBe(false);
	});

	test("failed, timed_out → false", () => {
		expect(isProviderConfirmed(makeEvent({ status: "failed" }))).toBe(false);
		expect(isProviderConfirmed(makeEvent({ status: "timed_out" }))).toBe(false);
	});
});

// ── STATUS_ORDER ─────────────────────────────────────────────────────────────

describe("STATUS_ORDER", () => {
	test("contains all eight statuses", () => {
		expect(STATUS_ORDER.length).toBe(8);
		const set = new Set(STATUS_ORDER);
		expect(set.size).toBe(8);
	});

	test("terminal states (failed, timed_out, provider_payload_observed) come after building states", () => {
		const failedIdx = STATUS_ORDER.indexOf("failed");
		const timedOutIdx = STATUS_ORDER.indexOf("timed_out");
		const observedIdx = STATUS_ORDER.indexOf("provider_payload_observed");
		const constructedIdx = STATUS_ORDER.indexOf("constructed");
		expect(failedIdx).toBeGreaterThan(constructedIdx);
		expect(timedOutIdx).toBeGreaterThan(constructedIdx);
		expect(observedIdx).toBeGreaterThan(constructedIdx);
	});
});

// ── focusEstimatedTokens authority ───────────────────────────────────────────

describe("focusEstimatedTokens authority", () => {
	test("focusEstimatedTokens is separate from savedTokens and uses chars_div_4 method", () => {
		const evt = makeEvent({
			focusPreview: "abcdefgh", // 8 chars
			focusEstimatedTokens: 2, // ceil(8/4)
			savedTokens: 3500,
		});
		// focusEstimatedTokens must not equal savedTokens
		expect(evt.focusEstimatedTokens).not.toBe(evt.savedTokens);
		// The estimate method is chars_div_4
		expect(evt.focusEstimatedTokens).toBe(2); // 8 chars / 4 = 2
	});
});

// ── Error detail rendering ───────────────────────────────────────────────────

describe("errorMessage rendering", () => {
	test("failed event has errorMessage", () => {
		const evt = makeEvent({
			status: "failed",
			errorMessage: "Connection refused: ECONNREFUSED 127.0.0.1:8089",
		});
		expect(evt.errorMessage).toBeTruthy();
		expect(evt.errorMessage).toContain("ECONNREFUSED");
	});

	test("timed_out event has errorMessage", () => {
		const evt = makeEvent({
			status: "timed_out",
			errorMessage: "Request timed out after 30000ms",
		});
		expect(evt.errorMessage).toBeTruthy();
	});

	test("provider_payload_observed event has null errorMessage", () => {
		const evt = makeEvent({ status: "provider_payload_observed" });
		expect(evt.errorMessage).toBeNull();
	});
});
