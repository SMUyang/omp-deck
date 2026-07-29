import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { stringify as stringifyYaml } from "yaml";

import {
	deleteCustomProvider,
	listCustomProviders,
	readModelsYml,
	upsertCustomProvider,
	type CustomProvider,
} from "./models-store.ts";

function tmpDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "models-test-"));
}

function ymlPath(dir: string): string {
	return path.join(dir, "models.yml");
}

function jsonPath(dir: string): string {
	return path.join(dir, "models.json");
}

const sampleProvider: CustomProvider = {
	baseUrl: "https://api.example.com/v1",
	api: "openai-completions",
	apiKey: "sk-test",
	models: [{ id: "test-model", name: "Test Model", contextWindow: 128000, maxTokens: 4096 }],
};

describe("models-store", () => {
	test("readModelsYml returns empty when neither yml nor json exists", () => {
		const dir = tmpDir();
		const { providers } = readModelsYml(ymlPath(dir));
		expect(providers).toEqual({});
		fs.rmSync(dir, { recursive: true });
	});

	test("readModelsYml reads yml when it exists", () => {
		const dir = tmpDir();
		fs.writeFileSync(ymlPath(dir), stringifyYaml({
			providers: { alpha: { baseUrl: "https://a.com", api: "openai-completions", apiKey: "k", models: [] } },
		}));
		const { providers } = readModelsYml(ymlPath(dir));
		expect(Object.keys(providers)).toEqual(["alpha"]);
		fs.rmSync(dir, { recursive: true });
	});

	test("readModelsYml migrates from legacy json when yml is absent", () => {
		const dir = tmpDir();
		fs.writeFileSync(jsonPath(dir), JSON.stringify({
			providers: { legacy: { baseUrl: "https://legacy.com", api: "openai-completions", apiKey: "old", models: [{ id: "m1" }] } },
		}));
		const { providers } = readModelsYml(ymlPath(dir));
		expect(Object.keys(providers)).toEqual(["legacy"]);
		expect(providers.legacy!.apiKey).toBe("old");
		fs.rmSync(dir, { recursive: true });
	});

	test("readModelsYml prefers yml over json when both exist", () => {
		const dir = tmpDir();
		fs.writeFileSync(ymlPath(dir), stringifyYaml({
			providers: { fromYml: { baseUrl: "https://yml.com", api: "openai-completions", apiKey: "y", models: [] } },
		}));
		fs.writeFileSync(jsonPath(dir), JSON.stringify({
			providers: { fromJson: { baseUrl: "https://json.com", api: "openai-completions", apiKey: "j", models: [] } },
		}));
		const { providers } = readModelsYml(ymlPath(dir));
		expect(Object.keys(providers)).toEqual(["fromYml"]);
		fs.rmSync(dir, { recursive: true });
	});

	test("readModelsYml throws when providers is an array", () => {
		const dir = tmpDir();
		fs.writeFileSync(ymlPath(dir), stringifyYaml({ providers: ["not", "a", "map"] }));
		expect(() => readModelsYml(ymlPath(dir))).toThrow(/must be a mapping/);
		fs.rmSync(dir, { recursive: true });
	});

	test("upsert preserves unknown top-level fields", () => {
		const dir = tmpDir();
		fs.writeFileSync(ymlPath(dir), stringifyYaml({ version: 2, someFlag: true, providers: {} }));
		upsertCustomProvider("myprov", sampleProvider, ymlPath(dir));
		const { doc } = readModelsYml(ymlPath(dir));
		expect(doc.version).toBe(2);
		expect(doc.someFlag).toBe(true);
		fs.rmSync(dir, { recursive: true });
	});

	test("upsert preserves existing providers", () => {
		const dir = tmpDir();
		fs.writeFileSync(ymlPath(dir), stringifyYaml({
			providers: {
				existing: { baseUrl: "https://old.com", api: "openai-completions", apiKey: "sk-old", models: [] },
			},
		}));
		upsertCustomProvider("newprov", sampleProvider, ymlPath(dir));
		const { providers } = readModelsYml(ymlPath(dir));
		expect(Object.keys(providers).sort()).toEqual(["existing", "newprov"]);
		expect(providers.existing!.apiKey).toBe("sk-old");
		fs.rmSync(dir, { recursive: true });
	});

	test("upsert overwrites same-name provider", () => {
		const dir = tmpDir();
		fs.writeFileSync(ymlPath(dir), stringifyYaml({
			providers: {
				dup: { baseUrl: "https://old.com", api: "openai-completions", apiKey: "sk-old", models: [] },
			},
		}));
		upsertCustomProvider("dup", sampleProvider, ymlPath(dir));
		const { providers } = readModelsYml(ymlPath(dir));
		expect(providers.dup!.apiKey).toBe("sk-test");
		fs.rmSync(dir, { recursive: true });
	});

	test("upsert with auth:none omits apiKey", () => {
		const dir = tmpDir();
		upsertCustomProvider("noauth", { baseUrl: sampleProvider.baseUrl, api: sampleProvider.api, auth: "none", models: sampleProvider.models }, ymlPath(dir));
		const { providers } = readModelsYml(ymlPath(dir));
		expect(providers.noauth!.apiKey).toBeUndefined();
		expect(providers.noauth!.auth).toBe("none");
		fs.rmSync(dir, { recursive: true });
	});

	test("delete removes provider and preserves others + unknown fields", () => {
		const dir = tmpDir();
		fs.writeFileSync(ymlPath(dir), stringifyYaml({
			version: 3,
			providers: {
				keep: { baseUrl: "https://keep.com", api: "openai-completions", apiKey: "sk-keep", models: [] },
				remove: { baseUrl: "https://rm.com", api: "openai-completions", apiKey: "sk-rm", models: [] },
			},
		}));
		expect(deleteCustomProvider("remove", ymlPath(dir))).toBe(true);
		const { doc, providers } = readModelsYml(ymlPath(dir));
		expect(Object.keys(providers)).toEqual(["keep"]);
		expect(doc.version).toBe(3);
		fs.rmSync(dir, { recursive: true });
	});

	test("delete returns false for missing provider", () => {
		const dir = tmpDir();
		fs.writeFileSync(ymlPath(dir), stringifyYaml({ providers: {} }));
		expect(deleteCustomProvider("nope", ymlPath(dir))).toBe(false);
		fs.rmSync(dir, { recursive: true });
	});

	test("listCustomProviders returns summaries", () => {
		const dir = tmpDir();
		upsertCustomProvider("alpha", sampleProvider, ymlPath(dir));
		upsertCustomProvider("beta", { ...sampleProvider, models: [{ id: "b1" }, { id: "b2" }] }, ymlPath(dir));
		const list = listCustomProviders(ymlPath(dir));
		expect(list).toHaveLength(2);
		expect(list.find((p) => p.name === "alpha")!.modelCount).toBe(1);
		expect(list.find((p) => p.name === "beta")!.modelCount).toBe(2);
		fs.rmSync(dir, { recursive: true });
	});

	test("round-trip preserves compat fields", () => {
		const dir = tmpDir();
		upsertCustomProvider("compat-prov", {
			...sampleProvider,
			compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
		}, ymlPath(dir));
		const { providers } = readModelsYml(ymlPath(dir));
		expect(providers["compat-prov"]!.compat).toEqual({
			supportsDeveloperRole: false,
			supportsReasoningEffort: false,
		});
		fs.rmSync(dir, { recursive: true });
	});

	test("upsert on json-only install creates yml preserving providers", () => {
		const dir = tmpDir();
		fs.writeFileSync(jsonPath(dir), JSON.stringify({
			providers: { legacy: { baseUrl: "https://legacy.com", api: "openai-completions", apiKey: "old", models: [{ id: "m1" }] } },
		}));
		upsertCustomProvider("newprov", sampleProvider, ymlPath(dir));
		// yml should now exist with both providers
		expect(fs.existsSync(ymlPath(dir))).toBe(true);
		const { providers } = readModelsYml(ymlPath(dir));
		expect(Object.keys(providers).sort()).toEqual(["legacy", "newprov"]);
		fs.rmSync(dir, { recursive: true });
	});
});
