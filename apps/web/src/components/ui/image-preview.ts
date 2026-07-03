export interface ImagePreviewSource {
	data: string;
	mimeType?: string;
}

export interface ImagePreviewItem {
	src: string;
	alt: string;
}

const OMP_BLOB_REF_RE = /^blob:sha256:([a-f0-9]{64})$/i;
const DATA_IMAGE_URL_RE = /^data:image\/[a-z0-9.+-]+;base64,/i;

export function imageSrc(image: ImagePreviewSource): string {
	const data = image.data.trim();
	if (DATA_IMAGE_URL_RE.test(data)) return data;
	const blobMatch = data.match(OMP_BLOB_REF_RE);
	if (blobMatch) {
		const mimeType = encodeURIComponent(image.mimeType || "image/png");
		return `/api/agent-blobs/${blobMatch[1]!.toLowerCase()}?mimeType=${mimeType}`;
	}
	return `data:${image.mimeType || "image/png"};base64,${image.data}`;
}

export function normalizePreviewImages(
	images: readonly ImagePreviewSource[],
	altPrefix: string,
): ImagePreviewItem[] {
	const valid = images.filter((image) => image.data.trim().length > 0);
	if (valid.length === 1) return [{ src: imageSrc(valid[0]!), alt: altPrefix }];
	return valid.map((image, index) => ({
		src: imageSrc(image),
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
