import type {
	MaintenanceGateState,
	PreludeResponse,
	StartCommand,
	TopologyContextInjectionState,
	TopologyRerankConfig,
	UpdateMaintenanceGateRequest,
	UpdatePreludeRequest,
	UpdateStartCommandRequest,
	UpdateTopologyContextInjectionRequest,
	UpdateTopologyRerankConfigRequest,
} from "@omp-deck/protocol";

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

export const orientationApi = {
	getPrelude(): Promise<PreludeResponse> {
		return req<PreludeResponse>("/orientation/prelude");
	},
	putPrelude(body: UpdatePreludeRequest): Promise<PreludeResponse> {
		return req<PreludeResponse>("/orientation/prelude", {
			method: "PUT",
			body: JSON.stringify(body),
		});
	},
	getStartCommand(): Promise<StartCommand> {
		return req<StartCommand>("/orientation/start");
	},
	putStartCommand(body: UpdateStartCommandRequest): Promise<StartCommand> {
		return req<StartCommand>("/orientation/start", {
			method: "PUT",
			body: JSON.stringify(body),
		});
	},
	getMaintenanceGate(): Promise<MaintenanceGateState> {
		return req<MaintenanceGateState>("/orientation/maintenance-gate");
	},
	putMaintenanceGate(body: UpdateMaintenanceGateRequest): Promise<MaintenanceGateState> {
		return req<MaintenanceGateState>("/orientation/maintenance-gate", {
			method: "PUT",
			body: JSON.stringify(body),
		});
	},
	getTopologyContextInjection(): Promise<TopologyContextInjectionState> {
		return req<TopologyContextInjectionState>("/orientation/topology-context-injection");
	},
	putTopologyContextInjection(body: UpdateTopologyContextInjectionRequest): Promise<TopologyContextInjectionState> {
		return req<TopologyContextInjectionState>("/orientation/topology-context-injection", {
			method: "PUT",
			body: JSON.stringify(body),
		});
	},
	getTopologyRerankConfig(): Promise<TopologyRerankConfig> {
		return req<TopologyRerankConfig>("/orientation/topology-rerank");
	},
	putTopologyRerankConfig(body: UpdateTopologyRerankConfigRequest): Promise<TopologyRerankConfig> {
		return req<TopologyRerankConfig>("/orientation/topology-rerank", {
			method: "PUT",
			body: JSON.stringify(body),
		});
	},
};
