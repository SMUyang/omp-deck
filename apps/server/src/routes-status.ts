import { Hono } from "hono";
import type { ProviderUsageLimitWire, ProviderUsageReportWire, ProviderUsageResponse } from "@omp-deck/protocol";

import type { Config } from "./config.ts";
import { logger } from "./log.ts";
import { fetchProviderUsageJson, type ProviderUsageJson } from "./session-status.ts";

const log = logger("routes:status");

type ProviderUsageFetcher = (ompBin: string) => Promise<ProviderUsageJson>;

interface RawUsageReport {
	provider?: unknown;
	fetchedAt?: unknown;
	limits?: unknown;
	notes?: unknown;
}

interface RawUsageLimit {
	label?: unknown;
	status?: unknown;
	window?: unknown;
	amount?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function optionalString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function normalizeLimit(raw: RawUsageLimit): ProviderUsageLimitWire {
	const window = isRecord(raw.window) ? raw.window : undefined;
	const amount = isRecord(raw.amount) ? raw.amount : undefined;
	const limit: ProviderUsageLimitWire = {
		label: optionalString(raw.label) ?? "Usage limit",
	};
	const status = optionalString(raw.status);
	if (status) limit.status = status;
	const windowLabel = optionalString(window?.label);
	if (windowLabel) limit.windowLabel = windowLabel;
	const resetsAt = optionalNumber(window?.resetsAt);
	if (resetsAt !== undefined) limit.resetsAt = resetsAt;
	const unit = optionalString(amount?.unit);
	if (unit) limit.unit = unit;
	const used = optionalNumber(amount?.used);
	if (used !== undefined) limit.used = used;
	const totalLimit = optionalNumber(amount?.limit);
	if (totalLimit !== undefined) limit.limit = totalLimit;
	const remaining = optionalNumber(amount?.remaining);
	if (remaining !== undefined) limit.remaining = remaining;
	const usedFraction = optionalNumber(amount?.usedFraction);
	if (usedFraction !== undefined) limit.usedFraction = usedFraction;
	const remainingFraction = optionalNumber(amount?.remainingFraction);
	if (remainingFraction !== undefined) limit.remainingFraction = remainingFraction;
	return limit;
}

function normalizeReport(raw: RawUsageReport): ProviderUsageReportWire {
	const report: ProviderUsageReportWire = {
		provider: optionalString(raw.provider) ?? "unknown",
		limits: Array.isArray(raw.limits)
			? raw.limits.filter(isRecord).map((limit) => normalizeLimit(limit as RawUsageLimit))
			: [],
	};
	const fetchedAt = optionalNumber(raw.fetchedAt);
	if (fetchedAt !== undefined) report.fetchedAt = fetchedAt;
	if (Array.isArray(raw.notes)) {
		const notes = raw.notes.filter((note): note is string => typeof note === "string" && note.length > 0);
		if (notes.length > 0) report.notes = notes;
	}
	return report;
}

export async function buildProviderUsageResponse(
	ompBin: string,
	fetcher: ProviderUsageFetcher = fetchProviderUsageJson,
): Promise<ProviderUsageResponse> {
	try {
		const raw = await fetcher(ompBin);
		return {
			generatedAt: optionalNumber(raw.generatedAt),
			reports: Array.isArray(raw.reports)
				? raw.reports.filter(isRecord).map((report) => normalizeReport(report as RawUsageReport))
				: [],
		};
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		log.warn("provider usage response failed", err);
		return { reports: [], error: message };
	}
}

export function buildStatusRouter(config: Config): Hono {
	const app = new Hono();
	app.get("/status/provider-usage", async (c) => {
		const body = await buildProviderUsageResponse(config.ompBin);
		return c.json(body);
	});
	return app;
}
