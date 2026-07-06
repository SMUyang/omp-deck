import type { RerankPatch, TopologyRerankRequest } from "./topology-reranker.ts";
import { parseRerankPatch } from "./topology-reranker.ts";

export interface TopologyRerankRpcCommand {
	type: "invoke_model_role";
	modelRole: string;
	input: TopologyRerankRequest;
	responseFormat: { type: "json_object"; schemaName: "TopologyRerankPatch" };
}

export function buildTopologyRerankRpcCommand(input: {
	modelRole: string;
	request: TopologyRerankRequest;
}): TopologyRerankRpcCommand {
	return {
		type: "invoke_model_role",
		modelRole: input.modelRole,
		input: input.request,
		responseFormat: { type: "json_object", schemaName: "TopologyRerankPatch" },
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseTopologyRerankRpcResponse(raw: unknown): RerankPatch | undefined {
	const direct = parseRerankPatch(raw);
	if (direct) return direct;
	if (!isRecord(raw)) return undefined;
	return parseRerankPatch(raw.output);
}
