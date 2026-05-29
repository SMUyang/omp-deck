#!/usr/bin/env node
// Pre-publish step. Runs automatically before `npm pack` and `npm publish`.
//
// Jobs:
//   1. Ensure the web app is built — the tarball ships pre-built static assets
//      (apps/web/dist/) so the installed package doesn't need a build step.
//   2. Materialize `node_modules/@omp-deck/protocol` as a real directory copy
//      (not a workspace symlink) so npm's `bundledDependencies` mechanism
//      picks it up in the tarball.
//   3. Stash files that live under allowed `files` paths but MUST NOT ship:
//      - apps/server/src/templates/paper-trading-*.yaml — operator-private
//        routine templates (also gitignored)
//      - **/*.test.ts — bloat, no runtime value
//      - apps/web/dist/**/*.map — bloat
//      `.npmignore` cannot exclude files matched by the `files` allowlist
//      (npm's documented behavior), so we physically move them aside.
//
// `scripts/postpack.mjs` reverses (2) and (3) so the dev workflow keeps
// working after a local `npm pack` / `npm publish`.

import {
	cpSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const PROTOCOL_SRC = path.join(ROOT, "packages", "protocol");
const PROTOCOL_DEST = path.join(ROOT, "node_modules", "@omp-deck", "protocol");
const WEB_DIST = path.join(ROOT, "apps", "web", "dist");
const STASH = path.join(ROOT, ".publish-stash");
const STASH_MANIFEST = path.join(STASH, "manifest.json");

// Files that must NOT ship even though they sit under `files`-allowed paths.
// Each entry is a (absolute-source-path, predicate) pair built fresh per run.
function collectExclusions() {
	const hits = [];

	const templatesDir = path.join(ROOT, "apps", "server", "src", "templates");
	if (existsSync(templatesDir)) {
		for (const name of readdirSync(templatesDir)) {
			if (name.startsWith("paper-trading-") && name.endsWith(".yaml")) {
				hits.push(path.join(templatesDir, name));
			}
		}
	}

	const serverSrc = path.join(ROOT, "apps", "server", "src");
	walkTs(serverSrc, (p) => {
		if (p.endsWith(".test.ts")) hits.push(p);
	});

	if (existsSync(WEB_DIST)) {
		walkAll(WEB_DIST, (p) => {
			if (p.endsWith(".map")) hits.push(p);
		});
	}

	return hits;
}

function walkTs(dir, cb) {
	if (!existsSync(dir)) return;
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) walkTs(full, cb);
		else if (entry.isFile() && entry.name.endsWith(".ts")) cb(full);
	}
}

function walkAll(dir, cb) {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) walkAll(full, cb);
		else if (entry.isFile()) cb(full);
	}
}

function step(msg, fn) {
	process.stdout.write(`prepack: ${msg}... `);
	try {
		fn();
		process.stdout.write("ok\n");
	} catch (err) {
		process.stdout.write("FAIL\n");
		throw err;
	}
}

step("build web", () => {
	if (existsSync(path.join(WEB_DIST, "index.html"))) {
		// Already built — skip the 7s rebuild. Run `bun run clean` if you want
		// to force a fresh build before publishing.
		return;
	}
	const r = spawnSync("bun", ["run", "--filter", "@omp-deck/web", "build"], {
		cwd: ROOT,
		stdio: "inherit",
	});
	if (r.status !== 0) throw new Error(`web build exited with ${r.status}`);
});

step("materialize @omp-deck/protocol", () => {
	mkdirSync(path.dirname(PROTOCOL_DEST), { recursive: true });
	// If it's a symlink (workspace dev layout) or a stale copy, remove first.
	if (existsSync(PROTOCOL_DEST) || isSymlink(PROTOCOL_DEST)) {
		rmSync(PROTOCOL_DEST, { recursive: true, force: true });
	}
	cpSync(PROTOCOL_SRC, PROTOCOL_DEST, {
		recursive: true,
		// Skip the dev junk; we only need source + package.json.
		filter: (src) => {
			const base = path.basename(src);
			return base !== "node_modules" && base !== ".turbo" && !base.endsWith(".test.ts");
		},
	});

	// Rewrite the bundled package.json: drop `private` (npm bundling refuses
	// some private deps in strict modes) and drop `dependencies` / `devDeps`
	// so npm doesn't think the bundled package's transitive deps are
	// "already satisfied" and skip installing them. The root package.json
	// declares the same deps (ajv, ajv-formats) so they get hoisted and
	// resolved via the normal node_modules walk.
	const pkgPath = path.join(PROTOCOL_DEST, "package.json");
	const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
	delete pkg.private;
	delete pkg.dependencies;
	delete pkg.devDependencies;
	delete pkg.scripts;
	writeFileSync(pkgPath, `${JSON.stringify(pkg, null, "\t")}\n`);
});

step("stash files that must not ship", () => {
	// Wipe any prior stash before starting (a previous failed pack may have
	// left one). Files inside are restored by postpack via manifest.
	if (existsSync(STASH)) rmSync(STASH, { recursive: true, force: true });
	mkdirSync(STASH, { recursive: true });

	const manifest = [];
	for (const src of collectExclusions()) {
		const rel = path.relative(ROOT, src);
		const dest = path.join(STASH, rel);
		mkdirSync(path.dirname(dest), { recursive: true });
		renameSync(src, dest);
		manifest.push(rel);
	}
	writeFileSync(STASH_MANIFEST, JSON.stringify({ stashed: manifest }, null, "\t"));
});

function isSymlink(p) {
	try {
		return lstatSync(p).isSymbolicLink();
	} catch {
		return false;
	}
}
