import { useEffect, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { createPortal } from "react-dom";
import { cn } from "@/lib/utils";

interface Props {
	open: boolean;
	onClose: () => void;
	children: ReactNode;
	/** Tailwind width class, e.g. `max-w-3xl`. Default is `max-w-2xl`. */
	widthClass?: string;
	/** Tailwind height class for the dialog. Default lets content size. */
	heightClass?: string;
	/** Click on the backdrop closes the modal. Default true. */
	dismissOnBackdrop?: boolean;
	/** Esc closes the modal. Default true. */
	dismissOnEscape?: boolean;
}

/**
 * Centered dialog with a backdrop. Portals to <body> so it isn't constrained
 * by any clipping ancestor in the layout. Used by Tasks for the task detail
 * view — preferred over the inspector slot when the editing flow is the main
 * focus of the interaction, not a side panel reference.
 */
export function Modal({
	open,
	onClose,
	children,
	widthClass = "max-w-2xl",
	heightClass = "max-h-[85vh]",
	dismissOnBackdrop = true,
	dismissOnEscape = true,
}: Props) {
	const { t } = useTranslation();
	useEffect(() => {
		if (!open || !dismissOnEscape) return;
		function onKey(e: KeyboardEvent): void {
			if (e.key === "Escape") {
				e.stopPropagation();
				onClose();
			}
		}
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [open, dismissOnEscape, onClose]);

	if (!open) return null;
	return createPortal(
		<div
			className="fixed inset-0 z-50 flex items-start justify-center px-4 py-[7vh]"
			role="dialog"
			aria-modal="true"
		>
			<button
				type="button"
				aria-label={t("settings.modal.close")}
				onClick={dismissOnBackdrop ? onClose : undefined}
				className="absolute inset-0 bg-ink/30 backdrop-blur-[1px]"
				tabIndex={-1}
			/>
			<div
				className={cn(
					"relative flex w-full flex-col overflow-hidden rounded-lg border border-line bg-paper shadow-[0_24px_64px_-16px_rgba(26,24,20,0.35)]",
					widthClass,
					heightClass,
				)}
				onClick={(e) => e.stopPropagation()}
			>
				{children}
			</div>
		</div>,
		document.body,
	);
}
