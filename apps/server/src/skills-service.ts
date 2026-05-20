/**
 * Skill-level enumeration over the marketplace-installed plugin tree.
 *
 * Each installed plugin can contain N skills under `<installPath>/skills/<dirName>/SKILL.md`.
 * `MarketplaceManager` only surfaces capability *flags* at the plugin level, so the
 * deck cockpit needs its own walker. This service is read-only; lifecycle mutations
 * (install / uninstall / enable / disable) stay on `MarketplaceService`.
 *
 * Watcher concerns (broadcasting `skills_changed`) live in `index.ts` next to the
 * other server-level fan-out so the singleton wiring stays in one place.
 */

import { readdir, readFile, stat } from "node:fs/promises";
import * as path from "node:path";

import type {
	InstalledPluginInfo,
	ListSkillsResponse,
	SkillFrontmatter,
	SkillSummary,
} from "@omp-deck/protocol";

import { logger } from "./log.ts";
import type { MarketplaceService } from "./marketplace-service.ts";

const log = logger("skills");

export class SkillsService {
	constructor(private readonly marketplace: MarketplaceService) {}

	async listSkills(): Promise<ListSkillsResponse> {
		const plugins = await this.marketplace.listInstalled();
		const skills: SkillSummary[] = [];

		for (const plugin of plugins) {
			const entries = await this.readSkillDirs(plugin.installPath);
			for (const dirName of entries) {
				const skillMdPath = path.join(plugin.installPath, "skills", dirName, "SKILL.md");
				let raw: string;
				try {
					raw = await readFile(skillMdPath, "utf8");
				} catch (err) {
					// Plugin directory layouts vary — only emit a debug log when a `skills/<x>`
					// dir exists without a SKILL.md, since that's the only "unexpected" case.
					log.debug(`no SKILL.md at ${skillMdPath}`, err);
					continue;
				}
				skills.push({
					id: `${plugin.id}/${dirName}`,
					pluginId: plugin.id,
					pluginName: plugin.name,
					marketplace: plugin.marketplace,
					scope: plugin.scope,
					skillPath: skillMdPath,
					dirName,
					frontmatter: parseSkillFrontmatter(raw, dirName),
					// Treat `enabled: undefined` as enabled — matches the SDK convention where
					// the registry only writes the field when explicitly disabled.
					enabled: plugin.enabled !== false,
				});
			}
		}

		// Stable ordering: by plugin id, then by skill dir name. Keeps the UI
		// list deterministic across reads without forcing the client to sort.
		skills.sort((a, b) => a.pluginId.localeCompare(b.pluginId) || a.dirName.localeCompare(b.dirName));

		return { skills, plugins };
	}

	/**
	 * Return the directory names directly under `<installPath>/skills/`. Missing
	 * dir is treated as "this plugin ships no skills" — common for LSP / hook /
	 * MCP-only plugins. Other read errors are logged at warn and treated as empty
	 * so a single broken plugin doesn't black-hole the whole catalog.
	 */
	private async readSkillDirs(installPath: string): Promise<string[]> {
		const skillsRoot = path.join(installPath, "skills");
		try {
			const st = await stat(skillsRoot);
			if (!st.isDirectory()) return [];
		} catch {
			return [];
		}
		try {
			const entries = await readdir(skillsRoot, { withFileTypes: true });
			return entries.filter((e) => e.isDirectory()).map((e) => e.name);
		} catch (err) {
			log.warn(`failed to read ${skillsRoot}`, err);
			return [];
		}
	}
}

/**
 * Minimal YAML-frontmatter extractor for the five SKILL.md fields the deck
 * surfaces today. Mirrors the routes-slash-commands header-grep approach —
 * scalars + single-line inline arrays — to avoid pulling in a full YAML dep
 * for what is effectively five keys. Block-style arrays (`triggers:\n  - a`)
 * fall through as `undefined` for now; we can promote to a real parser when
 * a real SKILL.md needs it.
 */
function parseSkillFrontmatter(text: string, dirName: string): SkillFrontmatter {
	const fm: SkillFrontmatter = { name: dirName };
	if (!text.startsWith("---")) return fm;
	const end = text.indexOf("\n---", 3);
	if (end < 0) return fm;
	const block = text.slice(3, end);

	for (const rawLine of block.split(/\r?\n/)) {
		const line = rawLine.trimStart();
		if (!line || line.startsWith("#")) continue;
		const colon = line.indexOf(":");
		if (colon <= 0) continue;
		const key = line.slice(0, colon).trim().toLowerCase();
		let value = line.slice(colon + 1).trim();
		if (!value) continue;
		if (
			(value.startsWith('"') && value.endsWith('"')) ||
			(value.startsWith("'") && value.endsWith("'"))
		) {
			value = value.slice(1, -1);
		}
		switch (key) {
			case "name":
				fm.name = value;
				break;
			case "description":
				fm.description = value;
				break;
			case "model":
				fm.model = value;
				break;
			case "triggers": {
				const arr = parseInlineYamlArray(value);
				if (arr) fm.triggers = arr;
				break;
			}
			case "tags": {
				const arr = parseInlineYamlArray(value);
				if (arr) fm.tags = arr;
				break;
			}
		}
	}
	return fm;
}

function parseInlineYamlArray(value: string): string[] | undefined {
	if (!value.startsWith("[") || !value.endsWith("]")) return undefined;
	const inner = value.slice(1, -1).trim();
	if (!inner) return [];
	return inner
		.split(",")
		.map((seg) => {
			let v = seg.trim();
			if (
				(v.startsWith('"') && v.endsWith('"')) ||
				(v.startsWith("'") && v.endsWith("'"))
			) {
				v = v.slice(1, -1);
			}
			return v;
		})
		.filter((v) => v.length > 0);
}

// Re-export for tests / external callers without needing to import the file.
export type { SkillSummary, SkillFrontmatter, InstalledPluginInfo, ListSkillsResponse };
