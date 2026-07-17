import { isBlurhashValid } from 'blurhash';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { batchBlurhashToDataUri, blurhashToDataUri, encodeImageToBlurhash } from './index.js';

const PNG_DATA_URI_PREFIX = 'data:image/png;base64,';
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** A small synthetic RGB image (a red/blue gradient) as PNG bytes. */
async function syntheticImage(width = 64, height = 48): Promise<Buffer> {
  const channels = 3;
  const raw = Buffer.alloc(width * height * channels);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * channels;
      raw[i] = Math.floor((x / width) * 255); // R
      raw[i + 1] = 0; // G
      raw[i + 2] = Math.floor((y / height) * 255); // B
    }
  }
  return sharp(raw, { raw: { width, height, channels } }).png().toBuffer();
}

function dataUriToPngBuffer(dataUri: string): Buffer {
  return Buffer.from(dataUri.slice(PNG_DATA_URI_PREFIX.length), 'base64');
}

describe('encodeImageToBlurhash', () => {
  it('encodes a synthetic image into a valid blurhash string', async () => {
    const image = await syntheticImage();
    const hash = await encodeImageToBlurhash(image);

    expect(typeof hash).toBe('string');
    expect(isBlurhashValid(hash).result).toBe(true);
  });

  it('respects componentsX/componentsY (longer hash for more components)', async () => {
    const image = await syntheticImage();
    const small = await encodeImageToBlurhash(image, { componentsX: 3, componentsY: 3 });
    const large = await encodeImageToBlurhash(image, { componentsX: 6, componentsY: 6 });

    expect(isBlurhashValid(small).result).toBe(true);
    expect(isBlurhashValid(large).result).toBe(true);
    expect(large.length).toBeGreaterThan(small.length);
  });
});

describe('blurhashToDataUri', () => {
  it('round-trips an encoded image into a PNG data URI of the requested size', async () => {
    const image = await syntheticImage();
    const hash = await encodeImageToBlurhash(image);

    const dataUri = await blurhashToDataUri(hash);
    expect(dataUri.startsWith(PNG_DATA_URI_PREFIX)).toBe(true);

    const pngBuffer = dataUriToPngBuffer(dataUri);
    expect(pngBuffer.subarray(0, 8)).toEqual(PNG_SIGNATURE);

    const metadata = await sharp(pngBuffer).metadata();
    expect(metadata.format).toBe('png');
    expect(metadata.width).toBe(16);
    expect(metadata.height).toBe(16);
  });

  it('honours a custom size option', async () => {
    const image = await syntheticImage();
    const hash = await encodeImageToBlurhash(image);

    const dataUri = await blurhashToDataUri(hash, { size: 8 });
    const metadata = await sharp(dataUriToPngBuffer(dataUri)).metadata();
    expect(metadata.width).toBe(8);
    expect(metadata.height).toBe(8);
  });
});

describe('batchBlurhashToDataUri', () => {
  it('decodes multiple hashes, preserving input order', async () => {
    const imageA = await syntheticImage(64, 48);
    const imageB = await syntheticImage(48, 64);
    const [hashA, hashB] = await Promise.all([
      encodeImageToBlurhash(imageA),
      encodeImageToBlurhash(imageB),
    ]);

    const [expectedA, expectedB, actual] = await Promise.all([
      blurhashToDataUri(hashA),
      blurhashToDataUri(hashB),
      batchBlurhashToDataUri([hashA, hashB]),
    ]);

    expect(actual).toEqual([expectedA, expectedB]);
  });

  it('processes hashes across multiple chunks when chunkSize is smaller than the input', async () => {
    const image = await syntheticImage();
    const hash = await encodeImageToBlurhash(image);
    const hashes = Array.from({ length: 5 }, () => hash);

    const results = await batchBlurhashToDataUri(hashes, { chunkSize: 2 });

    expect(results).toHaveLength(5);
    for (const dataUri of results) {
      expect(dataUri.startsWith(PNG_DATA_URI_PREFIX)).toBe(true);
    }
  });

  it('returns an empty array for an empty input', async () => {
    expect(await batchBlurhashToDataUri([])).toEqual([]);
  });
});
