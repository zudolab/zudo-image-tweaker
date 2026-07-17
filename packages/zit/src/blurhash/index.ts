import { decode, encode } from 'blurhash';
import sharp, { type SharpInput } from 'sharp';

export interface EncodeImageToBlurhashOptions {
  /** Horizontal component count passed to the blurhash algorithm. */
  componentsX?: number;
  /** Vertical component count passed to the blurhash algorithm. */
  componentsY?: number;
  /** Size (both dimensions) the source is downsampled to before encoding. */
  rawSize?: number;
}

// blurhash's own encoding scheme packs component counts into a single
// base83 size flag, which only has room for 1-9 per axis.
const MIN_COMPONENTS = 1;
const MAX_COMPONENTS = 9;

function assertValidComponentCount(value: number, label: string): void {
  if (!Number.isInteger(value) || value < MIN_COMPONENTS || value > MAX_COMPONENTS) {
    throw new Error(
      `encodeImageToBlurhash: ${label} must be an integer between ${MIN_COMPONENTS} and ${MAX_COMPONENTS}, got ${value}`,
    );
  }
}

/**
 * Encode an image into a blurhash string. Downsamples the source with sharp,
 * then feeds the raw RGBA pixels to the blurhash algorithm.
 */
export async function encodeImageToBlurhash(
  input: SharpInput,
  options: EncodeImageToBlurhashOptions = {},
): Promise<string> {
  const { componentsX = 4, componentsY = 4, rawSize = 32 } = options;
  assertValidComponentCount(componentsX, 'componentsX');
  assertValidComponentCount(componentsY, 'componentsY');

  const { data, info } = await sharp(input)
    .rotate() // auto-orient per EXIF before hashing, so the hash matches the visually upright image
    .raw()
    .ensureAlpha()
    .resize(rawSize, rawSize, { fit: 'inside' })
    .toBuffer({ resolveWithObject: true });

  return encode(new Uint8ClampedArray(data), info.width, info.height, componentsX, componentsY);
}

export interface BlurhashToDataUriOptions {
  /** Output width and height, in pixels, of the decoded PNG. */
  size?: number;
}

/**
 * Decode a blurhash string into a tiny PNG data URI, suitable for use as a
 * placeholder while the full image loads.
 */
export async function blurhashToDataUri(
  hash: string,
  options: BlurhashToDataUriOptions = {},
): Promise<string> {
  const { size = 16 } = options;
  // A 0/negative/fractional size flows straight into `decode` and sharp's
  // raw buffer dimensions, where it surfaces as an opaque sharp error rather
  // than a named validation failure — guard it explicitly, mirroring
  // batchBlurhashToDataUri's chunkSize and calibrate's patchSize guards.
  if (!Number.isInteger(size) || size <= 0) {
    throw new Error(`blurhashToDataUri: size must be a positive integer, got ${size}`);
  }

  const pixels = decode(hash, size, size);
  const pngBuffer = await sharp(Buffer.from(pixels), {
    raw: { width: size, height: size, channels: 4 },
  })
    .png({ compressionLevel: 9 })
    .toBuffer();

  return `data:image/png;base64,${pngBuffer.toString('base64')}`;
}

export interface BatchBlurhashToDataUriOptions {
  /** Number of hashes decoded concurrently per batch. */
  chunkSize?: number;
  /** Output width and height, in pixels, of each decoded PNG. */
  size?: number;
}

/**
 * Decode many blurhash strings into PNG data URIs, processing them in
 * chunks so a large batch doesn't spawn unbounded concurrent sharp work.
 * Output order matches the input order.
 */
export async function batchBlurhashToDataUri(
  hashes: string[],
  options: BatchBlurhashToDataUriOptions = {},
): Promise<string[]> {
  const { chunkSize = 20, size } = options;
  if (!Number.isInteger(chunkSize) || chunkSize < 1) {
    throw new Error(`batchBlurhashToDataUri: chunkSize must be a positive integer, got ${chunkSize}`);
  }

  const results: string[] = [];
  for (let i = 0; i < hashes.length; i += chunkSize) {
    const chunk = hashes.slice(i, i + chunkSize);
    const decoded = await Promise.all(chunk.map((hash) => blurhashToDataUri(hash, { size })));
    results.push(...decoded);
  }
  return results;
}
