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

describe('generateOgpImage: foregroundSize validation', () => {
  it('throws a descriptive error when foregroundSize exceeds the canvas limit', async () => {
    const input = await createSolidImage(1000, 1000);

    await expect(
      generateOgpImage(input, { width: 600, height: 315, foregroundSize: 700 }),
    ).rejects.toThrow(/foregroundSize \(700\).*exceeds.*315/i);
  });

  it('allows a foregroundSize equal to the canvas limit', async () => {
    const input = await createSolidImage(1000, 1000);

    const result = await generateOgpImage(input, { width: 600, height: 315, foregroundSize: 315 });
    expect(result.width).toBe(600);
    expect(result.height).toBe(315);
  });
});

// Pixel-level assertions (issue #55): the tests above only check
// dimensions/format, so a blank/broken five-layer composite would pass all
// of them. These assert actual pixel colours with solid-color inputs to
// confirm the layers are genuinely stacked. Pattern reference:
// src/calibrate/__tests__/calibrate.test.ts (readRawRgb/pixelAt).
describe('generateOgpImage: pixel-level composite assertions', () => {
  const GREEN = { r: 20, g: 200, b: 40 };
  const TOLERANCE = 4;

  async function readRawRgb(buffer: Buffer): Promise<{ data: Buffer; width: number; height: number }> {
    const { data, info } = await sharp(buffer).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    return { data, width: info.width, height: info.height };
  }

  function pixelAt(data: Buffer, width: number, x: number, y: number): { r: number; g: number; b: number } {
    const idx = (y * width + x) * 3;
    return { r: data[idx], g: data[idx + 1], b: data[idx + 2] };
  }

  function closeTo(actual: number, expected: number, tolerance: number): boolean {
    return Math.abs(actual - expected) <= tolerance;
  }

  it('renders the card center close to the pure-green source, and the corner distinctly different', async () => {
    const input = await createSolidImage(1000, 1000, GREEN);
    const result = await generateOgpImage(input);
    const { data, width, height } = await readRawRgb(result.buffer);

    // Canvas center: inside the 600px card, cover-cropped from the solid
    // source with no blur/desaturate applied — must render close to green.
    const center = pixelAt(data, width, Math.floor(width / 2), Math.floor(height / 2));
    expect(closeTo(center.r, GREEN.r, TOLERANCE)).toBe(true);
    expect(closeTo(center.g, GREEN.g, TOLERANCE)).toBe(true);
    expect(closeTo(center.b, GREEN.b, TOLERANCE)).toBe(true);

    // Canvas corner: outside the card, on the blurred+desaturated+gradient
    // background. Desaturation alone pulls green toward gray, so the
    // rendered value must differ from the raw source green by more than
    // the tolerance used for the card-center match.
    const corner = pixelAt(data, width, 2, 2);
    const cornerMatchesRawGreen =
      closeTo(corner.r, GREEN.r, TOLERANCE) &&
      closeTo(corner.g, GREEN.g, TOLERANCE) &&
      closeTo(corner.b, GREEN.b, TOLERANCE);
    expect(cornerMatchesRawGreen).toBe(false);
    void height;
  });

  it('shows the background, not the card color, in the masked-out corner region when cornerRadius is set', async () => {
    const width = 1200;
    const height = 630;
    const foregroundSize = 600;
    const cornerRadius = 60;
    const input = await createSolidImage(1000, 1000, GREEN);

    const result = await generateOgpImage(input, { width, height, foregroundSize, cornerRadius });
    const { data, width: outWidth } = await readRawRgb(result.buffer);

    const cardLeft = Math.round((width - foregroundSize) / 2);
    const cardTop = Math.round((height - foregroundSize) / 2);

    // A point just inside the card's bounding box but in its rounded-off
    // corner: with masking applied this pixel is background (desaturated,
    // not raw green); without masking (a plain square card) it would be
    // raw green.
    const maskedCorner = pixelAt(data, outWidth, cardLeft + 4, cardTop + 4);
    const matchesRawGreen =
      closeTo(maskedCorner.r, GREEN.r, TOLERANCE) &&
      closeTo(maskedCorner.g, GREEN.g, TOLERANCE) &&
      closeTo(maskedCorner.b, GREEN.b, TOLERANCE);
    expect(matchesRawGreen).toBe(false);
  });
});

describe('generateOgpFromLandscape: pixel-level cover-crop assertion', () => {
  it('keeps the pure-color source at the canvas center', async () => {
    const GREEN = { r: 20, g: 200, b: 40 };
    const TOLERANCE = 4;
    const input = await createSolidImage(2400, 1000, GREEN);

    const result = await generateOgpFromLandscape(input);
    const { data, info } = await sharp(result.buffer).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const idx = (Math.floor(info.height / 2) * info.width + Math.floor(info.width / 2)) * 3;

    expect(Math.abs(data[idx] - GREEN.r)).toBeLessThanOrEqual(TOLERANCE);
    expect(Math.abs(data[idx + 1] - GREEN.g)).toBeLessThanOrEqual(TOLERANCE);
    expect(Math.abs(data[idx + 2] - GREEN.b)).toBeLessThanOrEqual(TOLERANCE);
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
