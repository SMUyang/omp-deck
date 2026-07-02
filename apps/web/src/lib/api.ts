import type {
	BrowseDirectoryResponse,
	CreateSessionRequest,
	CreateSessionResponse,
	CreateWorkspaceRequest,
	CreateWorkspaceResponse,
	DeleteWorkspaceResponse,
	ListFilePathsResponse,
	ListModelsResponse,
	ListSessionsResponse,
	ListSlashCommandsResponse,
	ListWorkspacesResponse,
	MemoryGraphResponse,
	MemorySearchResponse,
	MemoryStatusResponse,
	ModelRef,
	CpaUsageResponse,
	ProviderUsageResponse,
	UpdateRunResponse,
} from "@omp-deck/protocol";

const BASE = "/api";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
	const res = await fetch(`${BASE}${path}`, {
		...init,
		headers: {
			"content-type": "application/json",
			...(init?.headers ?? {}),
		},
	});
	if (!res.ok) {
		let body: string;
		try {
			body = await res.text();
		} catch {
			body = "(unreadable body)";
		}
		throw new Error(`HTTP ${res.status} ${path}: ${body}`);
	}
	return (await res.json()) as T;
}

export const api = {
	listWorkspaces(): Promise<ListWorkspacesResponse> {
		return request<ListWorkspacesResponse>("/workspaces");
	},
	createWorkspace(body: CreateWorkspaceRequest): Promise<CreateWorkspaceResponse> {
		return request<CreateWorkspaceResponse>("/workspaces", { method: "POST", body: JSON.stringify(body) });
	},
	deleteWorkspace(id: string): Promise<DeleteWorkspaceResponse> {
		return request<DeleteWorkspaceResponse>(`/workspaces/${encodeURIComponent(id)}`, { method: "DELETE" });
	},
	browseDirectory(cwd: string, showHidden = false): Promise<BrowseDirectoryResponse> {
		const params = new URLSearchParams({ cwd });
		if (showHidden) params.set("showHidden", "1");
		return request<BrowseDirectoryResponse>(`/fs/browse?${params.toString()}`);
	},
	listSessions(cwd?: string): Promise<ListSessionsResponse> {
		const q = cwd ? `?cwd=${encodeURIComponent(cwd)}` : "";
		return request<ListSessionsResponse>(`/sessions${q}`);
	},
	createSession(body: CreateSessionRequest): Promise<CreateSessionResponse> {
		return request<CreateSessionResponse>("/sessions", {
			method: "POST",
			body: JSON.stringify(body),
		});
	},
	abortSession(id: string): Promise<{ ok: true }> {
		return request(`/sessions/${encodeURIComponent(id)}/abort`, { method: "POST" });
	},
	renameSession(id: string, name: string): Promise<{ ok: true; sessionId: string }> {
		return request(`/sessions/${encodeURIComponent(id)}`, {
			method: "PATCH",
			body: JSON.stringify({ name }),
		});
	},
	listModels(sessionId?: string): Promise<ListModelsResponse> {
		const q = sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : "";
		return request<ListModelsResponse>(`/models${q}`);
	},
	setSessionModel(id: string, model: ModelRef): Promise<{ ok: true; sessionId: string }> {
		return request(`/sessions/${encodeURIComponent(id)}`, {
			method: "PATCH",
			body: JSON.stringify({ model }),
		});
	},
	compactSession(id: string, focus?: string): Promise<{ ok: true }> {
		const body = focus && focus.trim().length > 0 ? JSON.stringify({ focus: focus.trim() }) : "";
		const init: RequestInit = { method: "POST" };
		if (body) {
			init.body = body;
			init.headers = { "content-type": "application/json" };
		}
		return request(`/sessions/${encodeURIComponent(id)}/compact`, init);
	},
	disposeSession(id: string): Promise<{ ok: true }> {
		return request(`/sessions/${encodeURIComponent(id)}`, { method: "DELETE" });
	},
	listSlashCommands(cwd?: string): Promise<ListSlashCommandsResponse> {
		const q = cwd ? `?cwd=${encodeURIComponent(cwd)}` : "";
		return request<ListSlashCommandsResponse>(`/slash-commands${q}`);
	},
	completeFilePath(cwd: string, q: string, limit = 20): Promise<ListFilePathsResponse> {
		const params = new URLSearchParams({ cwd, q, limit: String(limit) });
		return request<ListFilePathsResponse>(`/fs/complete?${params.toString()}`);
	},
	getProviderUsage(): Promise<ProviderUsageResponse> {
		return request<ProviderUsageResponse>("/status/provider-usage");
	},
	getCpaUsage(): Promise<CpaUsageResponse> {
		return request<CpaUsageResponse>("/status/cpa-usage");
	},
	getMemoryStatus(): Promise<MemoryStatusResponse> {
		return request<MemoryStatusResponse>("/memory/status");
	},
	searchMemories(q: string): Promise<MemorySearchResponse> {
		return request<MemorySearchResponse>(`/memory/search?q=${encodeURIComponent(q)}`);
	},
	getMemoryGraph(params: { bank?: string | null; q?: string; limit?: number } = {}): Promise<MemoryGraphResponse> {
		const search = new URLSearchParams();
		if (params.bank) search.set("bank", params.bank);
		if (params.q) search.set("q", params.q);
		if (params.limit) search.set("limit", String(params.limit));
		const suffix = search.toString();
		return request<MemoryGraphResponse>(`/memory/graph${suffix ? `?${suffix}` : ""}`);
	},
	runUpdate(): Promise<UpdateRunResponse> {
		return request<UpdateRunResponse>("/update", { method: "POST" });
	},
};
