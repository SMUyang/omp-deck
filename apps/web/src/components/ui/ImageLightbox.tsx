import { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ChevronLeft, ChevronRight, X } from "lucide-react";
import type { ImagePreviewItem } from "./image-preview";
import { nextImageIndex, previousImageIndex } from "./image-preview";

interface ImageLightboxProps {
	images: readonly ImagePreviewItem[];
	index: number;
	onIndexChange(index: number): void;
	onClose(): void;
}

const FOCUSABLE_SELECTOR =
	'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

export function ImageLightbox({ images, index, onIndexChange, onClose }: ImageLightboxProps): ReactNode {
	const imageCount = images.length;
	const clamped = Math.max(0, Math.min(index, imageCount - 1));
	const current = imageCount > 0 ? images[clamped] : undefined;

	const rootRef = useRef<HTMLDivElement>(null);
	const closeButtonRef = useRef<HTMLButtonElement>(null);

	useEffect(() => {
		if (imageCount === 0) return;
		const handleKey = (e: KeyboardEvent) => {
			switch (e.key) {
				case "Escape": {
					onClose();
					break;
				}
				case "ArrowLeft": {
					if (imageCount > 1) {
						e.preventDefault();
						onIndexChange(previousImageIndex(clamped, imageCount));
					}
					break;
				}
				case "ArrowRight": {
					if (imageCount > 1) {
						e.preventDefault();
						onIndexChange(nextImageIndex(clamped, imageCount));
					}
					break;
				}
				case "Tab": {
					const root = rootRef.current;
					if (!root) break;
					const focusable = root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR);
					if (focusable.length === 0) break;
					const first = focusable[0]!;
					const last = focusable[focusable.length - 1]!;
					if (e.shiftKey) {
						if (document.activeElement === first) {
							e.preventDefault();
							last.focus();
						}
					} else if (document.activeElement === last) {
						e.preventDefault();
						first.focus();
					}
					break;
				}
			}
		};
		window.addEventListener("keydown", handleKey);
		return () => window.removeEventListener("keydown", handleKey);
	}, [clamped, imageCount, onClose, onIndexChange]);

	useEffect(() => {
		if (imageCount === 0) return;
		const previousActive =
			document.activeElement instanceof HTMLElement ? document.activeElement : null;
		const previousOverflow = document.body.style.overflow;
		document.body.style.overflow = "hidden";
		if (closeButtonRef.current) {
			closeButtonRef.current.focus();
		} else if (rootRef.current) {
			rootRef.current.focus();
		}
		return () => {
			document.body.style.overflow = previousOverflow;
			if (previousActive && document.body.contains(previousActive)) {
				previousActive.focus();
			}
		};
	}, [imageCount]);

	if (imageCount === 0 || !current) return null;

	return createPortal(
		<div
			ref={rootRef}
			tabIndex={-1}
			className="fixed inset-0 z-50 flex items-center justify-center bg-black/85"
			role="dialog"
			aria-modal="true"
			onClick={(e) => {
				if (e.target === e.currentTarget) onClose();
			}}
		>
			<button
				ref={closeButtonRef}
				type="button"
				className="absolute top-4 right-4 rounded-full bg-white/10 p-2 text-white hover:bg-white/20"
				onClick={onClose}
				aria-label="Close preview"
			>
				<X className="h-5 w-5" />
			</button>

			{imageCount > 1 ? (
				<div className="absolute top-4 left-4 rounded bg-white/10 px-3 py-1 font-mono text-sm text-white">
					{`${clamped + 1} / ${imageCount}`}
				</div>
			) : null}

			{imageCount > 1 ? (
				<button
					type="button"
					className="absolute left-4 rounded-full bg-white/10 p-2 text-white hover:bg-white/20"
					onClick={(e) => {
						e.stopPropagation();
						onIndexChange(previousImageIndex(clamped, imageCount));
					}}
					aria-label="Previous image"
				>
					<ChevronLeft className="h-6 w-6" />
				</button>
			) : null}

			<img
				src={current.src}
				alt={current.alt}
				className="max-w-[95vw] max-h-[90vh] object-contain"
				onClick={(e) => e.stopPropagation()}
			/>

			{imageCount > 1 ? (
				<button
					type="button"
					className="absolute right-4 rounded-full bg-white/10 p-2 text-white hover:bg-white/20"
					onClick={(e) => {
						e.stopPropagation();
						onIndexChange(nextImageIndex(clamped, imageCount));
					}}
					aria-label="Next image"
				>
					<ChevronRight className="h-6 w-6" />
				</button>
			) : null}
		</div>,
		document.body,
	);
}
