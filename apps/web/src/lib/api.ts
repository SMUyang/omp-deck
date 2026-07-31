import type {
	BrowseDirectoryResponse,
	ContextEvidenceStats,
	ContextReplacementEvent,
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
	SessionContextFocusResponse,
	SessionContextGraphResponse,
	SessionContextPackResponse,
	SessionContextStatusResponse,
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
	createDirectory(cwd: string, name: string): Promise<{ ok: boolean; path: string }> {
		return request("/fs/mkdir", { method: "POST", body: JSON.stringify({ cwd, name }) });
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
	setSessionThinkingLevel(id: string, level: string): Promise<{ ok: true; sessionId: string }> {
		return request(`/sessions/${encodeURIComponent(id)}`, {
			method: "PATCH",
			body: JSON.stringify({ thinkingLevel: level }),
		});
	},
	cycleSessionThinkingLevel(id: string): Promise<{ ok: true; sessionId: string }> {
		return request(`/sessions/${encodeURIComponent(id)}/cycle-thinking`, { method: "POST" });
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
	getCpaConfig(): Promise<{
		config: {
			proxy?: { endpoint: string; hasKey: boolean; providerPrefix?: string };
			builtinProviders?: Record<string, { enabled: boolean; apiOverride?: string; models?: string[] }>;
			customProviders?: Record<string, { api: string; models: Array<{ id: string; name?: string; contextWindow?: number; maxTokens?: number; reasoning?: boolean }> }>;
		} | null;
		path: string;
		exists: boolean;
	}> {
		return request("/cpa/config");
	},
	updateCpaConfig(body: {
		proxy?: { endpoint?: string; apiKey?: string; providerPrefix?: string };
		customProviders?: Record<string, { api: string; models: Array<{ id: string; name?: string; contextWindow?: number; maxTokens?: number }> }>;
	}): Promise<{ ok: boolean; error?: string }> {
		return request("/cpa/config", { method: "PUT", body: JSON.stringify(body) });
	},
	testCpaConnection(body: { endpoint?: string; apiKey?: string }): Promise<{ ok: boolean; modelCount?: number; models?: string[]; error?: string }> {
		return request("/cpa/test", { method: "POST", body: JSON.stringify(body) });
	},
	clearCpaCache(): Promise<{ ok: boolean; existed: boolean }> {
		return request("/cpa/clear-cache", { method: "POST" });
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
	rebuildSessionContext(id: string): Promise<SessionContextStatusResponse> {
		return (async () => {
			await request<unknown>(`/sessions/${encodeURIComponent(id)}/context/rebuild`, { method: "POST" });
			// Async rebuild (202): poll until done
			const deadline = Date.now() + 10 * 60_000;
			while (Date.now() < deadline) {
				const status = await request<SessionContextStatusResponse>(`/sessions/${encodeURIComponent(id)}/context-status`);
				if (status.built && !status.rebuilding) return status;
				await new Promise((r) => setTimeout(r, 2000));
			}
			throw new Error("rebuild timed out after 10 minutes");
		})();
	},
	getSessionContextStatus(id: string): Promise<SessionContextStatusResponse> {
		return request<SessionContextStatusResponse>(`/sessions/${encodeURIComponent(id)}/context-status`);
	},
	getSessionContextPack(id: string, params: { q?: string; budget?: number } = {}): Promise<SessionContextPackResponse> {
		const search = new URLSearchParams();
		if (params.q) search.set("q", params.q);
		if (params.budget) search.set("budget", String(params.budget));
		const qs = search.toString();
		return request<SessionContextPackResponse>(`/sessions/${encodeURIComponent(id)}/context-pack${qs ? `?${qs}` : ""}`);
	},
	getSessionContextGraph(id: string, limit = 200): Promise<SessionContextGraphResponse> {
		return request<SessionContextGraphResponse>(`/sessions/${encodeURIComponent(id)}/context-graph?limit=${encodeURIComponent(String(limit))}`);
	},
	getSessionContextFocus(
		id: string,
		params: { q?: string; contextPercent?: number } = {},
	): Promise<SessionContextFocusResponse> {
		const search = new URLSearchParams();
		if (params.q) search.set("q", params.q);
		if (params.contextPercent !== undefined) search.set("contextPercent", String(params.contextPercent));
		const qs = search.toString();
		return request<SessionContextFocusResponse>(`/sessions/${encodeURIComponent(id)}/context-focus${qs ? `?${qs}` : ""}`);
	},
	getSessionContextUsage(id: string): Promise<{ sessionId: string; tokens?: number; percent?: number; contextWindow?: number }> {
		return request(`/sessions/${encodeURIComponent(id)}/context-usage`);
	},
	getContextEvidence(id: string): Promise<ContextReplacementEvent[]> {
		return request<{ events: ContextReplacementEvent[] }>(`/sessions/${encodeURIComponent(id)}/context-evidence`).then((r) => r.events);
	},
	getContextEvidenceStats(): Promise<ContextEvidenceStats> {
		return request<ContextEvidenceStats>("/stats/context-savings");
	},
	listCustomProviders(): Promise<{ providers: Array<{ name: string; baseUrl: string; api: string; modelCount: number; hasKey: boolean }>; path: string }> {
		return request("/providers/custom");
	},
	upsertCustomProvider(body: { name: string; baseUrl: string; api?: string; apiKey?: string; auth?: "apiKey" | "none"; models: Array<{ id: string; name?: string; contextWindow?: number; maxTokens?: number }>; compat?: { supportsDeveloperRole?: boolean; supportsReasoningEffort?: boolean } }): Promise<{ ok: boolean; name: string; reloadRequired?: boolean }> {
		return request("/providers/custom", { method: "POST", body: JSON.stringify(body) });
	},
	deleteCustomProvider(name: string): Promise<{ ok: boolean; reloadRequired?: boolean }> {
		return request(`/providers/custom/${encodeURIComponent(name)}`, { method: "DELETE" });
	},
};
