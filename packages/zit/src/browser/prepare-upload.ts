/**
 * Client-side pre-upload pipeline:
 *
 * 1. If the file is HEIC/HEIF, transcode to JPEG using `heic2any`. On failure
 *    we keep the raw HEIC bytes so a later step (or the server) can still
 *    deal with it.
 * 2. Read EXIF with `exifr` — `DateTimeOriginal`/`CreateDate`/`ModifyDate`
 *    for `takenAt`, plus the raw `Orientation` tag.
 * 3. If the orientation tag says the image isn't already upright, bake the
 *    rotation into the pixels via canvas so the bytes leaving the browser
 *    need no further EXIF-orientation handling downstream.
 * 4. Decode the final bytes once to measure width/height.
 *
 * `exifr` and `heic2any` are optional peer dependencies and are always
 * dynamic-imported so this subpath never forces them into a consumer's
 * bundle unless the pipeline actually runs.
 */

import { deriveOrientation, type Orientation } from './orientation';
import { needsOrientationBake } from './exif-orientation';

const HEIC_MIME = /^image\/(heic|heif)$/i;
const HEIC_EXT = /\.(heic|heif)$/i;

export interface PrepareImageForUploadOptions {
  /** JPEG quality (0-1) used when transcoding HEIC/HEIF to JPEG. Default 0.9. */
  heicQuality?: number;
  /** JPEG quality (0-1) used when re-encoding after an orientation bake. Ignored for lossless output types. Default 0.92. */
  bakeQuality?: number;
}

export interface PreparedImage {
  /** The upload-ready bytes: JPEG when HEIC was transcoded or orientation was baked, otherwise the original file. */
  file: File | Blob;
  width: number;
  height: number;
  /** EXIF capture date, if present and parseable. */
  takenAt: Date | null;
  orientation: Orientation;
  transcodedFromHeic: boolean;
}

function isHeic(file: File): boolean {
  return HEIC_MIME.test(file.type) || HEIC_EXT.test(file.name);
}

async function transcodeHeicToJpeg(file: File, quality: number): Promise<Blob> {
  const { default: heic2any } = await import('heic2any');
  const result = await heic2any({ blob: file, toType: 'image/jpeg', quality });
  // heic2any may return Blob | Blob[] depending on the input.
  return Array.isArray(result) ? result[0] : result;
}

/**
 * @param includeOrientation Whether to also request+parse the `Orientation`
 *   tag. Skipped for a successfully-transcoded HEIC blob, since `heic2any`
 *   already bakes rotation into its JPEG output — re-checking orientation
 *   there would look at metadata that's no longer meaningful for those bytes.
 */
async function readExif(
  blob: Blob,
  includeOrientation: boolean,
): Promise<{ takenAt: Date | null; exifOrientation: number | undefined }> {
  try {
    const exifr = await import('exifr');
    const pick = includeOrientation
      ? ['DateTimeOriginal', 'CreateDate', 'ModifyDate', 'Orientation']
      : ['DateTimeOriginal', 'CreateDate', 'ModifyDate'];
    // exifr defaults to translateValues: true, which turns the numeric
    // Orientation tag into a human-readable string (e.g. "Rotate 90 CW").
    // Request raw values so the numeric check below actually matches.
    const data = await exifr.parse(blob, { pick, translateValues: false });
    const rawDate = data?.DateTimeOriginal ?? data?.CreateDate ?? data?.ModifyDate ?? null;
    let takenAt: Date | null = null;
    if (rawDate instanceof Date && !Number.isNaN(rawDate.getTime())) {
      takenAt = rawDate;
    } else if (typeof rawDate === 'string') {
      const parsed = new Date(rawDate);
      if (!Number.isNaN(parsed.getTime())) takenAt = parsed;
    }
    // Gate on `includeOrientation` explicitly (not just via `pick`) so a
    // stray Orientation field can never leak into the result when the
    // caller said it isn't meaningful for this blob (see the doc comment).
    const exifOrientation =
      includeOrientation && typeof data?.Orientation === 'number' ? data.Orientation : undefined;
    return { takenAt, exifOrientation };
  } catch {
    // exifr can throw on malformed/absent EXIF; that's expected.
    return { takenAt: null, exifOrientation: undefined };
  }
}

/**
 * User-facing error message emitted when a HEIC file failed `heic2any`
 * transcoding AND the browser also cannot decode the raw HEIC bytes for
 * dimensions (neither `createImageBitmap` nor `<img>` support HEIC
 * natively in most browsers). Exported so callers/tests can assert against
 * it without duplicating the wording.
 */
export const HEIC_DECODE_FAILED_MESSAGE =
  'Could not decode HEIC image — heic2any failed and the browser cannot decode HEIC natively. Try saving as JPEG and uploading again.';

/**
 * Prefix for the error thrown when EXIF said the image needs an orientation
 * bake but the bake itself failed (createImageBitmap/canvas/toBlob). We
 * throw rather than silently falling back to un-rotated bytes + a 0x0
 * placeholder — that would quietly violate the "stored originals are
 * upright" guarantee this pipeline exists to provide.
 */
export const ORIENTATION_BAKE_FAILED_MESSAGE_PREFIX = 'Could not bake image orientation: ';

async function decodeDimensions(blob: Blob): Promise<{ width: number; height: number }> {
  const url = URL.createObjectURL(blob);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error('Failed to decode image for dimensions'));
      el.src = url;
    });
    return { width: img.naturalWidth, height: img.naturalHeight };
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * Bake EXIF rotation into the pixels via canvas. Delegates the actual
 * rotate/flip math to `createImageBitmap(..., { imageOrientation:
 * 'from-image' })`, which every evergreen browser implements — this avoids
 * hand-rolling the 8-case EXIF orientation matrix ourselves.
 */
async function bakeOrientation(
  blob: Blob,
  outputMime: string,
  quality: number,
): Promise<{ blob: Blob; width: number; height: number }> {
  const bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' });
  try {
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2D canvas context is unavailable');
    ctx.drawImage(bitmap, 0, 0);
    // Preserve lossless output types; everything else re-encodes as JPEG.
    const mime = outputMime === 'image/png' || outputMime === 'image/webp' ? outputMime : 'image/jpeg';
    const outBlob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, mime, quality));
    if (!outBlob) throw new Error('Canvas toBlob produced no data');
    return { blob: outBlob, width: canvas.width, height: canvas.height };
  } finally {
    bitmap.close();
  }
}

export async function prepareImageForUpload(
  file: File,
  opts: PrepareImageForUploadOptions = {},
): Promise<PreparedImage> {
  const heicQuality = opts.heicQuality ?? 0.9;
  const bakeQuality = opts.bakeQuality ?? 0.92;

  // Step 1 — HEIC -> JPEG with graceful fallback to raw bytes.
  const fileIsHeic = isHeic(file);
  let blob: File | Blob = file;
  let transcodedFromHeic = false;
  if (fileIsHeic) {
    try {
      blob = await transcodeHeicToJpeg(file, heicQuality);
      transcodedFromHeic = true;
    } catch {
      // Keep raw HEIC bytes; the decode step below surfaces a clear error
      // if the browser also can't decode them.
    }
  }

  // Step 2 — EXIF. Always read the capture date from the ORIGINAL file:
  // heic2any strips all metadata from its JPEG output, so reading dates from
  // the transcoded blob would silently lose takenAt. Orientation is only
  // requested (and only meaningful) on non-transcoded bytes — see readExif's
  // doc comment.
  const { takenAt, exifOrientation } = transcodedFromHeic
    ? await readExif(file, false)
    : await readExif(blob, true);
  const orientationBakeNeeded = needsOrientationBake(exifOrientation);

  // Steps 3 & 4 — bake orientation (when needed) and measure final dimensions.
  let finalBlob: File | Blob;
  let width: number;
  let height: number;
  try {
    if (orientationBakeNeeded) {
      const baked = await bakeOrientation(blob, file.type, bakeQuality);
      finalBlob = baked.blob;
      width = baked.width;
      height = baked.height;
    } else {
      const dims = await decodeDimensions(blob);
      finalBlob = blob;
      width = dims.width;
      height = dims.height;
    }
  } catch (err) {
    if (fileIsHeic && !transcodedFromHeic) {
      // Raw HEIC bytes the browser cannot decode at all — fail loud instead
      // of silently committing a 0x0 placeholder.
      throw new Error(HEIC_DECODE_FAILED_MESSAGE);
    }
    if (orientationBakeNeeded) {
      // The bake was required (EXIF said the image isn't upright) but
      // failed — surface it instead of silently shipping un-rotated bytes
      // under a 0x0/"square" placeholder that pretends nothing is wrong.
      throw new Error(`${ORIENTATION_BAKE_FAILED_MESSAGE_PREFIX}${(err as Error).message}`);
    }
    // Defense in depth: a non-HEIC, no-bake-needed path that still fails to
    // decode is unexpected, but keeping a 0x0 placeholder preserves existing
    // behaviour for non-HEIC content; callers/servers validate dimensions.
    finalBlob = blob;
    width = 0;
    height = 0;
  }

  return {
    file: finalBlob,
    width,
    height,
    takenAt,
    orientation: deriveOrientation(width, height),
    transcodedFromHeic,
  };
}
