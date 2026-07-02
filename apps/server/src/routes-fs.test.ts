import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { BrowseDirectoryResponse } from "@omp-deck/protocol";

import { buildFsRouter } from "./routes-fs.ts";

let tmp: string | undefined;

afterEach(async () => {
	if (tmp) await fs.rm(tmp, { recursive: true, force: true });
	tmp = undefined;
});

async function boot(): Promise<{ app: ReturnType<typeof buildFsRouter>; root: string }> {
	tmp = await fs.mkdtemp(path.join(os.homedir(), ".omp-deck-fs-browse-"));
	await fs.mkdir(path.join(tmp, "alpha"));
	await fs.mkdir(path.join(tmp, ".hidden"));
	await fs.writeFile(path.join(tmp, "note.txt"), "x");
	return { app: buildFsRouter(), root: tmp };
}

describe("GET /fs/browse", () => {
	test("lists child directories and omits files by default", async () => {
		const { app, root } = await boot();
		const res = await app.request(`/fs/browse?cwd=${encodeURIComponent(root)}`);
		const body = (await res.json()) as BrowseDirectoryResponse;
		expect(res.status).toBe(200);
		expect(body.cwd).toBe(root);
		expect(body.entries).toContainEqual({ name: "alpha", path: path.join(root, "alpha"), isDir: true, hidden: false });
		expect(body.entries.some((entry: { name: string }) => entry.name === "note.txt")).toBe(false);
		expect(body.entries.some((entry: { name: string }) => entry.name === ".hidden")).toBe(false);
	});

	test("can include hidden directories and navigate to parent", async () => {
		const { app, root } = await boot();
		const child = path.join(root, "alpha");
		const res = await app.request(`/fs/browse?cwd=${encodeURIComponent(child)}&showHidden=1`);
		const body = (await res.json()) as BrowseDirectoryResponse;
		expect(res.status).toBe(200);
		expect(body.parent).toBe(root);
		const rootRes = await app.request(`/fs/browse?cwd=${encodeURIComponent(root)}&showHidden=1`);
		const rootBody = (await rootRes.json()) as BrowseDirectoryResponse;
		expect(rootBody.entries.some((entry: { name: string }) => entry.name === ".hidden")).toBe(true);
	});

	test("rejects paths outside the user's home", async () => {
		const { app } = await boot();
		const res = await app.request("/fs/browse?cwd=/");
		expect(res.status).toBe(403);
	});
});
