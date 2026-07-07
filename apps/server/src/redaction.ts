const REDACTED = "[REDACTED]";

const SECRET_PATTERNS: RegExp[] = [
	// Common API-key shape: sk-..., sk_live_..., sk-proj-...
	/\bsk[-_][A-Za-z0-9][A-Za-z0-9_-]{8,}\b/g,
	// Bearer tokens copied into logs or URLs.
	/\bBearer\s+[A-Za-z0-9._~+\/=:-]{12,}\b/gi,
];

export function redactSensitiveText(value: string): string {
	let out = value;
	for (const pattern of SECRET_PATTERNS) {
		out = out.replace(pattern, REDACTED);
	}
	return out;
}

export function redactedMarker(): string {
	return REDACTED;
}
