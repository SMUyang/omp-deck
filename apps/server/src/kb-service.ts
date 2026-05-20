/**
 * KB Cockpit backend.
 *
 * Walks the user's Karpathy-style llm-wiki at `~/kb` (or `OMP_DECK_KB_ROOT`),
 * caches an inventory of every reachable markdown file, and resolves
 * `[[wikilinks]]` against it. The deck cockpit's `/kb` view + graph view
 * consume the output of this service.
 *
 * Design highlights (per docs/proposals/kb-cockpit.md):
 * - Top-level skip set matches orphan-census.py's conventions, PLUS the
 *   user-approved `projects/` exclusion. Mixed-signal projects/ tree stays
 *   out of v1.
 * - Symlinks/junctions (e.g. `cryptocracy/`) are followed once, by tracking
 *   visited absolute paths to break cycles.
 * - Wikilink resolution is stem-first with subpath fallback; code blocks
 *   are stripped before extraction so regex-literal noise (`[[:alpha:]]`)
 *   doesn't leak into the link table.
 * - YAML frontmatter parsing uses the `yaml` package — kb files have real
 *   arrays / nested objects and a header-grep approach is insufficient.
 *
 * The service is read-only at v1; T-36 introduces PUT/POST. The watcher
 * (T-34 bottom) fires `kb_changed` on any mutation so subsequent reads see
 * fresh data after `rebuildIndex()` is called by the watcher.
 */

import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import YAML from "yaml";

import type {
	KbFileResponse,
	KbTreeEntry,
	KbTreeResponse,
	KbWikilink,
} from "@omp-deck/protocol";

import { logger } from "./log.ts";

const log = logger("kb");

// Top-level (anywhere in the tree) directory names to skip. Mirrors the
// canonical set in my-org-new/scripts/orphan-census.py, plus the v1-locked
// projects/ skip per docs/proposals/kb-cockpit.md.
const SKIP_DIR_NAMES = new Set<string>([
	".git",
	".github",
	"node_modules",
	"target",
	".venv",
	"venv",
	"__pycache__",
	"dist",
	"build",
	".next",
	".nuxt",
	".idea",
	".vscode",
	"projects",
]);

// Skill-creator and related .agents/skills dirs we don't want surfaced.
const SKIP_PATH_FRAGMENTS = [".agents/skills"];

// Ambiguous stems that should never resolve by stem-match alone. Force the
// author to use a subpath. Mirrors orphan-census.py's `AMBIGUOUS_STEMS`.
const AMBIGUOUS_STEMS = new Set<string>([
	"readme",
	"index",
	"profile",
	"skill",
	"summary",
	"notes",
]);

// Wikilink: `[[target|label]]`. Target may include `dir/path` and `#anchor`.
// We deliberately exclude `]` and `|` from the target capture so labels work.
const WIKILINK_RE = /\[\[([^\]|\n]+?)(?:\|([^\]\n]+?))?\]\]/g;

// Fenced code blocks and inline backtick spans — wikilinks inside them are
// almost always documentation/regex noise (`[[:alpha:]]`), not real links.
const FENCED_CODE_RE = /```[\s\S]*?(?:```|$)/g;
const INLINE_CODE_RE = /`[^`\n]+`/g;

interface FileRecord {
	relPath: string; // forward-slash kb-relative
	absPath: string;
	dir: string; // forward-slash relative dir, "" for root
	stem: string; // lowercase filename stem (no .md)
	size: number;
	mtime: Date;
}

export interface KbServiceOptions {
	root: string;
}

export class KbService {
	readonly root: string;
	private records: FileRecord[] = [];
	private byRelPath = new Map<string, FileRecord>();
	private byStem = new Map<string, FileRecord[]>();
	private indexReady = false;
	private indexPromise: Promise<void> | undefined;

	constructor(opts: KbServiceOptions) {
		// Always store the root as an absolute path with native separators.
		this.root = path.resolve(opts.root);
	}

	/** Lazy build on first request; subsequent calls reuse the cache. */
	async ensureIndex(): Promise<void> {
		if (this.indexReady) return;
		if (this.indexPromise) return this.indexPromise;
		this.indexPromise = this.buildIndex();
		try {
			await this.indexPromise;
		} finally {
			this.indexPromise = undefined;
		}
	}

	/** Invalidate cache + rebuild on next request. Called by the watcher. */
	invalidate(): void {
		this.indexReady = false;
	}

	/**
	 * Return a single directory listing. `subpath` is forward-slash relative
	 * to the kb root; empty / "/" means root. Returns `undefined` if the
	 * path doesn't exist or escapes the kb root.
	 */
	async getTree(subpath: string = ""): Promise<KbTreeResponse | undefined> {
		await this.ensureIndex();
		const cleanRel = normalizeRel(subpath);
		// Reject traversal into any path whose segments include an excluded
		// directory — keeps `/api/kb/tree?path=projects` 404 even though
		// `projects` exists on disk.
		if (this.pathIsExcluded(cleanRel)) return undefined;
		const absDir = this.resolveAbs(cleanRel);
		if (!absDir) return undefined;
		try {
			const st = await stat(absDir);
			if (!st.isDirectory()) return undefined;
		} catch {
			return undefined;
		}

		let entries;
		try {
			entries = await readdir(absDir, { withFileTypes: true });
		} catch (err) {
			log.warn(`readdir failed at ${absDir}`, err);
			return { path: cleanRel, dirs: [], files: [] };
		}

		const dirs: KbTreeEntry[] = [];
		const files: KbTreeEntry[] = [];
		for (const entry of entries) {
			if (this.shouldSkip(entry.name, joinRel(cleanRel, entry.name))) continue;
			const relPath = joinRel(cleanRel, entry.name);
			const abs = path.join(absDir, entry.name);

			if (entry.isDirectory() || entry.isSymbolicLink()) {
				let isDir = entry.isDirectory();
				let isSymlink = entry.isSymbolicLink();
				if (isSymlink) {
					try {
						const st = await stat(abs); // follows
						isDir = st.isDirectory();
					} catch {
						continue;
					}
				}
				if (!isDir) continue;
				const mdCount = this.recursiveMdCount(relPath);
				const item: KbTreeEntry = {
					name: entry.name,
					path: relPath,
					kind: "dir",
					mdCount,
				};
				if (isSymlink) item.symlink = true;
				dirs.push(item);
				continue;
			}

			if (!entry.isFile()) continue;
			if (!entry.name.toLowerCase().endsWith(".md")) continue;
			let st;
			try {
				st = await stat(abs);
			} catch {
				continue;
			}
			files.push({
				name: entry.name,
				path: relPath,
				kind: "file",
				size: st.size,
				mtime: st.mtime.toISOString(),
			});
		}

		// Stable ordering: dirs by name asc; files by name asc. Future: surface
		// hubs first within a dir — out of v1.
		dirs.sort((a, b) => a.name.localeCompare(b.name));
		files.sort((a, b) => a.name.localeCompare(b.name));
		return { path: cleanRel, dirs, files };
	}

	/**
	 * Read a single file's parsed body. `subpath` is forward-slash
	 * relative; must end in `.md` (caller usually clicked a tree entry).
	 * Returns undefined when the path is missing, isn't a file, or escapes
	 * the kb root.
	 */
	async getFile(subpath: string): Promise<KbFileResponse | undefined> {
		await this.ensureIndex();
		const cleanRel = normalizeRel(subpath);
		if (!cleanRel) return undefined;
		if (this.pathIsExcluded(cleanRel)) return undefined;
		const abs = this.resolveAbs(cleanRel);
		if (!abs) return undefined;

		let raw: string;
		let st;
		try {
			st = await stat(abs);
			if (!st.isFile()) return undefined;
			raw = await readFile(abs, "utf8");
		} catch {
			return undefined;
		}

		const { frontmatter, frontmatterError, body } = parseFrontmatter(raw);
		const sourceDir = path.posix.dirname(cleanRel);
		const outgoingLinks = this.extractWikilinks(body, sourceDir === "." ? "" : sourceDir);
		const bodyForRender = this.rewriteBodyForRender(body, sourceDir === "." ? "" : sourceDir);

		const resp: KbFileResponse = {
			path: cleanRel,
			absolutePath: abs,
			frontmatter,
			body,
			rawContent: raw,
			bodyForRender,
			outgoingLinks,
			size: st.size,
			mtime: st.mtime.toISOString(),
		};
		if (frontmatterError) resp.frontmatterError = frontmatterError;
		return resp;
	}

	/**
	 * Atomic write at `subpath`. `mode` controls the create-vs-update
	 * semantics:
	 *  - "update" (PUT): destination must already exist. Returns
	 *    `{ kind: "not-found" }` otherwise.
	 *  - "create" (POST): destination must NOT exist. Returns
	 *    `{ kind: "conflict" }` otherwise. Creates parent dirs.
	 *
	 * Frontmatter is validated by re-running parseFrontmatter on the incoming
	 * content. Invalid YAML returns `{ kind: "invalid-frontmatter", message }`
	 * so the editor can surface the parser's complaint. Writes go through a
	 * temp + rename pair so concurrent reads never see a half-written file.
	 */
	async saveFile(
		subpath: string,
		content: string,
		mode: "update" | "create",
	): Promise<
		| { kind: "ok"; response: KbFileResponse }
		| { kind: "not-found" }
		| { kind: "conflict" }
		| { kind: "invalid-path" }
		| { kind: "invalid-frontmatter"; message: string }
	> {
		await this.ensureIndex();
		const cleanRel = normalizeRel(subpath);
		if (!cleanRel) return { kind: "invalid-path" };
		if (this.pathIsExcluded(cleanRel)) return { kind: "invalid-path" };
		const abs = this.resolveAbs(cleanRel);
		if (!abs) return { kind: "invalid-path" };
		if (!cleanRel.toLowerCase().endsWith(".md")) return { kind: "invalid-path" };

		// Frontmatter validation: if the content claims a frontmatter block,
		// it has to be parseable YAML before we'll write.
		const { frontmatterError } = parseFrontmatter(content);
		if (frontmatterError) return { kind: "invalid-frontmatter", message: frontmatterError };

		const exists = existsSync(abs);
		if (mode === "update" && !exists) return { kind: "not-found" };
		if (mode === "create" && exists) return { kind: "conflict" };

		// Ensure parent dir exists for create. Update is a no-op since the
		// existence check above guarantees the dir.
		if (mode === "create") {
			const parent = path.dirname(abs);
			try {
				await mkdir(parent, { recursive: true });
			} catch (err) {
				log.error(`mkdir failed at ${parent}`, err);
				return { kind: "invalid-path" };
			}
		}

		// Atomic write: temp file in the same dir, then rename. Single-drive
		// assumption (kb-cockpit-proposal decision 4). Rename across drives
		// would fail; we'd need a cp+rm fallback, which is out of v1.
		const dir = path.dirname(abs);
		const tmp = path.join(dir, `.${path.basename(abs)}.${process.pid}.${Date.now()}.tmp`);
		try {
			await writeFile(tmp, content, "utf8");
			await rename(tmp, abs);
		} catch (err) {
			log.error(`atomic save failed at ${abs}`, err);
			try {
				await rm(tmp, { force: true });
			} catch {
				// best-effort
			}
			throw err;
		}

		// Force a fresh index next read so the new file (or new content)
		// affects wikilink resolution everywhere. The watcher will also fire
		// but we don't want to race it.
		this.invalidate();

		const response = await this.getFile(cleanRel);
		if (!response) {
			// Shouldn't happen — we just wrote it — but guard anyway.
			return { kind: "invalid-path" };
		}
		return { kind: "ok", response };
	}

	// ─── internals ───────────────────────────────────────────────────────

	private async buildIndex(): Promise<void> {
		const t0 = performance.now();
		this.records = [];
		this.byRelPath.clear();
		this.byStem.clear();

		if (!existsSync(this.root)) {
			log.warn(`kb root does not exist: ${this.root}`);
			this.indexReady = true;
			return;
		}

		const visited = new Set<string>();
		await this.walk(this.root, "", visited);

		for (const r of this.records) {
			this.byRelPath.set(r.relPath, r);
			const list = this.byStem.get(r.stem);
			if (list) list.push(r);
			else this.byStem.set(r.stem, [r]);
		}

		const ms = (performance.now() - t0).toFixed(1);
		log.info(`indexed ${this.records.length} md files under ${this.root} in ${ms}ms`);
		this.indexReady = true;
	}

	private async walk(absDir: string, relDir: string, visited: Set<string>): Promise<void> {
		let real;
		try {
			real = await realpath(absDir);
		} catch {
			return;
		}
		if (visited.has(real)) return;
		visited.add(real);

		let entries;
		try {
			entries = await readdir(absDir, { withFileTypes: true });
		} catch (err) {
			log.warn(`readdir failed: ${absDir}`, err);
			return;
		}

		for (const entry of entries) {
			const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
			if (this.shouldSkip(entry.name, rel)) continue;
			const abs = path.join(absDir, entry.name);

			if (entry.isDirectory() || entry.isSymbolicLink()) {
				try {
					const st = await stat(abs);
					if (st.isDirectory()) {
						await this.walk(abs, rel, visited);
					}
				} catch {
					// stat failure on symlink target; skip silently
				}
				continue;
			}

			if (!entry.isFile()) continue;
			if (!entry.name.toLowerCase().endsWith(".md")) continue;

			try {
				const st = await stat(abs);
				const stem = entry.name.slice(0, -3).toLowerCase();
				this.records.push({
					relPath: rel,
					absPath: abs,
					dir: relDir,
					stem,
					size: st.size,
					mtime: st.mtime,
				});
			} catch {
				// best-effort
			}
		}
	}

	private shouldSkip(name: string, rel: string): boolean {
		if (SKIP_DIR_NAMES.has(name)) return true;
		for (const frag of SKIP_PATH_FRAGMENTS) {
			if (rel.includes(frag)) return true;
		}
		return false;
	}

	private pathIsExcluded(rel: string): boolean {
		if (!rel) return false;
		for (const seg of rel.split("/")) {
			if (SKIP_DIR_NAMES.has(seg)) return true;
		}
		for (const frag of SKIP_PATH_FRAGMENTS) {
			if (rel.includes(frag)) return true;
		}
		return false;
	}

	private resolveAbs(rel: string): string | undefined {
		// Reject any rel that escapes the root via `..` or absolute paths.
		if (rel.includes("..") || path.isAbsolute(rel)) return undefined;
		const abs = rel ? path.join(this.root, rel) : this.root;
		const resolved = path.resolve(abs);
		const rootResolved = path.resolve(this.root);
		if (!resolved.startsWith(rootResolved)) return undefined;
		return resolved;
	}

	private recursiveMdCount(relDir: string): number {
		// Cheap O(n) scan against the cached index. n ~ 600 for this kb.
		if (!relDir) return this.records.length;
		const prefix = `${relDir}/`;
		let n = 0;
		for (const r of this.records) {
			if (r.relPath.startsWith(prefix)) n++;
		}
		return n;
	}

	private extractWikilinks(body: string, sourceDir: string): KbWikilink[] {
		const stripped = body.replace(FENCED_CODE_RE, "").replace(INLINE_CODE_RE, "");
		const out: KbWikilink[] = [];
		for (const m of stripped.matchAll(WIKILINK_RE)) {
			const rawTarget = m[1].trim();
			const label = (m[2] ?? rawTarget).trim();
			let target = rawTarget;
			let anchor: string | null = null;
			const hashAt = target.indexOf("#");
			if (hashAt >= 0) {
				anchor = target.slice(hashAt + 1) || null;
				target = target.slice(0, hashAt);
			}
			target = target.trim();
			const raw = m[2] !== undefined ? `${target}${anchor ? `#${anchor}` : ""}|${label}` : `${target}${anchor ? `#${anchor}` : ""}`;
			const link: KbWikilink = {
				raw,
				target,
				label,
				anchor,
				resolved: null,
			};
			if (!target) {
				link.unresolvedReason = "no-match";
				out.push(link);
				continue;
			}
			const resolution = this.resolveTarget(target, sourceDir);
			if (resolution.resolved) {
				link.resolved = resolution.resolved;
			} else {
				link.unresolvedReason = resolution.reason;
			}
			out.push(link);
		}
		return out;
	}

	/**
	 * Replace `[[name|label]]` syntax with markdown links the web client
	 * renders via its custom `a` component. Resolved → `[label](kb-link:<path>?anchor=<a>)`;
	 * unresolved → `[label](kb-unresolved:<target>)`. Wikilinks inside fenced
	 * code blocks or inline backtick spans are NOT rewritten — they're noise
	 * (e.g. regex literals like `[[:alpha:]]`).
	 */
	private rewriteBodyForRender(body: string, sourceDir: string): string {
		// Walk the body marking code-block ranges so we can skip them. A single
		// linear pass is plenty for the scale we see (~9KB per file).
		const codeRanges = collectCodeRanges(body);
		let out = "";
		let cursor = 0;
		const re = /\[\[([^\]|\n]+?)(?:\|([^\]\n]+?))?\]\]/g;
		let m: RegExpExecArray | null;
		while ((m = re.exec(body)) !== null) {
			const start = m.index;
			const end = start + m[0].length;
			// Emit the body up to this match.
			out += body.slice(cursor, start);
			cursor = end;
			if (insideAnyRange(codeRanges, start)) {
				out += m[0]; // leave wikilinks inside code blocks alone
				continue;
			}
			const rawTarget = m[1].trim();
			const labelRaw = (m[2] ?? rawTarget).trim();
			let target = rawTarget;
			let anchor: string | null = null;
			const hashAt = target.indexOf("#");
			if (hashAt >= 0) {
				anchor = target.slice(hashAt + 1) || null;
				target = target.slice(0, hashAt);
			}
			target = target.trim();
			const safeLabel = labelRaw.replace(/[\[\]]/g, "");
			if (!target) {
				out += `[${safeLabel}](kb-unresolved:)`;
				continue;
			}
			const { resolved } = this.resolveTarget(target, sourceDir);
			if (resolved) {
				const q = anchor ? `?anchor=${encodeURIComponent(anchor)}` : "";
				out += `[${safeLabel}](kb-link:${encodeURI(resolved)}${q})`;
			} else {
				out += `[${safeLabel}](kb-unresolved:${encodeURIComponent(target)})`;
			}
		}
		out += body.slice(cursor);
		return out;
	}

	private resolveTarget(
		target: string,
		sourceDir: string,
	): { resolved: string | null; reason?: KbWikilink["unresolvedReason"] } {
		const normalized = target.replace(/\\/g, "/").replace(/^\/+/, "");
		// Subpath form: contains a slash → resolve as relative to kb root.
		if (normalized.includes("/")) {
			const withExt = normalized.toLowerCase().endsWith(".md") ? normalized : `${normalized}.md`;
			const rec = this.byRelPath.get(withExt);
			if (rec) return { resolved: rec.relPath };
			return { resolved: null, reason: "no-match" };
		}

		// Stem-only form.
		const stem = normalized.toLowerCase().endsWith(".md")
			? normalized.slice(0, -3).toLowerCase()
			: normalized.toLowerCase();
		if (AMBIGUOUS_STEMS.has(stem)) {
			return { resolved: null, reason: "ambiguous-stem" };
		}
		const candidates = this.byStem.get(stem);
		if (!candidates || candidates.length === 0) {
			return { resolved: null, reason: "no-match" };
		}
		if (candidates.length === 1) return { resolved: candidates[0].relPath };

		// Tiebreaker: prefer same-directory, then nearest-ancestor, then
		// alphabetical relPath.
		const sameDir = candidates.find((c) => c.dir === sourceDir);
		if (sameDir) return { resolved: sameDir.relPath };
		const sorted = [...candidates].sort((a, b) => a.relPath.localeCompare(b.relPath));
		return { resolved: sorted[0].relPath };
	}
}

// ─── helpers ───────────────────────────────────────────────────────────────

function normalizeRel(p: string): string {
	if (!p) return "";
	// Strip leading/trailing slashes, collapse repeated slashes, force forward.
	return p.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, "");
}

function joinRel(parent: string, child: string): string {
	if (!parent) return child;
	return `${parent}/${child}`;
}

/**
 * Frontmatter parser: extracts the leading `---\n…\n---\n` block (if any),
 * runs it through `yaml`, and returns `{ frontmatter, frontmatterError,
 * body }`. Body is the file content with the block stripped (one trailing
 * newline consumed). When YAML parsing fails we return the raw block as a
 * string under `frontmatter._raw` with an error message, so the editor can
 * surface the problem instead of silently dropping the metadata.
 */
function parseFrontmatter(text: string): {
	frontmatter: Record<string, unknown>;
	frontmatterError?: string;
	body: string;
} {
	if (!text.startsWith("---")) return { frontmatter: {}, body: text };
	const end = text.indexOf("\n---", 3);
	if (end < 0) return { frontmatter: {}, body: text };
	const rawBlock = text.slice(4, end);
	let cursor = end + 4;
	if (text[cursor] === "\r") cursor += 1;
	if (text[cursor] === "\n") cursor += 1;
	const body = text.slice(cursor);

	let frontmatter: Record<string, unknown> = {};
	let frontmatterError: string | undefined;
	try {
		const parsed = YAML.parse(rawBlock);
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			frontmatter = parsed as Record<string, unknown>;
		} else if (parsed !== null) {
			frontmatter = { _raw: rawBlock };
			frontmatterError = "frontmatter was not a YAML mapping";
		}
	} catch (err) {
		frontmatter = { _raw: rawBlock };
		frontmatterError = (err as Error).message;
	}
	return frontmatterError ? { frontmatter, frontmatterError, body } : { frontmatter, body };
}

/**
 * Collect `(start, end)` ranges in the body that belong to a fenced code
 * block (``` … ```) or an inline backtick span. Used by `rewriteBodyForRender`
 * so wikilinks inside code stay verbatim.
 */
function collectCodeRanges(text: string): Array<[number, number]> {
	const ranges: Array<[number, number]> = [];
	// Fenced blocks first — they consume their content (including stray backticks).
	const fenceRe = /```[\s\S]*?(?:```|$)/g;
	let fenceMatch: RegExpExecArray | null;
	const fenceCovered: Array<[number, number]> = [];
	while ((fenceMatch = fenceRe.exec(text)) !== null) {
		const r: [number, number] = [fenceMatch.index, fenceMatch.index + fenceMatch[0].length];
		ranges.push(r);
		fenceCovered.push(r);
	}
	// Inline spans, skipping anything already inside a fence.
	const inlineRe = /`[^`\n]+`/g;
	let inlineMatch: RegExpExecArray | null;
	while ((inlineMatch = inlineRe.exec(text)) !== null) {
		const start = inlineMatch.index;
		if (insideAnyRange(fenceCovered, start)) continue;
		ranges.push([start, start + inlineMatch[0].length]);
	}
	ranges.sort((a, b) => a[0] - b[0]);
	return ranges;
}

function insideAnyRange(ranges: Array<[number, number]>, pos: number): boolean {
	// Linear scan — n is bounded by the number of code spans in one file.
	for (const [s, e] of ranges) {
		if (pos >= s && pos < e) return true;
		if (s > pos) return false;
	}
	return false;
}

export function resolveKbRoot(): string {
	const fromEnv = process.env.OMP_DECK_KB_ROOT;
	if (fromEnv && fromEnv.trim().length > 0) return path.resolve(fromEnv.trim());
	return path.join(os.homedir(), "kb");
}
