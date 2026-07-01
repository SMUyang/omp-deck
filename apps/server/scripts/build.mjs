#!/usr/bin/env bun
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(here, "..");
const outDir = path.resolve(serverRoot, process.env.OMP_DECK_SERVER_BUILD_OUTDIR?.trim() || "dist");

const externals = [
	"@oh-my-pi/pi-coding-agent",
	"@oh-my-pi/pi-coding-agent/*",
	"@oh-my-pi/pi-ai",
	"@oh-my-pi/pi-ai/*",
	"markit-ai",
	"mupdf",
];

const cmd = [
	process.execPath,
	"build",
	"src/index.ts",
	"--target=bun",
	`--outdir=${outDir}`,
	"--minify",
	...externals.flatMap((name) => ["--external", name]),
];

const proc = Bun.spawnSync({
	cmd,
	cwd: serverRoot,
	stdout: "inherit",
	stderr: "inherit",
});

if (proc.exitCode !== 0) process.exit(proc.exitCode);

const migrationsSrc = path.join(serverRoot, "src", "db", "migrations");
const migrationsDest = path.join(outDir, "migrations");
if (existsSync(migrationsDest)) rmSync(migrationsDest, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });
cpSync(migrationsSrc, migrationsDest, { recursive: true });
