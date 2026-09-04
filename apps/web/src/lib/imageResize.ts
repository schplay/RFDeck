// Shrink a chosen photo before it is uploaded.
//
// A phone camera produces several megabytes; a headshot needs a few hundred
// kilobytes. Resizing here means the server stores no full-resolution images,
// needs no imaging library to build on a bare Ubuntu box, and the upload is
// small enough to travel as JSON rather than requiring a multipart dependency.

/** Long edge of the stored headshot. Enough to recognise someone backstage. */
export const MAX_DIMENSION = 512;
const JPEG_QUALITY = 0.85;

export interface ResizedImage {
  /** `data:image/jpeg;base64,…`, ready to POST. */
  dataUrl: string;
  width: number;
  height: number;
  approxBytes: number;
}

export async function resizeImageFile(
  file: File,
  maxDimension = MAX_DIMENSION,
): Promise<ResizedImage> {
  if (!file.type.startsWith('image/')) {
    throw new Error('That file is not an image.');
  }

  const bitmap = await loadBitmap(file);
  try {
    const scale = Math.min(1, maxDimension / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('This browser could not process the image.');
    ctx.drawImage(bitmap, 0, 0, width, height);

    // JPEG regardless of input: a headshot has no transparency to preserve,
    // and PNG of a photograph is several times larger for no benefit.
    const dataUrl = canvas.toDataURL('image/jpeg', JPEG_QUALITY);
    const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
    return { dataUrl, width, height, approxBytes: Math.round(base64.length * 0.75) };
  } finally {
    // createImageBitmap allocates outside the JS heap; an <img> fallback does not.
    if ('close' in bitmap) (bitmap as ImageBitmap).close();
  }
}

// createImageBitmap handles EXIF orientation and is faster, but is not
// everywhere; the <img> path is the fallback.
async function loadBitmap(file: File): Promise<ImageBitmap | HTMLImageElement> {
  if (typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(file, { imageOrientation: 'from-image' } as any);
    } catch { /* fall through */ }
  }

  const url = URL.createObjectURL(file);
  try {
    return await new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('That image could not be read.'));
      img.src = url;
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}
