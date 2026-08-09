/**
 * Custom rehype code-highlight plugin — uses lowlight's createLowlight
 * with a curated 13-language set, bypassing rehype-highlight's forced
 * 38-language `common` import. Saves ~300KB from the markdown vendor chunk.
 */

import { createLowlight } from "lowlight";
import { visit } from "unist-util-visit";
import { toString } from "hast-util-to-string";

import bash from "highlight.js/lib/languages/bash";
import javascript from "highlight.js/lib/languages/javascript";
import typescript from "highlight.js/lib/languages/typescript";
import json from "highlight.js/lib/languages/json";
import python from "highlight.js/lib/languages/python";
import shell from "highlight.js/lib/languages/shell";
import sql from "highlight.js/lib/languages/sql";
import yaml from "highlight.js/lib/languages/yaml";
import css from "highlight.js/lib/languages/css";
import diff from "highlight.js/lib/languages/diff";
import markdown from "highlight.js/lib/languages/markdown";
import xml from "highlight.js/lib/languages/xml";
import plaintext from "highlight.js/lib/languages/plaintext";

const lowlight = createLowlight({
	bash,
	javascript,
	typescript,
	json,
	python,
	shell,
	sql,
	yaml,
	css,
	diff,
	markdown,
	xml,
	plaintext,
});

/** Minimal HAST node shape used by the visitor. */
interface HastNode {
	type: string;
	tagName?: string;
	properties?: Record<string, unknown>;
	children?: unknown[];
}

/** Extract language from a code node's className (lang-x / language-x). */
function codeLanguage(node: HastNode): string | undefined {
	const className = node.properties?.className;
	if (!Array.isArray(className)) return undefined;
	for (const value of className) {
		const str = String(value);
		if (str.startsWith("language-")) return str.slice(9);
		if (str.startsWith("lang-")) return str.slice(5);
	}
	return undefined;
}

/**
 * Rehype plugin: highlight <pre><code> blocks with the curated language set.
 * Mirrors rehype-highlight's behavior (adds hljs- classes, replaces children).
 */
export function rehypeHighlightLight() {
	return (tree: HastNode) => {
		visit(tree as never, "element", (node: HastNode, _index, parent?: HastNode) => {
			if (
				node.tagName !== "code" ||
				!parent ||
				parent.type !== "element" ||
				parent.tagName !== "pre"
			) {
				return;
			}

			const lang = codeLanguage(node);
			const text = toString(node as never);

			// Only highlight known languages — skip unknown/plain text
			if (lang && lang !== "plaintext" && lang !== "text") {
				try {
					const result = lowlight.highlight(lang, text, { prefix: "hljs-" });
					if (result.children.length > 0) {
						const classes = Array.isArray(node.properties?.className)
							? [...(node.properties!.className as string[])]
							: [];
						if (!classes.includes("hljs")) classes.unshift("hljs");
						node.properties = { ...node.properties, className: classes };
						node.children = result.children as unknown[];
					}
				} catch {
					// Unknown language or highlight failure — leave as-is
				}
			}
		});
	};
}
