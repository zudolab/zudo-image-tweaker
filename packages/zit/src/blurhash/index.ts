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

/**
 * Encode an image into a blurhash string. Downsamples the source with sharp,
 * then feeds the raw RGBA pixels to the blurhash algorithm.
 */
export async function encodeImageToBlurhash(
  input: SharpInput,
  options: EncodeImageToBlurhashOptions = {},
): Promise<string> {
  const { componentsX = 4, componentsY = 4, rawSize = 32 } = options;

  const { data, info } = await sharp(input)
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
  const { chunkSize = 20 } = options;

  const results: string[] = [];
  for (let i = 0; i < hashes.length; i += chunkSize) {
    const chunk = hashes.slice(i, i + chunkSize);
    const decoded = await Promise.all(chunk.map((hash) => blurhashToDataUri(hash)));
    results.push(...decoded);
  }
  return results;
}
