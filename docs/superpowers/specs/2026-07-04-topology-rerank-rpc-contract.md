# Topology Rerank RPC Contract

## Purpose

`omp-deck` has an injected `TopologyRerankModelClient` seam for Session Context Topology Phase 2, but no confirmed OMP RPC command currently invokes a model role headlessly. This contract defines the minimum command shape needed before deck can wire a production RPC-backed reranker.

## Observed RPC command surface

Grounded command names currently used by deck:

- `set_subagent_subscription`
- `get_state`
- `get_messages`
- `prompt`
- `compact`
- `set_model`
- `get_available_models`

No observed command currently provides one-shot model-role invocation or JSON-schema-constrained rerank output.

## Required command semantics

The command must:

1. Invoke a configured model role without mutating the active chat transcript.
2. Accept a sanitized `TopologyRerankRequest` object.
3. Return either a direct strict `RerankPatch` JSON object or an RPC envelope whose `output` field is a strict `RerankPatch` JSON object.
4. Enforce a timeout at the deck caller or OMP RPC layer.
5. Preserve prompt safety: failed calls must be distinguishable from valid empty patches so deck can fall back to local retrieval.

## Proposed request envelope

```json
{
  "type": "invoke_model_role",
  "modelRole": "topology_query_reranker",
  "input": {
    "task": "query_rerank",
    "query": "current user prompt",
    "candidateNodes": [
      { "id": "node-id", "kind": "goal", "title": "...", "body": "..." }
    ],
    "candidateEdges": [
      { "id": "edge-id", "sourceNodeId": "a", "relation": "depends_on", "targetNodeId": "b" }
    ],
    "budget": { "nodeLimit": 10, "edgeLimit": 18 }
  },
  "responseFormat": {
    "type": "json_object",
    "schemaName": "TopologyRerankPatch"
  }
}
```

## Expected response

Preferred response body: a direct `RerankPatch` JSON object.

```json
{
  "keepNodeIds": ["node-id"],
  "keepEdgeIds": ["edge-id"],
  "demoteNodeIds": ["other-node-id"],
  "reason": "brief optional rationale"
}
```

Deck also accepts the same patch wrapped under `output` to tolerate RPC envelopes that separate transport metadata from model output:

```json
{
  "output": {
    "keepNodeIds": ["node-id"],
    "keepEdgeIds": ["edge-id"],
    "demoteNodeIds": ["other-node-id"],
    "reason": "brief optional rationale"
  }
}
```

Any other response shape is treated as invalid and falls back to local retrieval.

## Deck-side safety invariants

Deck must parse every RPC response with `parseTopologyRerankRpcResponse()` first. That adapter accepts the documented direct or `output`-wrapped response envelope, delegates the extracted candidate patch to shape-only `parseRerankPatch()`, and rejects malformed fields.

Before any patch affects final focus, the production caller must still run graph-local `validateRerankPatch()` to enforce selected-node/selected-edge membership, candidate-only promotion rejection, demotion behavior, and output budget constraints.

A real RPC client must not:
- promote candidate-only nodes into final focus;
- include scores, reasons, confidence, or reranker metadata in compact focus;
- abort the user prompt when rerank fails;
- mutate model roles or active session state.

## Open confirmation item

The command name `invoke_model_role` is provisional. OMP RPC must either implement this exact command or document the supported equivalent before deck wires production calls.
