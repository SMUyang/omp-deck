import { Hono } from "hono";
import * as os from "node:os";
import * as path from "node:path";

import type { Config } from "./config.ts";

const HASH_RE = /^[a-f0-9]{64}$/;
const MIME_EXT: Record<string, string> = {
	"image/png": "png",
	"image/jpeg": "jpg",
	"image/gif": "gif",
	"image/webp": "webp",
	"image/svg+xml": "svg",
};

function resolveBlobRoot(config: Config): string {
	return path.join(config.agentDir ?? path.join(os.homedir(), ".omp", "agent"), "blobs");
}

function normalizeMimeType(value: string | undefined): string | undefined {
	if (!value) return undefined;
	const mimeType = value.trim().toLowerCase();
	return MIME_EXT[mimeType] ? mimeType : undefined;
}

async function findBlobFile(root: string, hash: string, mimeType: string | undefined): Promise<{ file: Bun.BunFile; mimeType?: string } | undefined> {
	const direct = Bun.file(path.join(root, hash));
	if (await direct.exists()) return { file: direct, ...(mimeType ? { mimeType } : {}) };

	const hintedExt = mimeType ? MIME_EXT[mimeType] : undefined;
	if (hintedExt) {
		const hinted = Bun.file(path.join(root, `${hash}.${hintedExt}`));
		if (await hinted.exists()) return { file: hinted, mimeType };
	}

	for (const [candidateMime, ext] of Object.entries(MIME_EXT)) {
		const candidate = Bun.file(path.join(root, `${hash}.${ext}`));
		if (await candidate.exists()) return { file: candidate, mimeType: candidateMime };
	}
	return undefined;
}

export function buildAgentBlobsRouter(config: Config): Hono {
	const app = new Hono();
	app.get("/agent-blobs/:hash", async (c) => {
		const hash = c.req.param("hash").toLowerCase();
		if (!HASH_RE.test(hash)) return c.text("invalid blob hash", 400);
		const mimeType = normalizeMimeType(c.req.query("mimeType"));
		if (c.req.query("mimeType") && !mimeType) return c.text("invalid image MIME type", 400);

		const found = await findBlobFile(resolveBlobRoot(config), hash, mimeType);
		if (!found) return c.text("not found", 404);

		const headers: Record<string, string> = {
			"cache-control": "public, max-age=31536000, immutable",
		};
		if (found.mimeType) headers["content-type"] = found.mimeType;
		return new Response(found.file, { headers });
	});
	return app;
}
