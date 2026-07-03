import { afterEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { buildAgentBlobsRouter } from "./routes-agent-blobs.ts";
import type { Config } from "./config.ts";

let workdir: string | undefined;

afterEach(async () => {
	if (workdir) {
		await fs.rm(workdir, { recursive: true, force: true });
		workdir = undefined;
	}
});

async function boot(): Promise<{ app: Hono; blobRoot: string }> {
	workdir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-deck-agent-blobs-"));
	const agentDir = path.join(workdir, "agent");
	const blobRoot = path.join(agentDir, "blobs");
	await fs.mkdir(blobRoot, { recursive: true });
	const config = { agentDir } as Config;
	const app = new Hono();
	app.route("/", buildAgentBlobsRouter(config));
	return { app, blobRoot };
}

const HASH = "2b0ba7df5527c8876babb0cccfcc410f3c7ee5719a48fee3ac81250b60c47631";

describe("agent blob image route", () => {
	test("serves an OMP blob hash from the agent blob store", async () => {
		const { app, blobRoot } = await boot();
		await fs.writeFile(path.join(blobRoot, HASH), new Uint8Array([1, 2, 3]));

		const res = await app.request(`/agent-blobs/${HASH}?mimeType=image%2Fpng`);

		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toBe("image/png");
		expect(res.headers.get("cache-control")).toContain("immutable");
		expect(Array.from(new Uint8Array(await res.arrayBuffer()))).toEqual([1, 2, 3]);
	});

	test("falls back to extension-suffixed blob files", async () => {
		const { app, blobRoot } = await boot();
		await fs.writeFile(path.join(blobRoot, `${HASH}.webp`), new Uint8Array([4, 5]));

		const res = await app.request(`/agent-blobs/${HASH}?mimeType=image%2Fwebp`);

		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toBe("image/webp");
		expect(Array.from(new Uint8Array(await res.arrayBuffer()))).toEqual([4, 5]);
	});

	test("rejects invalid hashes and non-image MIME hints", async () => {
		const { app } = await boot();

		expect((await app.request("/agent-blobs/not-a-hash?mimeType=image%2Fpng")).status).toBe(400);
		expect((await app.request(`/agent-blobs/${HASH}?mimeType=text%2Fplain`)).status).toBe(400);
	});

	test("returns 404 for missing blobs", async () => {
		const { app } = await boot();
		const res = await app.request(`/agent-blobs/${HASH}?mimeType=image%2Fpng`);
		expect(res.status).toBe(404);
	});
});
