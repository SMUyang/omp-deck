/**
 * Floating Copy button overlaid on a `<pre>` block.
 *
 * Renders absolute-positioned in the top-right of its nearest positioned
 * ancestor (the caller wraps with `group relative`). Hidden by default; opacity
 * snaps to 1 on `group-hover` or `focus-visible` so keyboard users can reach
 * it. Click writes to the system clipboard and the label flashes `Copied` for
 * ~1.2s, then resets.
 *
 * Source text: explicit `text` prop (string or lazy producer) when the caller
 * already has the raw string; otherwise the button walks up to its parent and
 * grabs `textContent` of the nearest `<pre>`. The explicit path is preferred
 * for tools like `edit` whose rendered `<pre>` interleaves per-line divs that
 * don't round-trip cleanly through textContent.
 *
 * Fallback path: `navigator.clipboard.writeText` is the modern API; on
 * non-secure contexts (older browsers, sandboxed iframes) we fall back to a
 * hidden textarea + `document.execCommand('copy')`. Both routes set the
 * button state to `ok` or `err`; an `err` flashes `Copy failed` so the user
 * isn't lied to.
 */

import { useState, type ButtonHTMLAttributes, type MouseEvent } from "react";
import { Check, Copy, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "./utils";

type State = "idle" | "ok" | "err";

interface Props extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children" | "onClick"> {
	/** Raw text to copy. If omitted, the button reads textContent of the nearest sibling `<pre>`. */
	text?: string | (() => string);
	className?: string;
}

export function CopyButton({ text, className, ...buttonProps }: Props) {
	const { t } = useTranslation();
	const [state, setState] = useState<State>("idle");

	async function onCopy(e: MouseEvent<HTMLButtonElement>) {
		e.stopPropagation();
		const btn = e.currentTarget;
		let value = "";
		if (typeof text === "string") value = text;
		else if (typeof text === "function") value = text();
		else {
			const parent = btn.parentElement;
			value = parent?.querySelector("pre")?.textContent ?? "";
		}

		const ok = await writeClipboard(value);
		setState(ok ? "ok" : "err");
		window.setTimeout(() => setState("idle"), 1200);
	}

	const label =
		state === "ok"
			? t("core.copyButton.copied")
			: state === "err"
				? t("core.copyButton.copyFailed")
				: t("core.copyButton.copy");
	const Icon = state === "ok" ? Check : state === "err" ? X : Copy;

	return (
		<button
			type="button"
			onClick={onCopy}
			aria-label={label}
			title={label}
			className={cn(
				"absolute right-1.5 top-1.5 z-10",
				"inline-flex items-center gap-1 rounded border px-1.5 py-0.5",
				"font-mono text-2xs uppercase tracking-meta",
				"bg-paper-2 border-line text-ink-3",
				"opacity-0 transition-opacity duration-100",
				"group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100",
				"hover:bg-paper-3 hover:text-ink",
				"focus:outline-none focus-visible:ring-1 focus-visible:ring-accent",
				state === "ok" && "border-success text-success",
				state === "err" && "border-danger text-danger",
				className,
			)}
			{...buttonProps}
		>
			<Icon size={12} aria-hidden />
			<span>{label}</span>
		</button>
	);
}

async function writeClipboard(value: string): Promise<boolean> {
	if (!value) return false;
	if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
		try {
			await navigator.clipboard.writeText(value);
			return true;
		} catch {
			// Permission denied / non-secure context — fall through to legacy path.
		}
	}
	try {
		const ta = document.createElement("textarea");
		ta.value = value;
		ta.setAttribute("readonly", "");
		ta.style.position = "fixed";
		ta.style.top = "0";
		ta.style.left = "0";
		ta.style.opacity = "0";
		document.body.appendChild(ta);
		ta.select();
		const ok = document.execCommand("copy");
		document.body.removeChild(ta);
		return ok;
	} catch {
		return false;
	}
}
