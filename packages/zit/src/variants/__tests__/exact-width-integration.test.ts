/**
 * Engine-level size-cap integration between `/variants` and `/budget`.
 *
 * `/budget`'s own suite (exact-width.test.ts, step-down.test.ts) already
 * exercises `encodeUnderByteBudget` in isolation against fixtures it
 * generates itself — that's genuine unit coverage, not duplicated here.
 * This file instead exercises the two modules composed together, the way a
 * real caller would: run a source through the `/variants` engine, then
 * byte-budget-cap one of its outputs (or the same source) — the shape of
 * pipeline the source snapshot's byte-capped-PNG and mail-attachment
 * features both took, generalized to any caller needing a size-capped
 * derivative of an already-processed image.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { encodeUnderByteBudget } from '../../budget/index.js';
import { processImages } from '../engine.js';

let inputDir: string;
let outputDir: string;

beforeEach(async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'zit-exact-width-integration-'));
  inputDir = path.join(root, 'in');
  outputDir = path.join(root, 'out');
  await fs.mkdir(inputDir, { recursive: true });
  await fs.mkdir(outputDir, { recursive: true });
});

afterEach(async () => {
  await fs.rm(path.dirname(inputDir), { recursive: true, force: true });
});

/** A photographic-ish fixture with gradient noise so it doesn't trivially compress to nothing. */
async function makePhotoLikeJpeg(name: string, width: number, height: number): Promise<string> {
  const svg = `
    <svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="g" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="#3a6ea5" />
          <stop offset="50%" stop-color="#ff8c42" />
          <stop offset="100%" stop-color="#2e8b57" />
        </linearGradient>
      </defs>
      <rect width="${width}" height="${height}" fill="url(#g)" />
      <circle cx="${width * 0.3}" cy="${height * 0.4}" r="${Math.min(width, height) * 0.2}" fill="#ffffffaa" />
    </svg>
  `;
  const buffer = await sharp(Buffer.from(svg)).jpeg({ quality: 95 }).toBuffer();
  const filePath = path.join(inputDir, name);
  await fs.writeFile(filePath, buffer);
  return filePath;
}

describe('size-cap integration — capping a /variants-processed source under a byte budget', () => {
  it('encodes the same source the engine just processed to an exact width under a byte ceiling', async () => {
    const source = await makePhotoLikeJpeg('listing.jpg', 2000, 1500);

    const summary = await processImages({ inputDir, outputDir, widths: [600] });
    expect(summary.failed).toEqual([]);
    expect(summary.results[0].metadata).toMatchObject({ width: 2000, height: 1500 });

    // Downstream size-capped derivative of the very same source, independent
    // of whatever widths/formats the engine emitted.
    const capped = await encodeUnderByteBudget(source, { exactWidth: 1600, maxBytes: 2 * 1024 * 1024 });

    expect(capped.ok).toBe(true);
    if (!capped.ok) throw new Error('expected ok result');
    expect(capped.width).toBe(1600);
    expect(capped.bytes).toBeLessThanOrEqual(2 * 1024 * 1024);

    const decoded = await sharp(capped.buffer).metadata();
    expect(decoded.width).toBe(1600);
    expect(decoded.height).toBe(1200); // 1600 * (1500/2000), aspect preserved
  });

  it('upscales a source smaller than the target width, mirroring the engine leaving small sources alone', async () => {
    const source = await makePhotoLikeJpeg('small.jpg', 500, 500);

    // The variants engine never upscales past the source width...
    await processImages({ inputDir, outputDir, widths: [600, 900] });
    expect((await fs.readdir(path.join(outputDir, 'small'))).sort()).toEqual(['.cache.json', '500w.webp']);

    // ...but a caller that needs a fixed exact width for a downstream
    // consumer (e.g. a size-capped card image) still gets it, via /budget.
    const capped = await encodeUnderByteBudget(source, { exactWidth: 800, maxBytes: 2 * 1024 * 1024 });
    expect(capped.ok).toBe(true);
    if (!capped.ok) throw new Error('expected ok result');
    expect(capped.width).toBe(800);
  });

  it('reports unreachable-budget (not a throw) when the engine-processed source cannot fit an unreasonably tight cap', async () => {
    const source = await makePhotoLikeJpeg('tight.jpg', 1200, 900);
    await processImages({ inputDir, outputDir });

    const capped = await encodeUnderByteBudget(source, { exactWidth: 1200, maxBytes: 1 });
    expect(capped.ok).toBe(false);
    if (capped.ok) throw new Error('expected failure result');
    expect(capped.reason).toBe('unreachable-budget');
  });
});

describe('size-cap integration — animated-GIF skip agrees between /variants and /budget', () => {
  // A real 2-frame animated GIF (8x8, produced by ffmpeg) — mirrors the
  // fixture already used in engine.test.ts for the passthrough path.
  const ANIMATED_GIF = Buffer.from(
    'R0lGODlhCAAIAPcfMQAAACQAAEgAAGwAAJAAALQAANgAAPwAAAAkACQkAEgkAGwkAJAkALQkANgkAPwkAABIACRIAEhIAGxIAJBIALRIANhIAPxIAABsACRsAEhsAGxsAJBsALRsANhsAPxsAACQACSQAEiQAGyQAJCQALSQANiQAPyQAAC0ACS0AEi0AGy0AJC0ALS0ANi0APy0AADYACTYAEjYAGzYAJDYALTYANjYAPzYAAD8ACT8AEj8AGz8AJD8ALT8ANj8APz8AAAAVSQAVUgAVWwAVZAAVbQAVdgAVfwAVQAkVSQkVUgkVWwkVZAkVbQkVdgkVfwkVQBIVSRIVUhIVWxIVZBIVbRIVdhIVfxIVQBsVSRsVUhsVWxsVZBsVbRsVdhsVfxsVQCQVSSQVUiQVWyQVZCQVbSQVdiQVfyQVQC0VSS0VUi0VWy0VZC0VbS0Vdi0Vfy0VQDYVSTYVUjYVWzYVZDYVbTYVdjYVfzYVQD8VST8VUj8VWz8VZD8VbT8Vdj8Vfz8VQAAqiQAqkgAqmwAqpAAqrQAqtgAqvwAqgAkqiQkqkgkqmwkqpAkqrQkqtgkqvwkqgBIqiRIqkhIqmxIqpBIqrRIqthIqvxIqgBsqiRsqkhsqmxsqpBsqrRsqthsqvxsqgCQqiSQqkiQqmyQqpCQqrSQqtiQqvyQqgC0qiS0qki0qmy0qpC0qrS0qti0qvy0qgDYqiTYqkjYqmzYqpDYqrTYqtjYqvzYqgD8qiT8qkj8qmz8qpD8qrT8qtj8qvz8qgAA/yQA/0gA/2wA/5AA/7QA/9gA//wA/wAk/yQk/0gk/2wk/5Ak/7Qk/9gk//wk/wBI/yRI/0hI/2xI/5BI/7RI/9hI//xI/wBs/yRs/0hs/2xs/5Bs/7Rs/9hs//xs/wCQ/ySQ/0iQ/2yQ/5CQ/7SQ/9iQ//yQ/wC0/yS0/0i0/2y0/5C0/7S0/9i0//y0/wDY/yTY/0jY/2zY/5DY/7TY/9jY//zY/wD8/yT8/0j8/2z8/5D8/7T8/9j8//z8/yH/C05FVFNDQVBFMi4wAwEAAAAh+QQEGQAfACwAAAAACAAIAAAINwAPHMCBAxiwY8cEEjSIUCAECACACAhi4AACCECABBHiEKJEjhYxAtjYMUCQE14EXgRQyguBgAAAIfkEBRkAAAAsBwAHAAEAAQAACAQAAQQEADs=',
    'base64',
  );

  it('is passthrough-skipped by /variants and reported unreachable via the animated-gif-skipped reason by /budget', async () => {
    await fs.writeFile(path.join(inputDir, 'clip.gif'), ANIMATED_GIF);

    const summary = await processImages({ inputDir, outputDir });
    expect(summary.results[0].animated).toBe(true);
    expect(summary.results[0].variants).toEqual([]);

    const capped = await encodeUnderByteBudget(ANIMATED_GIF, { exactWidth: 4, maxBytes: 8 * 1024 * 1024 });
    expect(capped.ok).toBe(false);
    if (capped.ok) throw new Error('expected failure result');
    expect(capped.reason).toBe('animated-gif-skipped');
  });
});
