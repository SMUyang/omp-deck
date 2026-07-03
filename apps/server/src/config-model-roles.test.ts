import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ModelInfo } from "@omp-deck/protocol";

import { createConfigModelRolesStore } from "./config-model-roles.ts";

const tempDirs: string[] = [];

async function makeAgentDir(configYaml: string): Promise<string> {
	const dir = await mkdtemp(path.join(os.tmpdir(), "omp-deck-config-roles-"));
	tempDirs.push(dir);
	await writeFile(path.join(dir, "config.yml"), configYaml, "utf-8");
	return dir;
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const MODELS: ModelInfo[] = [
	{ provider: "anthropic", id: "claude-3-5-sonnet", label: "Claude 3.5 Sonnet", isAvailable: true },
	{ provider: "zai", id: "glm-5.2:xhigh", label: "GLM 5.2", isAvailable: true },
];

describe("config-backed model roles store", () => {
	test("reads modelRoles from OMP config.yml and returns available models", async () => {
		const agentDir = await makeAgentDir(`defaultProvider: haochi\nmodelRoles:\n  advisor: anthropic/claude-3-5-sonnet:high\n`);
		const store = createConfigModelRolesStore({ agentDir, listModels: async () => MODELS });

		const snapshot = await store.get();

		expect(snapshot.roles).toEqual({ advisor: "anthropic/claude-3-5-sonnet:high" });
		expect(snapshot.models).toEqual(MODELS);
	});

	test("patch persists modelRoles while preserving unrelated OMP config keys", async () => {
		const agentDir = await makeAgentDir(`defaultProvider: haochi\nquietStartup: false\nmodelRoles:\n  advisor: anthropic/claude-3-5-sonnet:high\n`);
		const store = createConfigModelRolesStore({ agentDir, listModels: async () => MODELS });

		await store.patch({ roles: { advisor: null, task: "zai/glm-5.2:xhigh" } });

		const raw = await readFile(path.join(agentDir, "config.yml"), "utf-8");
		expect(raw).toContain("defaultProvider");
		expect(raw).toContain("quietStartup");
		expect(raw).toContain("task");
		expect(raw).toContain("zai/glm-5.2:xhigh");
		expect(raw).not.toContain("advisor");
	});

	test("accepts thinking suffix when available models expose the base model id", async () => {
		const agentDir = await makeAgentDir(`modelRoles: {}\n`);
		const store = createConfigModelRolesStore({ agentDir, listModels: async () => MODELS });

		const snapshot = await store.patch({ roles: { advisor: "anthropic/claude-3-5-sonnet:high" } });

		expect(snapshot.roles.advisor).toBe("anthropic/claude-3-5-sonnet:high");
	});

	test("accepts thinking suffix when available models expose the suffixed model id", async () => {
		const agentDir = await makeAgentDir(`modelRoles: {}\n`);
		const store = createConfigModelRolesStore({ agentDir, listModels: async () => MODELS });

		const snapshot = await store.patch({ roles: { task: "zai/glm-5.2:xhigh" } });

		expect(snapshot.roles.task).toBe("zai/glm-5.2:xhigh");
	});

	test("rejects unknown provider/model pairs before writing", async () => {
		const agentDir = await makeAgentDir(`modelRoles:\n  advisor: anthropic/claude-3-5-sonnet:high\n`);
		const store = createConfigModelRolesStore({ agentDir, listModels: async () => MODELS });

		await expect(store.patch({ roles: { advisor: "missing/model:high" } })).rejects.toThrow(
			"unknown model for role advisor: missing/model:high",
		);

		const raw = await readFile(path.join(agentDir, "config.yml"), "utf-8");
		expect(raw).toContain("anthropic/claude-3-5-sonnet:high");
		expect(raw).not.toContain("missing/model");
	});
});
