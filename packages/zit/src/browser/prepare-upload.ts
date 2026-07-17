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
 * ## Optional peer dependencies
 *
 * `exifr` and `heic2any` are optional peer dependencies and are always
 * dynamic-imported so this subpath never forces them into a consumer's
 * bundle unless the pipeline actually runs:
 *
 * - `exifr` enables EXIF reading — both the capture date (`takenAt`) and the
 *   orientation-bake guarantee. If it isn't installed the pipeline throws
 *   {@link MISSING_EXIFR_MESSAGE} rather than silently dropping metadata and
 *   shipping images the decoder still has to rotate on display.
 * - `heic2any` enables HEIC/HEIF decoding in the browser. If it isn't
 *   installed and a HEIC/HEIF file is submitted, the pipeline throws
 *   {@link MISSING_HEIC2ANY_MESSAGE} rather than misreporting the absence as a
 *   generic decode failure.
 */

import { deriveOrientation, type Orientation } from './orientation.js';
import { needsOrientationBake } from './exif-orientation.js';

const HEIC_MIME = /^image\/(heic|heif)$/i;
const HEIC_EXT = /\.(heic|heif)$/i;

/**
 * Conservative default cap on the pixel area of the bake canvas.
 *
 * Safari/iOS historically refuse to allocate canvases beyond ~16.7M pixels
 * (≈4096×4096 on older devices) and, rather than throwing, hand back a
 * silently blank canvas — so an uncapped full-resolution bake produces empty
 * output on exactly the devices that need orientation baking most. We downscale
 * to fit this budget instead. Override via `maxCanvasArea` when the target
 * environment is known to allow more.
 *
 * @see https://developer.mozilla.org/en-US/docs/Web/HTML/Element/canvas#maximum_canvas_size
 */
export const DEFAULT_MAX_CANVAS_AREA = 4096 * 4096;

/**
 * Thrown when a HEIC/HEIF file is submitted but the optional `heic2any` peer
 * dependency is not installed. Exported so callers/tests can assert against the
 * wording without duplicating it.
 */
export const MISSING_HEIC2ANY_MESSAGE = 'Install heic2any to decode HEIC in the browser';

/**
 * Thrown when the pipeline needs to read EXIF (always) but the optional `exifr`
 * peer dependency is not installed. `exifr` is required for every image — the
 * capture date is read even for plain JPEGs that need no orientation bake — so
 * the message names EXIF reading, not just baking. Exported so callers/tests
 * can assert against the wording without duplicating it.
 */
export const MISSING_EXIFR_MESSAGE =
  'Install exifr to enable EXIF reading (capture date + orientation baking)';

/**
 * Marks an error as "a required optional peer dependency is missing" so the
 * pipeline can distinguish it from an ordinary runtime failure (e.g. a HEIC
 * file `heic2any` is present for but cannot parse). Missing-peer errors always
 * propagate; ordinary failures may fall back gracefully.
 */
class MissingPeerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MissingPeerError';
  }
}

export interface PrepareImageForUploadOptions {
  /** JPEG quality (0-1) used when transcoding HEIC/HEIF to JPEG. Default 0.9. */
  heicQuality?: number;
  /**
   * Quality (0-1) used when re-encoding after an orientation bake. Applies to
   * every lossy output type this pipeline can emit — JPEG and WebP alike.
   * Default 0.92.
   */
  bakeQuality?: number;
  /**
   * Maximum pixel area (width × height) of the bake canvas. Inputs larger than
   * this are downscaled to fit before baking, so oversized images produce a
   * correctly-downscaled result instead of Safari's silently-blank output.
   * Default {@link DEFAULT_MAX_CANVAS_AREA}.
   */
  maxCanvasArea?: number;
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

/** File-name base (everything before the final extension), or the whole name if it has none. */
function stripExtension(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
}

const MIME_EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/heic': 'heic',
  'image/heif': 'heif',
};

function extensionForMime(mime: string): string {
  return MIME_EXTENSIONS[mime.toLowerCase()] ?? 'bin';
}

/**
 * Wrap a produced blob as a named `File` whose extension matches its ACTUAL
 * MIME type. The original file's name base is preserved; the extension is
 * derived by sniffing the blob's own `type` (never the requested output type),
 * so Safari's silent WebP→PNG substitution can't leave a `.webp` name on PNG
 * bytes. The original `File` is returned untouched when the pipeline produced
 * no new bytes.
 */
function toNamedFile(produced: File | Blob, originalName: string): File | Blob {
  if (produced instanceof File) return produced;
  const mime = produced.type || 'application/octet-stream';
  const name = `${stripExtension(originalName)}.${extensionForMime(mime)}`;
  return new File([produced], name, { type: mime });
}

async function transcodeHeicToJpeg(file: File, quality: number): Promise<Blob> {
  let heic2any: typeof import('heic2any').default;
  try {
    ({ default: heic2any } = await import('heic2any'));
  } catch {
    throw new MissingPeerError(MISSING_HEIC2ANY_MESSAGE);
  }
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
  let exifr: typeof import('exifr');
  try {
    exifr = await import('exifr');
  } catch {
    // A missing peer is a configuration error, not a per-file EXIF quirk —
    // surface it loudly instead of silently disabling orientation baking.
    throw new MissingPeerError(MISSING_EXIFR_MESSAGE);
  }
  try {
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
 *
 * The canvas is capped to `maxCanvasArea` pixels: above Safari/iOS canvas
 * limits an uncapped canvas comes back silently blank, so oversized inputs are
 * downscaled to fit. After encoding, the canvas is shrunk to 0×0 to hint the
 * (potentially large) backing store can be released promptly.
 */
async function bakeOrientation(
  blob: Blob,
  outputMime: string,
  quality: number,
  maxCanvasArea: number,
): Promise<{ blob: Blob; width: number; height: number }> {
  const bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' });
  try {
    let targetWidth = bitmap.width;
    let targetHeight = bitmap.height;
    const area = targetWidth * targetHeight;
    if (area > maxCanvasArea) {
      const scale = Math.sqrt(maxCanvasArea / area);
      targetWidth = Math.max(1, Math.floor(targetWidth * scale));
      targetHeight = Math.max(1, Math.floor(targetHeight * scale));
    }

    const canvas = document.createElement('canvas');
    canvas.width = targetWidth;
    canvas.height = targetHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2D canvas context is unavailable');
    ctx.drawImage(bitmap, 0, 0, targetWidth, targetHeight);
    // JPEG and WebP are both lossy encoders that honour `quality`; PNG (and
    // anything unknown) ignores it. Note Safari may silently substitute PNG
    // when asked for WebP — the produced blob's own `type` is the source of
    // truth for the output MIME, not this requested value.
    const mime = outputMime === 'image/png' || outputMime === 'image/webp' ? outputMime : 'image/jpeg';
    const outBlob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, mime, quality));
    if (!outBlob) throw new Error('Canvas toBlob produced no data');
    const width = canvas.width;
    const height = canvas.height;
    // Release the backing store: a full-resolution canvas can hold tens of MB.
    canvas.width = 0;
    canvas.height = 0;
    return { blob: outBlob, width, height };
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
  const maxCanvasArea = opts.maxCanvasArea ?? DEFAULT_MAX_CANVAS_AREA;

  // Step 1 — HEIC -> JPEG with graceful fallback to raw bytes. A missing
  // `heic2any` peer is NOT a graceful case: rethrow it so the caller gets a
  // named, actionable error instead of a misattributed decode failure below.
  const fileIsHeic = isHeic(file);
  let blob: File | Blob = file;
  let transcodedFromHeic = false;
  if (fileIsHeic) {
    try {
      blob = await transcodeHeicToJpeg(file, heicQuality);
      transcodedFromHeic = true;
    } catch (err) {
      if (err instanceof MissingPeerError) throw err;
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
      const baked = await bakeOrientation(blob, file.type, bakeQuality, maxCanvasArea);
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
    // Preserve the source name base and give the output an extension that
    // matches its ACTUAL MIME. Unchanged originals pass through untouched.
    file: toNamedFile(finalBlob, file.name),
    width,
    height,
    takenAt,
    orientation: deriveOrientation(width, height),
    transcodedFromHeic,
  };
}
