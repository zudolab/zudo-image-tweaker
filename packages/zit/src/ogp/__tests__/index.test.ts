import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { generateOgpFromLandscape, generateOgpImage, generateSmartOgp } from '../index.js';

async function createSolidImage(
  width: number,
  height: number,
  background: { r: number; g: number; b: number } = { r: 120, g: 140, b: 200 },
): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background } })
    .jpeg()
    .toBuffer();
}

async function createGradientImage(width: number, height: number): Promise<Buffer> {
  const svg = `
    <svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="g" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="#4facfe" />
          <stop offset="100%" stop-color="#00f2fe" />
        </linearGradient>
      </defs>
      <rect width="${width}" height="${height}" fill="url(#g)" />
    </svg>
  `;
  return sharp(Buffer.from(svg)).jpeg().toBuffer();
}

// EXIF orientation 6 stores the pixel matrix rotated 90deg from how it should
// display; a `storedWidth`x`storedHeight` buffer with this tag displays as
// `storedHeight`x`storedWidth`.
async function createSolidImageWithOrientation6(
  storedWidth: number,
  storedHeight: number,
): Promise<Buffer> {
  return sharp({
    create: { width: storedWidth, height: storedHeight, channels: 3, background: { r: 90, g: 160, b: 130 } },
  })
    .jpeg()
    .withMetadata({ orientation: 6 })
    .toBuffer();
}

describe('generateOgpImage', () => {
  it('composites a square card onto a blurred background at the default 1200x630 canvas', async () => {
    const input = await createSolidImage(1000, 1000);
    const result = await generateOgpImage(input);

    expect(result.format).toBe('jpeg');
    expect(result.width).toBe(1200);
    expect(result.height).toBe(630);
    expect(result.path).toBeUndefined();

    const metadata = await sharp(result.buffer).metadata();
    expect(metadata.format).toBe('jpeg');
    expect(metadata.width).toBe(1200);
    expect(metadata.height).toBe(630);
  });

  it('honors a custom canvas and foreground size', async () => {
    const input = await createGradientImage(900, 1400);
    const result = await generateOgpImage(input, { width: 800, height: 400, foregroundSize: 300 });

    expect(result.width).toBe(800);
    expect(result.height).toBe(400);
  });

  it('executes the rounded-corner mask path when cornerRadius is set', async () => {
    const input = await createSolidImage(800, 800);
    const result = await generateOgpImage(input, { cornerRadius: 40 });

    expect(result.format).toBe('jpeg');
    expect(result.width).toBe(1200);
    expect(result.height).toBe(630);
  });

  it('caps the default foreground size to fit a custom canvas smaller than 600px', async () => {
    const input = await createSolidImage(900, 1400);
    const result = await generateOgpImage(input, { width: 600, height: 315 });

    expect(result.format).toBe('jpeg');
    expect(result.width).toBe(600);
    expect(result.height).toBe(315);
  });

  it('writes to outPath and carries path in the result when provided', async () => {
    const input = await createSolidImage(1000, 1000);
    const dir = await mkdtemp(join(tmpdir(), 'zit-ogp-'));
    const outPath = join(dir, 'ogp.jpg');

    try {
      const result = await generateOgpImage(input, { outPath });
      expect(result.path).toBe(outPath);

      const written = await readFile(outPath);
      expect(written.subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('generateOgpFromLandscape', () => {
  it('cover-crops a landscape source to the default 1200x630 canvas', async () => {
    const input = await createSolidImage(2400, 1000);
    const result = await generateOgpFromLandscape(input);

    expect(result.format).toBe('jpeg');
    expect(result.width).toBe(1200);
    expect(result.height).toBe(630);
    expect(result.path).toBeUndefined();
  });

  it('honors a custom canvas size', async () => {
    const input = await createGradientImage(1800, 700);
    const result = await generateOgpFromLandscape(input, { width: 600, height: 315 });

    expect(result.width).toBe(600);
    expect(result.height).toBe(315);
  });
});

describe('generateSmartOgp', () => {
  it('dispatches wide sources to the landscape branch', async () => {
    const input = await createSolidImage(2000, 900); // aspect ratio ~2.22, above default threshold
    const result = await generateSmartOgp(input);

    expect(result.method).toBe('landscape');
    expect(result.format).toBe('jpeg');
    expect(result.width).toBe(1200);
    expect(result.height).toBe(630);
  });

  it('dispatches square and portrait sources to the composite branch', async () => {
    const square = await generateSmartOgp(await createSolidImage(1000, 1000));
    expect(square.method).toBe('composite');

    const portrait = await generateSmartOgp(await createGradientImage(900, 1200));
    expect(portrait.method).toBe('composite');
  });

  it('honors a custom landscapeThreshold', async () => {
    const input = await createSolidImage(1000, 900); // aspect ratio ~1.11

    const withDefaultThreshold = await generateSmartOgp(input);
    expect(withDefaultThreshold.method).toBe('composite');

    const withLoweredThreshold = await generateSmartOgp(input, { landscapeThreshold: 1 });
    expect(withLoweredThreshold.method).toBe('landscape');
  });

  it('dispatches on the EXIF auto-oriented aspect ratio, not the raw stored pixel matrix', async () => {
    // Stored as 1600x900 (landscape) but tagged orientation 6, so it displays
    // as a 900x1600 portrait — must dispatch to the composite branch.
    const input = await createSolidImageWithOrientation6(1600, 900);
    const result = await generateSmartOgp(input);

    expect(result.method).toBe('composite');
  });
});
