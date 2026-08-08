/**
 * Starter-extensions installer.
 *
 * Discovers extensions from two sources:
 *   1. `starter-extensions/` — simple single-file extensions
 *   2. `packages/<name>/src/` — multi-file extensions (package.json must have "omp-extension": true)
 *
 * Version-stamped re-deployment: each extension is stamped with a `.deck-version`
 * file on deploy. On boot, if the stamp is missing or the version differs,
 * the extension is re-deployed. Extensions without a stamp (user-created or
 * user-modified) are never overwritten.
 *
 * Disable with OMP_DECK_INSTALL_STARTER_EXTENSIONS=0.
 */

import { existsSync, readFileSync } from "node:fs";
import { cp, readdir, rm, stat, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { logger } from "./log.ts";

const log = logger("starter-extensions");

export interface StarterExtensionInstallResult {
	installed: string[];
	updated: string[];
	skipped: string[];
}

const STAMP_FILE = ".deck-version";

interface ExtensionSource {
	name: string;
	srcDir: string;
	version: string;
}

/** Discover all extension sources from starter-extensions/ and packages/. */
async function discoverExtensionSources(): Promise<ExtensionSource[]> {
	const sources: ExtensionSource[] = [];

	// 1. starter-extensions/ directory
	const starterDir = resolveStarterSourceDir();
	if (starterDir) {
		try {
			const entries = await readdir(starterDir, { withFileTypes: true });
			for (const entry of entries) {
				if (!entry.isDirectory()) continue;
				const pkgPath = path.join(starterDir, entry.name, "package.json");
				let version = "0.0.0";
				if (existsSync(pkgPath)) {
					try {
						const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
						version = pkg.version ?? version;
					} catch { /* use default */ }
				}
				sources.push({ name: entry.name, srcDir: path.join(starterDir, entry.name), version });
			}
		} catch { /* directory not found */ }
	}

	// 2. packages/ with "omp-extension": true in package.json
	const packagesDir = path.resolve(import.meta.dir, "..", "..", "..", "packages");
	if (!existsSync(packagesDir)) {
		// Fallback for when running from compiled output
		const altPackagesDir = path.resolve(process.cwd(), "packages");
		if (existsSync(altPackagesDir)) {
			await scanPackageExtensions(altPackagesDir, sources);
		}
	} else {
		await scanPackageExtensions(packagesDir, sources);
	}

	return sources;
}

async function scanPackageExtensions(packagesDir: string, sources: ExtensionSource[]): Promise<void> {
	try {
		const entries = await readdir(packagesDir, { withFileTypes: true });
		for (const entry of entries) {
			if (!entry.isDirectory()) continue;
			const pkgJsonPath = path.join(packagesDir, entry.name, "package.json");
			if (!existsSync(pkgJsonPath)) continue;
			try {
				const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf-8"));
				if (pkg["omp-extension"] !== true) continue;
				const srcDir = path.join(packagesDir, entry.name, "src");
				if (!existsSync(path.join(srcDir, "index.ts"))) continue;
				sources.push({ name: entry.name, srcDir, version: pkg.version ?? "0.0.0" });
			} catch { /* skip malformed package.json */ }
		}
	} catch { /* packages dir not readable */ }
}

/** Read the version stamp from a deployed extension directory. */
function readStamp(dst: string): string | null {
	const stampPath = path.join(dst, STAMP_FILE);
	try {
		return readFileSync(stampPath, "utf-8").trim();
	} catch {
		return null;
	}
}

export async function installStarterExtensions(): Promise<StarterExtensionInstallResult> {
	if (process.env.OMP_DECK_INSTALL_STARTER_EXTENSIONS === "0") {
		log.info("starter extensions install disabled via OMP_DECK_INSTALL_STARTER_EXTENSIONS=0");
		return { installed: [], updated: [], skipped: [] };
	}

	const sources = await discoverExtensionSources();
	if (sources.length === 0) {
		log.warn("no starter extensions found; skipping");
		return { installed: [], updated: [], skipped: [] };
	}

	const targetRoot = path.join(os.homedir(), ".omp", "agent", "extensions");
	const installed: string[] = [];
	const updated: string[] = [];
	const skipped: string[] = [];

	for (const source of sources) {
		const dst = path.join(targetRoot, source.name);

		if (!existsSync(dst)) {
			// Fresh install
			try {
				await cp(source.srcDir, dst, { recursive: true });
				await writeFile(path.join(dst, STAMP_FILE), source.version);
				installed.push(source.name);
				log.info(`installed starter extension "${source.name}" v${source.version} → ${dst}`);
			} catch (err) {
				log.warn(`failed to install starter extension "${source.name}"`, err);
			}
			continue;
		}

		// Already exists: check version stamp
		const stampedVersion = readStamp(dst);
		if (stampedVersion === null) {
			// No stamp = user-created or user-modified → never overwrite
			skipped.push(source.name);
			continue;
		}

		if (stampedVersion === source.version) {
			// Same version → skip
			skipped.push(source.name);
			continue;
		}

		// Version differs → re-deploy (user hasn't removed the stamp, so they haven't taken ownership)
		try {
			await rm(dst, { recursive: true, force: true });
			await cp(source.srcDir, dst, { recursive: true });
			await writeFile(path.join(dst, STAMP_FILE), source.version);
			updated.push(source.name);
			log.info(`updated starter extension "${source.name}" v${stampedVersion} → v${source.version}`);
		} catch (err) {
			log.warn(`failed to update starter extension "${source.name}"`, err);
		}
	}

	const totalChanged = installed.length + updated.length;
	if (totalChanged === 0 && skipped.length === 0) {
		log.info("no starter extensions present in source directory");
	} else if (totalChanged === 0) {
		log.info(`starter extensions up to date: ${skipped.join(", ")}`);
	} else {
		log.info(
			`starter extensions: ${installed.length} installed, ${updated.length} updated` +
			(skipped.length > 0 ? ` (${skipped.length} up to date)` : ""),
		);
	}

	return { installed, updated, skipped };
}

function resolveStarterSourceDir(): string | undefined {
	const override = process.env.OMP_DECK_STARTER_EXTENSIONS_DIR;
	if (override && existsSync(override)) return override;

	const candidates = [
		path.resolve(import.meta.dir, "..", "..", "..", "starter-extensions"),
		path.resolve(import.meta.dir, "..", "..", "starter-extensions"),
		path.resolve(import.meta.dir, "..", "starter-extensions"),
		path.resolve(process.cwd(), "starter-extensions"),
	];
	for (const c of candidates) {
		if (existsSync(c)) return c;
	}
	return undefined;
}

// Re-export the async dir check for tests / external callers.
export async function isDir(p: string): Promise<boolean> {
	try {
		const s = await stat(p);
		return s.isDirectory();
	} catch {
		return false;
	}
}
