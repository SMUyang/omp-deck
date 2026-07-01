export interface ImagePreviewSource {
	data: string;
	mimeType?: string;
}

export interface ImagePreviewItem {
	src: string;
	alt: string;
}

export function imageDataUrl(image: ImagePreviewSource): string {
	return `data:${image.mimeType || "image/png"};base64,${image.data}`;
}

export function normalizePreviewImages(
	images: readonly ImagePreviewSource[],
	altPrefix: string,
): ImagePreviewItem[] {
	const valid = images.filter((image) => image.data.trim().length > 0);
	if (valid.length === 1) return [{ src: imageDataUrl(valid[0]!), alt: altPrefix }];
	return valid.map((image, index) => ({
		src: imageDataUrl(image),
		alt: `${altPrefix} ${index + 1} of ${valid.length}`,
	}));
}

export function clampImageIndex(index: number, imageCount: number): number {
	if (imageCount <= 0) return 0;
	if (index < 0) return 0;
	if (index >= imageCount) return imageCount - 1;
	return index;
}

export function previousImageIndex(index: number, imageCount: number): number {
	if (imageCount <= 0) return 0;
	return (index - 1 + imageCount) % imageCount;
}

export function nextImageIndex(index: number, imageCount: number): number {
	if (imageCount <= 0) return 0;
	return (index + 1) % imageCount;
}
