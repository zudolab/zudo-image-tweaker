import { describe, expect, it } from 'vitest';
import sharp from 'sharp';

// Validates the native sharp/libvips install from day one — this must run
// on every CI Node version in the matrix (see .github/workflows/ci.yml),
// not just typecheck cleanly. Exercises a real transform: a raw pixel
// buffer through resize into an encoded PNG buffer.
describe('sharp smoke test', () => {
  it('resizes a raw RGB pixel buffer and encodes it as a PNG buffer', async () => {
    const width = 4;
    const height = 4;
    const channels = 3;
    const raw = Buffer.alloc(width * height * channels);
    for (let i = 0; i < raw.length; i += channels) {
      raw[i] = 255; // R
      raw[i + 1] = 0; // G
      raw[i + 2] = 0; // B
    }

    const png = await sharp(raw, { raw: { width, height, channels } })
      .resize(2, 2)
      .png()
      .toBuffer();

    const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(png.subarray(0, 8)).toEqual(pngSignature);

    const metadata = await sharp(png).metadata();
    expect(metadata.format).toBe('png');
    expect(metadata.width).toBe(2);
    expect(metadata.height).toBe(2);
  });
});
