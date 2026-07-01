import { useEffect, type ReactNode } from "react";
import { ChevronLeft, ChevronRight, X } from "lucide-react";
import type { ImagePreviewItem } from "./image-preview";
import { nextImageIndex, previousImageIndex } from "./image-preview";

interface ImageLightboxProps {
	images: readonly ImagePreviewItem[];
	index: number;
	onIndexChange(index: number): void;
	onClose(): void;
}

export function ImageLightbox({ images, index, onIndexChange, onClose }: ImageLightboxProps): ReactNode {
	const clamped = Math.max(0, Math.min(index, images.length - 1));

	useEffect(() => {
		if (images.length === 0) return;
		const handleKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				onClose();
			} else if (e.key === "ArrowLeft") {
				e.preventDefault();
				onIndexChange(previousImageIndex(clamped, images.length));
			} else if (e.key === "ArrowRight") {
				e.preventDefault();
				onIndexChange(nextImageIndex(clamped, images.length));
			}
		};
		window.addEventListener("keydown", handleKey);
		return () => window.removeEventListener("keydown", handleKey);
	}, [clamped, images.length, onClose, onIndexChange]);

	if (images.length === 0) return null;

	const current = images[clamped];
	if (!current) return null;

	return (
		<div
			className="fixed inset-0 z-50 flex items-center justify-center bg-black/85"
			onClick={(e) => {
				if (e.target === e.currentTarget) onClose();
			}}
		>
			<button
				type="button"
				className="absolute top-4 right-4 rounded-full bg-white/10 p-2 text-white hover:bg-white/20"
				onClick={onClose}
				aria-label="Close preview"
			>
				<X className="h-5 w-5" />
			</button>

			<div className="absolute top-4 left-4 rounded bg-white/10 px-3 py-1 font-mono text-sm text-white">
				{images.length > 1 ? `${clamped + 1} / ${images.length}` : null}
			</div>

			{images.length > 1 ? (
				<button
					type="button"
					className="absolute left-4 rounded-full bg-white/10 p-2 text-white hover:bg-white/20"
					onClick={(e) => {
						e.stopPropagation();
						onIndexChange(previousImageIndex(clamped, images.length));
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

			{images.length > 1 ? (
				<button
					type="button"
					className="absolute right-4 rounded-full bg-white/10 p-2 text-white hover:bg-white/20"
					onClick={(e) => {
						e.stopPropagation();
						onIndexChange(nextImageIndex(clamped, images.length));
					}}
					aria-label="Next image"
				>
					<ChevronRight className="h-6 w-6" />
				</button>
			) : null}
		</div>
	);
}
