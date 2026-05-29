#!/usr/bin/env node
// Post-pack cleanup. Reverses the prepack changes so the dev workflow keeps
// working after a local `npm pack` / `npm publish`. Safe to run twice.
//
// Two jobs (mirror prepack):
//   1. Restore stashed files (paper-trading templates, tests, source maps)
//      from `.publish-stash/` back to their original paths, using the
//      manifest written by prepack.
//   2. Drop the materialized `node_modules/@omp-deck/protocol` and let bun
//      restore the workspace symlink via `bun install`.

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const PROTOCOL_DEST = path.join(ROOT, "node_modules", "@omp-deck", "protocol");
const STASH = path.join(ROOT, ".publish-stash");
const STASH_MANIFEST = path.join(STASH, "manifest.json");

// 1. Restore stashed files.
if (existsSync(STASH_MANIFEST)) {
	const manifest = JSON.parse(readFileSync(STASH_MANIFEST, "utf8"));
	let restored = 0;
	for (const rel of manifest.stashed ?? []) {
		const from = path.join(STASH, rel);
		const to = path.join(ROOT, rel);
		if (!existsSync(from)) continue;
		mkdirSync(path.dirname(to), { recursive: true });
		renameSync(from, to);
		restored += 1;
	}
	rmSync(STASH, { recursive: true, force: true });
	process.stdout.write(`postpack: restored ${restored} stashed file(s)\n`);
}

// 2. Drop materialized protocol so the symlink can come back.
if (existsSync(PROTOCOL_DEST)) {
	rmSync(PROTOCOL_DEST, { recursive: true, force: true });
	process.stdout.write("postpack: removed materialized @omp-deck/protocol\n");
}

const r = spawnSync("bun", ["install", "--frozen-lockfile"], {
	cwd: ROOT,
	stdio: "inherit",
});
if (r.status !== 0) {
	process.stderr.write(
		"postpack: bun install failed; restore the workspace manually with `bun install`.\n",
	);
}
