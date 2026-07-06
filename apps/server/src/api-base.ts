export function normalizeDeckApiOrigin(raw: string): string {
	const url = new URL(raw.trim());
	url.pathname = "";
	url.search = "";
	url.hash = "";
	return url.toString().replace(/\/$/, "");
}

export function isLoopbackApiOrigin(raw: string): boolean {
	try {
		const url = new URL(normalizeDeckApiOrigin(raw));
		const hostname = url.hostname.replace(/^\[|\]$/g, "");
		return url.protocol === "http:" && ["127.0.0.1", "localhost", "::1"].includes(hostname);
	} catch {
		return false;
	}
}
