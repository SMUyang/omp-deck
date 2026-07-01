import { useState, type ReactNode } from "react";
import type { ImagePreviewSource } from "./image-preview";
import { normalizePreviewImages } from "./image-preview";
import { ImageLightbox } from "./ImageLightbox";

interface ImagePreviewGridProps {
	images: readonly ImagePreviewSource[];
	altPrefix: string;
	thumbnailClassName?: string;
	containerClassName?: string;
}

export function ImagePreviewGrid({
	images,
	altPrefix,
	thumbnailClassName = "h-28 w-28 rounded border border-line object-cover",
	containerClassName = "flex flex-wrap gap-1.5",
}: ImagePreviewGridProps): ReactNode {
	const items = normalizePreviewImages(images, altPrefix);
	const [lightbox, setLightbox] = useState<number | null>(null);

	if (items.length === 0) return null;

	return (
		<>
			<div className={containerClassName}>
				{items.map((item, i) => (
					<button
						key={i}
						type="button"
						className="cursor-zoom-in overflow-hidden p-0 border-none bg-transparent"
						onClick={() => setLightbox(i)}
						aria-label={`Open ${item.alt}`}
					>
						<img src={item.src} alt={item.alt} className={thumbnailClassName} />
					</button>
				))}
			</div>
			{lightbox !== null ? (
				<ImageLightbox images={items} index={lightbox} onIndexChange={setLightbox} onClose={() => setLightbox(null)} />
			) : null}
		</>
	);
}
