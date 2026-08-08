/** Internal extension types — not exported in the public API. */

export interface TopologyContextMessage {
	role: "custom";
	content: string;
	customType: string;
	display: boolean;
}
