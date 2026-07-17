import sharp, { type Metadata, type SharpInput } from 'sharp';

/** Anything sharp() itself accepts as an image source. */
export type ImageInput = SharpInput;

/** Corner the overlay is anchored to. Only 'bottom-right' ships in v1. */
export type CompositePosition = 'bottom-right';

export interface CompositeOverlayOptions {
  /** Overlay width as a percentage (0-100) of the base image's width. The overlay is always forced to a 1:1 square at this size. */
  widthPercent: number;
  /** Gap from the base image's edges, as a percentage of the base image's *width* (used for both the horizontal and vertical offset). */
  paddingPercent: number;
  /** @default 'bottom-right' */
  position?: CompositePosition;
}

export interface CompositeOverlayResult {
  buffer: Buffer;
  width: number;
  height: number;
}

export async function compositeOverlay(
  base: ImageInput,
  overlay: ImageInput,
  options: CompositeOverlayOptions,
): Promise<CompositeOverlayResult> {
  const { widthPercent, paddingPercent, position = 'bottom-right' } = options;

  // .rotate() auto-orients pixels from the EXIF tag and strips it from the
  // output; sharp's own metadata() always reports the pre-rotation (stored)
  // dimensions regardless, so the 5-8 "swapped axis" orientations need a
  // manual width/height swap to match what .rotate() will actually produce.
  const baseImage = sharp(base).rotate();
  const baseMetadata = await baseImage.metadata();
  const { width: baseWidth, height: baseHeight } = orientedSize(baseMetadata);
  if (!baseWidth || !baseHeight) {
    throw new Error('compositeOverlay: could not read base image dimensions');
  }

  const overlaySizePx = Math.round(baseWidth * (widthPercent / 100));
  if (!Number.isFinite(overlaySizePx) || overlaySizePx <= 0) {
    throw new Error(
      `compositeOverlay: widthPercent ${widthPercent} of base width ${baseWidth}px rounds to a non-positive overlay size`,
    );
  }
  const paddingPx = Math.round(baseWidth * (paddingPercent / 100));
  const { left, top } = resolveOffsets(position, baseWidth, baseHeight, overlaySizePx, paddingPx);

  const resizedOverlay = await sharp(overlay)
    .rotate()
    .resize(overlaySizePx, overlaySizePx, { fit: 'cover' })
    .toBuffer();

  const buffer = await baseImage.composite([{ input: resizedOverlay, left, top }]).png().toBuffer();

  return { buffer, width: baseWidth, height: baseHeight };
}

function orientedSize(metadata: Metadata): { width?: number; height?: number } {
  const { width, height, orientation } = metadata;
  const swapped = orientation !== undefined && orientation >= 5 && orientation <= 8;
  return swapped ? { width: height, height: width } : { width, height };
}

function resolveOffsets(
  position: CompositePosition,
  baseWidth: number,
  baseHeight: number,
  overlaySizePx: number,
  paddingPx: number,
): { left: number; top: number } {
  switch (position) {
    case 'bottom-right':
      return {
        left: baseWidth - overlaySizePx - paddingPx,
        top: baseHeight - overlaySizePx - paddingPx,
      };
    default: {
      const exhaustive: never = position;
      throw new Error(`compositeOverlay: unsupported position "${String(exhaustive)}"`);
    }
  }
}

export interface CompositeBatchItem {
  /** Caller-chosen identifier echoed back in the result (e.g. a filename or slug). */
  ref: string;
  image: ImageInput;
}

export interface CompositeBatchOptions extends CompositeOverlayOptions {
  /** Max number of composites running at once. @default 4 */
  concurrency?: number;
}

export interface CompositeBatchResult {
  baseRef: string;
  overlayRef: string;
  result: CompositeOverlayResult;
}

export async function compositeBatch(
  bases: CompositeBatchItem[],
  overlays: CompositeBatchItem[],
  options: CompositeBatchOptions,
): Promise<CompositeBatchResult[]> {
  const { concurrency = 4, ...overlayOptions } = options;
  if (!Number.isFinite(concurrency) || concurrency < 1) {
    throw new Error(`compositeBatch: concurrency must be a finite number >= 1, received ${concurrency}`);
  }

  const pairs: Array<{ base: CompositeBatchItem; overlay: CompositeBatchItem }> = [];
  for (const base of bases) {
    for (const overlay of overlays) {
      pairs.push({ base, overlay });
    }
  }

  const results: CompositeBatchResult[] = new Array(pairs.length);
  let cursor = 0;

  async function worker(): Promise<void> {
    while (cursor < pairs.length) {
      const index = cursor++;
      const { base, overlay } = pairs[index];
      const result = await compositeOverlay(base.image, overlay.image, overlayOptions);
      results[index] = { baseRef: base.ref, overlayRef: overlay.ref, result };
    }
  }

  const workerCount = Math.max(1, Math.min(Math.floor(concurrency), pairs.length));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  return results;
}
