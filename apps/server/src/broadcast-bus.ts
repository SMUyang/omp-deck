import type { ServerFrame } from "@omp-deck/protocol";

/**
 * Singleton fan-out for non-session-scoped events the deck wants every
 * connected WebSocket client to see. Producers (route handlers, deck slash
 * dispatcher) call `broadcast(frame)`; the WS hub subscribes once and relays
 * to every open connection.
 *
 * This decouples mutation sites from transport — `routes-tasks.ts` does not
 * import the hub, and the hub does not import every route module.
 */
export type BroadcastFrame = Extract<
	ServerFrame,
	| { type: "tasks_changed" }
	| { type: "skills_changed" }
	| { type: "oauth_consent" }
	| { type: "oauth_progress" }
	| { type: "oauth_prompt" }
	| { type: "oauth_complete" }
	| { type: "oauth_failed" }
	| { type: "models_changed" }
>;

type Listener = (frame: BroadcastFrame) => void;

class BroadcastBus {
	private listeners = new Set<Listener>();

	broadcast(frame: BroadcastFrame): void {
		for (const l of this.listeners) {
			try {
				l(frame);
			} catch {
				// One bad listener must not block the others.
			}
		}
	}

	subscribe(listener: Listener): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}
}

export const broadcastBus = new BroadcastBus();
