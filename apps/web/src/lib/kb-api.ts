import type { KbFileResponse, KbTreeResponse } from "@omp-deck/protocol";

const BASE = "/api";

async function req<T>(path: string, init?: RequestInit): Promise<T> {
	const res = await fetch(`${BASE}${path}`, {
		...init,
		headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
	});
	if (!res.ok) {
		const body = await res.text().catch(() => "");
		throw new Error(`HTTP ${res.status} ${path}: ${body}`);
	}
	return (await res.json()) as T;
}

function qs(params: Record<string, string | undefined>): string {
	const parts: string[] = [];
	for (const [k, v] of Object.entries(params)) {
		if (v === undefined || v === "") continue;
		parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(v)}`);
	}
	return parts.length > 0 ? `?${parts.join("&")}` : "";
}

export const kbApi = {
	tree(path?: string): Promise<KbTreeResponse> {
		return req<KbTreeResponse>(`/kb/tree${qs({ path })}`);
	},
	file(path: string): Promise<KbFileResponse> {
		return req<KbFileResponse>(`/kb/file${qs({ path })}`);
	},
	put(path: string, content: string): Promise<KbFileResponse> {
		return req<KbFileResponse>(`/kb/file${qs({ path })}`, {
			method: "PUT",
			body: JSON.stringify({ content }),
		});
	},
	create(path: string, content: string): Promise<KbFileResponse> {
		return req<KbFileResponse>(`/kb/file${qs({ path })}`, {
			method: "POST",
			body: JSON.stringify({ content }),
		});
	},
};
