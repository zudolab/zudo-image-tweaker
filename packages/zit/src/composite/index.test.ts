import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { compositeBatch, compositeOverlay } from './index.js';

interface Rgb {
  r: number;
  g: number;
  b: number;
}

const RED: Rgb = { r: 255, g: 0, b: 0 };
const BLUE: Rgb = { r: 0, g: 0, b: 255 };
const GREEN: Rgb = { r: 0, g: 255, b: 0 };
const YELLOW: Rgb = { r: 255, g: 255, b: 0 };

async function solidPng(width: number, height: number, color: Rgb): Promise<Buffer> {
  const channels = 3;
  const raw = Buffer.alloc(width * height * channels);
  for (let i = 0; i < raw.length; i += channels) {
    raw[i] = color.r;
    raw[i + 1] = color.g;
    raw[i + 2] = color.b;
  }
  return sharp(raw, { raw: { width, height, channels } }).png().toBuffer();
}

async function pixelAt(buffer: Buffer, x: number, y: number): Promise<Rgb> {
  const { data, info } = await sharp(buffer).raw().toBuffer({ resolveWithObject: true });
  const idx = (y * info.width + x) * info.channels;
  return { r: data[idx], g: data[idx + 1], b: data[idx + 2] };
}

/** JPEG (needed to carry an EXIF orientation tag) of a solid color, stored pre-rotation. */
async function solidJpegWithOrientation(width: number, height: number, color: Rgb, orientation: number): Promise<Buffer> {
  const channels = 3;
  const raw = Buffer.alloc(width * height * channels);
  for (let i = 0; i < raw.length; i += channels) {
    raw[i] = color.r;
    raw[i + 1] = color.g;
    raw[i + 2] = color.b;
  }
  return sharp(raw, { raw: { width, height, channels } })
    .withMetadata({ orientation })
    .jpeg({ quality: 100 })
    .toBuffer();
}

function expectColor(actual: Rgb, expected: Rgb): void {
  // sharp's PNG round-trip is lossless for solid raw RGB, but allow a small
  // tolerance in case of channel/profile handling differences.
  expect(actual.r).toBeCloseTo(expected.r, -1);
  expect(actual.g).toBeCloseTo(expected.g, -1);
  expect(actual.b).toBeCloseTo(expected.b, -1);
}

describe('compositeOverlay', () => {
  it('scales the overlay to widthPercent of the base width and forces a 1:1 square', async () => {
    const base = await solidPng(100, 100, RED);
    // Non-square overlay source — 'cover' resize must still force a 20x20 square.
    const overlay = await solidPng(30, 60, BLUE);

    const { buffer, width, height } = await compositeOverlay(base, overlay, {
      widthPercent: 20,
      paddingPercent: 0,
    });

    expect(width).toBe(100);
    expect(height).toBe(100);

    // Overlay occupies the bottom-right 20x20 block (no padding): x/y in [80, 99].
    expectColor(await pixelAt(buffer, 90, 90), BLUE);
    expectColor(await pixelAt(buffer, 80, 80), BLUE);
    expectColor(await pixelAt(buffer, 99, 99), BLUE);
    // Just outside the overlay block, on both axes, must still be base color.
    expectColor(await pixelAt(buffer, 79, 90), RED);
    expectColor(await pixelAt(buffer, 90, 79), RED);
  });

  it('positions the overlay at the bottom-right corner with percentage padding', async () => {
    const base = await solidPng(100, 100, RED);
    const overlay = await solidPng(20, 20, BLUE);

    const { buffer } = await compositeOverlay(base, overlay, {
      widthPercent: 20,
      paddingPercent: 5,
    });

    // overlaySizePx = 20, paddingPx = round(100 * 0.05) = 5.
    // Overlay spans x/y in [75, 94]; padding gap is x/y in [95, 99].
    expectColor(await pixelAt(buffer, 85, 85), BLUE);
    expectColor(await pixelAt(buffer, 75, 75), BLUE);
    expectColor(await pixelAt(buffer, 94, 94), BLUE);

    expectColor(await pixelAt(buffer, 99, 99), RED);
    expectColor(await pixelAt(buffer, 95, 85), RED);
    expectColor(await pixelAt(buffer, 85, 95), RED);
    expectColor(await pixelAt(buffer, 74, 85), RED);
  });

  it('derives both horizontal and vertical padding from the base width', async () => {
    // Non-square base: padding must be baseWidth-relative on the vertical
    // axis too (matches the ported source behavior), not baseHeight-relative.
    const base = await solidPng(200, 100, RED);
    const overlay = await solidPng(10, 10, BLUE);

    const { buffer } = await compositeOverlay(base, overlay, {
      widthPercent: 10,
      paddingPercent: 10,
    });

    // overlaySizePx = round(200 * 0.10) = 20, paddingPx = round(200 * 0.10) = 20.
    // left = 200 - 20 - 20 = 160, top = 100 - 20 - 20 = 60.
    expectColor(await pixelAt(buffer, 170, 70), BLUE);
    expectColor(await pixelAt(buffer, 159, 70), RED);
    expectColor(await pixelAt(buffer, 170, 59), RED);
  });

  it('defaults position to bottom-right when omitted', async () => {
    const base = await solidPng(100, 100, RED);
    const overlay = await solidPng(20, 20, BLUE);

    const withDefault = await compositeOverlay(base, overlay, { widthPercent: 20, paddingPercent: 5 });
    const withExplicit = await compositeOverlay(base, overlay, {
      widthPercent: 20,
      paddingPercent: 5,
      position: 'bottom-right',
    });

    expect(await pixelAt(withDefault.buffer, 85, 85)).toEqual(await pixelAt(withExplicit.buffer, 85, 85));
  });

  it('rejects an unsupported position at runtime', async () => {
    const base = await solidPng(50, 50, RED);
    const overlay = await solidPng(10, 10, BLUE);

    await expect(
      compositeOverlay(base, overlay, {
        widthPercent: 20,
        paddingPercent: 0,
        // @ts-expect-error — exercising the runtime guard for a value outside the CompositePosition union
        position: 'top-left',
      }),
    ).rejects.toThrow(/unsupported position/i);
  });

  it('rejects a widthPercent that rounds to a non-positive overlay size', async () => {
    const base = await solidPng(10, 10, RED);
    const overlay = await solidPng(10, 10, BLUE);

    // round(10 * 0.04) = 0
    await expect(compositeOverlay(base, overlay, { widthPercent: 4, paddingPercent: 0 })).rejects.toThrow(
      /non-positive overlay size/i,
    );
  });

  it('auto-orients a base image tagged with an EXIF orientation before compositing', async () => {
    // Stored 100x50 with orientation 6 (rotate 90deg CW to display correctly)
    // physically decodes to a 50x100 image once auto-oriented.
    const base = await solidJpegWithOrientation(100, 50, RED, 6);
    const overlay = await solidPng(10, 10, BLUE);

    const { buffer, width, height } = await compositeOverlay(base, overlay, {
      widthPercent: 20,
      paddingPercent: 0,
    });

    expect(width).toBe(50);
    expect(height).toBe(100);

    const decoded = await sharp(buffer).metadata();
    expect(decoded.width).toBe(50);
    expect(decoded.height).toBe(100);

    // overlaySizePx = round(50 * 0.20) = 10, no padding: overlay occupies
    // x in [40, 49], y in [90, 99] of the corrected (rotated) canvas.
    expectColor(await pixelAt(buffer, 45, 95), BLUE);
    expectColor(await pixelAt(buffer, 39, 95), RED);
    expectColor(await pixelAt(buffer, 45, 89), RED);
  });
});

describe('compositeBatch', () => {
  it('produces the cartesian product of bases and overlays with matching refs', async () => {
    const bases = [
      { ref: 'base-red', image: await solidPng(100, 100, RED) },
      { ref: 'base-green', image: await solidPng(100, 100, GREEN) },
    ];
    const overlays = [
      { ref: 'overlay-blue', image: await solidPng(20, 20, BLUE) },
      { ref: 'overlay-yellow', image: await solidPng(20, 20, YELLOW) },
    ];

    const results = await compositeBatch(bases, overlays, { widthPercent: 20, paddingPercent: 0 });

    expect(results).toHaveLength(4);
    expect(results.map((r) => [r.baseRef, r.overlayRef])).toEqual([
      ['base-red', 'overlay-blue'],
      ['base-red', 'overlay-yellow'],
      ['base-green', 'overlay-blue'],
      ['base-green', 'overlay-yellow'],
    ]);

    const expectedOverlayColor: Record<string, Rgb> = {
      'overlay-blue': BLUE,
      'overlay-yellow': YELLOW,
    };
    const expectedBaseColor: Record<string, Rgb> = {
      'base-red': RED,
      'base-green': GREEN,
    };

    for (const entry of results) {
      expectColor(await pixelAt(entry.result.buffer, 90, 90), expectedOverlayColor[entry.overlayRef]);
      expectColor(await pixelAt(entry.result.buffer, 10, 10), expectedBaseColor[entry.baseRef]);
    }
  });

  it('respects a constrained concurrency without dropping or misordering results', async () => {
    const bases = [
      { ref: 'b1', image: await solidPng(60, 60, RED) },
      { ref: 'b2', image: await solidPng(60, 60, GREEN) },
      { ref: 'b3', image: await solidPng(60, 60, RED) },
    ];
    const overlays = [{ ref: 'o1', image: await solidPng(10, 10, BLUE) }];

    const results = await compositeBatch(bases, overlays, {
      widthPercent: 10,
      paddingPercent: 0,
      concurrency: 1,
    });

    expect(results.map((r) => r.baseRef)).toEqual(['b1', 'b2', 'b3']);
    expect(results.every((r) => r.overlayRef === 'o1')).toBe(true);
  });

  it('returns an empty array when either input list is empty', async () => {
    const results = await compositeBatch([], [{ ref: 'o1', image: await solidPng(10, 10, BLUE) }], {
      widthPercent: 10,
      paddingPercent: 0,
    });
    expect(results).toEqual([]);
  });

  it('rejects a non-finite or non-positive concurrency instead of silently no-oping', async () => {
    const bases = [{ ref: 'b1', image: await solidPng(20, 20, RED) }];
    const overlays = [{ ref: 'o1', image: await solidPng(5, 5, BLUE) }];

    await expect(
      compositeBatch(bases, overlays, { widthPercent: 10, paddingPercent: 0, concurrency: Number.NaN }),
    ).rejects.toThrow(/concurrency/i);
    await expect(
      compositeBatch(bases, overlays, { widthPercent: 10, paddingPercent: 0, concurrency: 0 }),
    ).rejects.toThrow(/concurrency/i);
  });
});
