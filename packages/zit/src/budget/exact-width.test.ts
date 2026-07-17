/**
 * Tests for the exact-width preset (encodeUnderByteBudget with
 * `exactWidth` set): fixed output width (upscaling smaller sources),
 * default PNG format, animated-GIF skip, and the PNG quality/palette
 * step-down ladder.
 */

import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import type { Join } from 'sharp';

import { encodeUnderByteBudget } from './index';

const TEST_TIMEOUT = 20000;

function mulberry32(seed: number) {
  return function random() {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function makeSolidImage(width: number, height: number) {
  return sharp({
    create: { width, height, channels: 3, background: { r: 30, g: 90, b: 200 } },
  })
    .png()
    .toBuffer();
}

/** Compression-resistant fixture, seeded for reproducible byte sizes. */
async function makeNoiseImage(width: number, height: number, seed = 7) {
  const channels = 3;
  const data = Buffer.alloc(width * height * channels);
  const random = mulberry32(seed);
  for (let i = 0; i < data.length; i++) {
    data[i] = Math.floor(random() * 256);
  }
  return sharp(data, { raw: { width, height, channels } }).png().toBuffer();
}

/**
 * A photo-like fixture: smooth per-channel gradients with mild seeded noise.
 * Unlike pure noise (where palette quantization maxes out its colour budget
 * at every quality target), gradients let libimagequant hit different
 * quality targets with different palettes, so each ladder rung produces a
 * distinct encoding — which is what the rung-effectiveness tests assert.
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

/**
 * A minimal animated (multi-page) GIF: two solid-color frames stacked into
 * one tall canvas and encoded with sharp's animated-GIF join support.
 */
async function makeAnimatedGif(frameWidth: number, frameHeight: number) {
  const frame1 = await sharp({
    create: { width: frameWidth, height: frameHeight, channels: 3, background: { r: 255, g: 0, b: 0 } },
  })
    .png()
    .toBuffer();
  const frame2 = await sharp({
    create: { width: frameWidth, height: frameHeight, channels: 3, background: { r: 0, g: 255, b: 0 } },
  })
    .png()
    .toBuffer();

  // sharp's `Join` type doesn't declare `pageHeight`, though the runtime
  // option is documented and required to mark the joined frames as pages.
  const joinOptions = { animated: true, pageHeight: frameHeight } as unknown as Join;
  return sharp([frame1, frame2], { join: joinOptions }).gif().toBuffer();
}

describe('encodeUnderByteBudget — exact-width preset', () => {
  it(
    'resizes to the exact width, preserving aspect ratio',
    async () => {
      const src = await makeSolidImage(800, 600); // 4:3
      const result = await encodeUnderByteBudget(src, { exactWidth: 200, maxBytes: 8 * 1024 * 1024 });

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('expected ok result');
      expect(result.width).toBe(200);

      const decoded = await sharp(result.buffer).metadata();
      expect(decoded.width).toBe(200);
      expect(decoded.height).toBe(150); // 200 * (600/800)
    },
    TEST_TIMEOUT,
  );

  it(
    'upscales sources smaller than exactWidth',
    async () => {
      const src = await makeSolidImage(100, 100);
      const result = await encodeUnderByteBudget(src, { exactWidth: 250, maxBytes: 8 * 1024 * 1024 });

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('expected ok result');
      expect(result.width).toBe(250);

      const decoded = await sharp(result.buffer).metadata();
      expect(decoded.width).toBe(250);
    },
    TEST_TIMEOUT,
  );

  it(
    'defaults to png output when format is omitted',
    async () => {
      const src = await makeSolidImage(300, 300);
      const result = await encodeUnderByteBudget(src, { exactWidth: 150, maxBytes: 8 * 1024 * 1024 });

      expect(result.ok).toBe(true);
      expect(result.ok && result.format).toBe('png');
    },
    TEST_TIMEOUT,
  );

  it(
    'skips animated GIFs, returning ok:false without throwing',
    async () => {
      const src = await makeAnimatedGif(20, 20);
      const result = await encodeUnderByteBudget(src, { exactWidth: 150, maxBytes: 8 * 1024 * 1024 });

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('expected failure result');
      expect(result.reason).toBe('animated-gif-skipped');
      expect(result.steps).toEqual([]);
    },
    TEST_TIMEOUT,
  );

  it(
    'steps down the PNG quality ladder until the encoded size fits the budget',
    async () => {
      const src = await makeNoiseImage(300, 300);

      // Empirically between the highest-quality (rung 95) and lowest-quality
      // (rung 50) encoded sizes at exactWidth 300 for this fixture, so the
      // loop must try more than one rung.
      const result = await encodeUnderByteBudget(src, { exactWidth: 300, maxBytes: 200_000 });

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('expected ok result');
      expect(result.steps.length).toBeGreaterThan(1);
      expect(result.bytes).toBeLessThanOrEqual(200_000);
      expect([95, 85, 75, 65, 50]).toContain(result.quality);
    },
    TEST_TIMEOUT,
  );

  it(
    'reports unreachable-budget without throwing when even the lowest rung is over budget',
    async () => {
      const src = await makeNoiseImage(300, 300);

      const result = await encodeUnderByteBudget(src, { exactWidth: 300, maxBytes: 1 });

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('expected failure result');
      expect(result.reason).toBe('unreachable-budget');
      // The five nominal default rungs resolve to three distinct encodings
      // (lossless, palette-256, palette-16) — duplicates are skipped rather
      // than re-encoded (issue #26).
      expect(result.steps).toHaveLength(3);
      expect(result.steps.every((step) => step.width === 300)).toBe(true);
    },
    TEST_TIMEOUT,
  );

  it(
    'engages palette quantization only at the low rungs, and only when paletteQuantization is enabled',
    async () => {
      const src = await makeNoiseImage(120, 120);

      const withPalette = await encodeUnderByteBudget(src, {
        exactWidth: 120,
        maxBytes: 8 * 1024 * 1024,
        qualityLadder: [50],
        paletteQuantization: true,
      });
      expect(withPalette.ok).toBe(true);
      if (!withPalette.ok) throw new Error('expected ok result');
      const withPaletteMeta = await sharp(withPalette.buffer).metadata();
      expect(withPaletteMeta.isPalette).toBe(true);

      const withoutPalette = await encodeUnderByteBudget(src, {
        exactWidth: 120,
        maxBytes: 8 * 1024 * 1024,
        qualityLadder: [50],
        paletteQuantization: false,
      });
      expect(withoutPalette.ok).toBe(true);
      if (!withoutPalette.ok) throw new Error('expected ok result');
      const withoutPaletteMeta = await sharp(withoutPalette.buffer).metadata();
      expect(withoutPaletteMeta.isPalette).toBe(false);
    },
    TEST_TIMEOUT,
  );

  it(
    'makes every default PNG ladder rung effective — no two adjacent rungs byte-identical',
    async () => {
      const src = await makePhotoLikeImage(300, 300);

      // maxBytes 1 forces the loop through the entire ladder.
      const result = await encodeUnderByteBudget(src, { exactWidth: 300, maxBytes: 1 });

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('expected failure result');
      // Three effective encodings on this stack: lossless, palette-256,
      // palette-16 — rungs resolving to a duplicate encoding are skipped.
      expect(result.steps).toHaveLength(3);
      for (let i = 1; i < result.steps.length; i++) {
        expect(result.steps[i]!.bytes).not.toBe(result.steps[i - 1]!.bytes);
      }
    },
    TEST_TIMEOUT,
  );

  it(
    'skips no-op rungs instead of re-encoding identical output when palette quantization is disabled',
    async () => {
      const src = await makePhotoLikeImage(120, 120);

      // With paletteQuantization off, every PNG rung resolves to the same
      // lossless encoder options — only one attempt should be made.
      const result = await encodeUnderByteBudget(src, {
        exactWidth: 120,
        maxBytes: 1,
        paletteQuantization: false,
      });

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('expected failure result');
      expect(result.steps).toHaveLength(1);
    },
    TEST_TIMEOUT,
  );

  it(
    'uses the JPEG quality ladder when the exact-width output format is jpeg',
    async () => {
      const src = await makePhotoLikeImage(200, 200);

      const result = await encodeUnderByteBudget(src, { exactWidth: 200, format: 'jpeg', maxBytes: 1 });

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('expected failure result');
      expect(result.steps.map((step) => step.quality)).toEqual([90, 82, 75, 65, 55, 45, 35]);
    },
    TEST_TIMEOUT,
  );

  it(
    'respects an explicit format override on the exact-width preset',
    async () => {
      const src = await makeSolidImage(200, 200);
      const result = await encodeUnderByteBudget(src, {
        exactWidth: 100,
        format: 'jpeg',
        maxBytes: 8 * 1024 * 1024,
      });

      expect(result.ok).toBe(true);
      expect(result.ok && result.format).toBe('jpeg');
    },
    TEST_TIMEOUT,
  );
});
