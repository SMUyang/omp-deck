import { unlink } from "node:fs/promises";
import * as path from "node:path";
import type { SessionSummary } from "@omp-deck/protocol";

export async function deletePersistedSession(id: string, sessions: readonly SessionSummary[]): Promise<boolean> {
	const session = sessions.find((entry) => entry.id === id);
	if (!session) return false;
	const resolved = path.resolve(session.path);
	if (!resolved.endsWith(".jsonl")) throw new Error("session path must be a jsonl file");
	await unlink(resolved);
	return true;
}
