/**
 * Tests for the step-down preset (encodeUnderByteBudget without exactWidth):
 * aspect-ratio-preserving output, format auto-detection from the alpha
 * channel, quality-ladder step-down, and — once the ladder is exhausted —
 * width step-down toward minWidth.
 *
 * All fixtures are generated in-memory with sharp — no network access. The
 * "noise" fixture uses a seeded PRNG (not Math.random) so its compressed
 * size — and therefore the maxBytes thresholds below — are reproducible
 * across runs/machines.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import sharp from 'sharp';

import { encodeUnderByteBudget } from './index';

// Real sharp encode/resize work across several compression levels per test;
// give it head-room beyond vitest's default timeout.
const TEST_TIMEOUT = 20000;

/** Deterministic PRNG (mulberry32) so noise fixtures compress identically every run. */
function mulberry32(seed: number) {
  return function random() {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A small solid-color JPEG-friendly fixture — compresses trivially small. */
async function makeSolidImage(width: number, height: number) {
  return sharp({
    create: { width, height, channels: 3, background: { r: 120, g: 140, b: 160 } },
  })
    .jpeg()
    .toBuffer();
}

/** A fixture with an alpha channel, to exercise PNG format auto-detection. */
async function makeAlphaImage(width: number, height: number) {
  return sharp({
    create: { width, height, channels: 4, background: { r: 10, g: 200, b: 90, alpha: 0.5 } },
  })
    .png()
    .toBuffer();
}

/**
 * A solid-color fixture tagged with an EXIF orientation that rotates 90/270
 * degrees (5-8), so its stored pixel dimensions differ from its rendered
 * (auto-oriented) dimensions.
 */
async function makeRotatedImage(storedWidth: number, storedHeight: number, orientation: number) {
  return sharp({
    create: { width: storedWidth, height: storedHeight, channels: 3, background: { r: 200, g: 50, b: 50 } },
  })
    .withMetadata({ orientation })
    .jpeg()
    .toBuffer();
}

/**
 * A fixture that resists compression — random noise defeats both JPEG DCT
 * quantization and PNG's predictive filters, so its size shrinks much more
 * slowly across quality levels than a real photo would. Used to force the
 * step-down loop through multiple attempts. Seeded for reproducibility.
 */
async function makeNoiseImage(width: number, height: number, seed = 42) {
  const channels = 3;
  const data = Buffer.alloc(width * height * channels);
  const random = mulberry32(seed);
  for (let i = 0; i < data.length; i++) {
    data[i] = Math.floor(random() * 256);
  }
  return sharp(data, { raw: { width, height, channels } }).png().toBuffer();
}

/**
 * A photo-like fixture: smooth gradients with mild seeded noise. Gradients
 * (unlike pure noise) let palette quantization resolve different quality
 * targets to different palettes, so each PNG ladder rung encodes distinctly.
 */
async function makePhotoLikeImage(width: number, height: number, seed = 11) {
  const channels = 3;
  const data = Buffer.alloc(width * height * channels);
  const random = mulberry32(seed);
  const clamp = (value: number) => Math.min(255, Math.max(0, value));
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * channels;
      const noise = () => (random() - 0.5) * 24;
      data[i] = clamp(Math.round((x / width) * 255 + noise()));
      data[i + 1] = clamp(Math.round((y / height) * 255 + noise()));
      data[i + 2] = clamp(Math.round(((x + y) / (width + height)) * 255 + noise()));
    }
  }
  return sharp(data, { raw: { width, height, channels } }).png().toBuffer();
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('encodeUnderByteBudget — format resolution', () => {
  it(
    'auto-detects jpeg when the source has no alpha channel and format is omitted',
    async () => {
      const src = await makeSolidImage(400, 300);
      const result = await encodeUnderByteBudget(src, { maxBytes: 8 * 1024 * 1024 });

      expect(result.ok).toBe(true);
      expect(result.ok && result.format).toBe('jpeg');
    },
    TEST_TIMEOUT,
  );

  it(
    'auto-detects png when the source has an alpha channel and format is omitted',
    async () => {
      const src = await makeAlphaImage(200, 200);
      const result = await encodeUnderByteBudget(src, { maxBytes: 8 * 1024 * 1024 });

      expect(result.ok).toBe(true);
      expect(result.ok && result.format).toBe('png');
    },
    TEST_TIMEOUT,
  );

  it(
    'honors an explicit "jpeg" override even when the source has alpha',
    async () => {
      const src = await makeAlphaImage(120, 120);
      const result = await encodeUnderByteBudget(src, { format: 'jpeg', maxBytes: 8 * 1024 * 1024 });

      expect(result.ok).toBe(true);
      expect(result.ok && result.format).toBe('jpeg');
    },
    TEST_TIMEOUT,
  );

  it(
    'honors an explicit "auto" the same way as omitting format',
    async () => {
      const src = await makeAlphaImage(120, 120);
      const result = await encodeUnderByteBudget(src, { format: 'auto', maxBytes: 8 * 1024 * 1024 });

      expect(result.ok).toBe(true);
      expect(result.ok && result.format).toBe('png');
    },
    TEST_TIMEOUT,
  );
});

describe('encodeUnderByteBudget — step-down preset budget loop', () => {
  it(
    'fits within a generous budget on the first attempt (no step-down needed)',
    async () => {
      const src = await makeSolidImage(400, 300);
      const result = await encodeUnderByteBudget(src, { maxBytes: 8 * 1024 * 1024 });

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('expected ok result');
      expect(result.width).toBe(400);
      expect(result.steps).toHaveLength(1);
      expect(result.bytes).toBeLessThanOrEqual(8 * 1024 * 1024);
    },
    TEST_TIMEOUT,
  );

  it(
    'tracks the auto-oriented (post-rotation) width, not the stored EXIF width, for a 90-degree-rotated source',
    async () => {
      // Stored as 300x1000 (portrait) with orientation 6 (rotate 90 CW) —
      // the real, auto-oriented image is 1000x300 (landscape). Regression
      // test: the step-down loop's width tracking must reflect the
      // rendered width, not sharp's raw pre-rotation metadata.width.
      const src = await makeRotatedImage(300, 1000, 6);
      const result = await encodeUnderByteBudget(src, { maxBytes: 8 * 1024 * 1024 });

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('expected ok result');
      expect(result.width).toBe(1000);
      expect(result.steps[0]?.width).toBe(1000);

      const decoded = await sharp(result.buffer).metadata();
      expect(decoded.width).toBe(1000);
      expect(decoded.height).toBe(300);
    },
    TEST_TIMEOUT,
  );

  // The tests below all use the same 500x400 seeded-noise fixture at
  // successively tighter budgets, mirroring the source's step-down ladder:
  //   - full-width, highest-quality attempt encodes to ~153KB
  //   - full-width, lowest-quality attempt encodes to ~39.6KB
  //   - the single width step-down (500 -> 425; the next step would fall
  //     below minWidth=400, so it's also the last) bottoms out at ~24.8KB
  //     at its lowest quality — the true floor for this fixture.

  it(
    'steps down quality (without shrinking width) when the source resists compression',
    async () => {
      const src = await makeNoiseImage(500, 400);

      const result = await encodeUnderByteBudget(src, { maxBytes: 45000, format: 'jpeg' });

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('expected ok result');
      expect(result.width).toBe(500);
      expect(result.steps.length).toBeGreaterThan(1);
      expect(result.bytes).toBeLessThanOrEqual(45000);
    },
    TEST_TIMEOUT,
  );

  it(
    'steps down width when quality alone cannot reach the budget',
    async () => {
      const src = await makeNoiseImage(500, 400);

      const result = await encodeUnderByteBudget(src, { maxBytes: 30000, format: 'jpeg' });

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('expected ok result');
      expect(result.width).toBeLessThan(500);
      expect(result.bytes).toBeLessThanOrEqual(30000);
    },
    TEST_TIMEOUT,
  );

  it(
    'tries the minWidth floor itself before giving up, even though the step factor would undershoot it',
    async () => {
      const src = await makeNoiseImage(500, 400);

      const result = await encodeUnderByteBudget(src, { maxBytes: 22000, format: 'jpeg' });

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('expected ok result');
      expect(result.width).toBe(400);
      expect(result.bytes).toBeLessThanOrEqual(22000);
    },
    TEST_TIMEOUT,
  );

  it(
    'reports unreachable-budget without throwing when even the width floor cannot fit an unreasonable budget',
    async () => {
      const src = await makeNoiseImage(500, 400);

      const result = await encodeUnderByteBudget(src, { maxBytes: 1, format: 'jpeg' });

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('expected failure result');
      expect(result.reason).toBe('unreachable-budget');
      // No buffer is carried on failure — steps still record every attempt made.
      expect(result.steps.length).toBeGreaterThan(1);
      expect(result.steps.at(-1)?.width).toBeLessThan(500);
    },
    TEST_TIMEOUT,
  );

  it(
    'makes every default PNG ladder rung effective — no two adjacent rungs byte-identical',
    async () => {
      const src = await makePhotoLikeImage(300, 300);

      // minWidth pinned to the source width prevents width step-down, and
      // maxBytes 1 forces the loop through the whole quality ladder.
      const result = await encodeUnderByteBudget(src, {
        maxBytes: 1,
        format: 'png',
        minWidth: 300,
      });

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('expected failure result');
      // Three effective encodings on this stack: lossless, palette-256,
      // palette-16 — rungs resolving to a duplicate encoding are skipped.
      expect(result.steps).toHaveLength(3);
      expect(result.steps.every((step) => step.width === 300)).toBe(true);
      for (let i = 1; i < result.steps.length; i++) {
        expect(result.steps[i]!.bytes).not.toBe(result.steps[i - 1]!.bytes);
      }
    },
    TEST_TIMEOUT,
  );

  it(
    'respects a custom qualityLadder, minWidth, and widthStepFactor',
    async () => {
      const src = await makeNoiseImage(500, 400);

      const result = await encodeUnderByteBudget(src, {
        maxBytes: 1,
        format: 'jpeg',
        qualityLadder: [80, 40],
        minWidth: 450,
        widthStepFactor: 0.9,
      });

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('expected failure result');
      // Only two quality rungs tried per width, and width never drops below 450.
      const widths = new Set(result.steps.map((step) => step.width));
      for (const width of widths) {
        expect(width).toBeGreaterThanOrEqual(450);
      }
      const qualities = new Set(result.steps.map((step) => step.quality));
      expect(qualities).toEqual(new Set([80, 40]));
    },
    TEST_TIMEOUT,
  );
});

describe('encodeUnderByteBudget — input errors', () => {
  it(
    'throws a clear error when metadata cannot be read (invalid image)',
    async () => {
      const bogus = Buffer.from('not an image');
      await expect(encodeUnderByteBudget(bogus, { maxBytes: 8 * 1024 * 1024 })).rejects.toThrow();
    },
    TEST_TIMEOUT,
  );
});
