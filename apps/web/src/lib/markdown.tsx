/**
 * Markdown rendering — lightweight code highlighting.
 */

import { memo, type AnchorHTMLAttributes, type HTMLAttributes, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { rehypeHighlightLight } from "./rehype-highlight-light";
import { cn } from "./utils";
import { CopyButton } from "./CopyButton";

interface Props {
	children: string;
	className?: string;
	streaming?: boolean;
}

export const Markdown = memo(function Markdown({ children, className, streaming }: Props) {
	return (
		<div className={cn("markdown text-sm", streaming && "cursor-blink", className)}>
			<ReactMarkdown
				remarkPlugins={[remarkGfm]}
				rehypePlugins={[rehypeHighlightLight]}
				components={{ pre: CopyablePre, a: ExternalAnchor }}
			>
				{children}
			</ReactMarkdown>
		</div>
	);
});

function CopyablePre({ children, ...rest }: HTMLAttributes<HTMLPreElement> & { children?: ReactNode }) {
	return (
		<div className="group relative">
			<pre {...rest}>{children}</pre>
			<CopyButton />
		</div>
	);
}

function ExternalAnchor({ href, children, ...rest }: AnchorHTMLAttributes<HTMLAnchorElement>) {
	const external = typeof href === "string" && /^(https?:|mailto:)/i.test(href);
	return (
		<a
			{...rest}
			href={href}
			{...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
		>
			{children}
		</a>
	);
}
