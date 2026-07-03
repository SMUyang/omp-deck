import { rm } from "node:fs/promises";
import * as path from "node:path";
import type { SessionSummary } from "@omp-deck/protocol";

export async function deleteActiveSessionFile(sessionPath: string | undefined): Promise<void> {
	if (!sessionPath) return;
	const resolved = path.resolve(sessionPath);
	if (!resolved.endsWith(".jsonl")) throw new Error("session path must be a jsonl file");
	await rm(resolved, { force: true });
}

export async function deletePersistedSession(id: string, sessions: readonly SessionSummary[]): Promise<boolean> {
	const session = sessions.find((entry) => entry.id === id);
	if (!session) return false;
	await deleteActiveSessionFile(session.path);
	return true;
}
