import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import sharp from 'sharp';
import { processImages } from '../engine.js';
import { readCache, writeAtomicVia } from '../hash-cache.js';

// A real 2-frame animated GIF (8x8) — sharp can't synthesize animation, so
// it's embedded. metadata reports pages=2, so it takes the passthrough path.
const ANIMATED_GIF = Buffer.from(
  'R0lGODlhCAAIAPcfMQAAACQAAEgAAGwAAJAAALQAANgAAPwAAAAkACQkAEgkAGwkAJAkALQkANgkAPwkAABIACRIAEhIAGxIAJBIALRIANhIAPxIAABsACRsAEhsAGxsAJBsALRsANhsAPxsAACQACSQAEiQAGyQAJCQALSQANiQAPyQAAC0ACS0AEi0AGy0AJC0ALS0ANi0APy0AADYACTYAEjYAGzYAJDYALTYANjYAPzYAAD8ACT8AEj8AGz8AJD8ALT8ANj8APz8AAAAVSQAVUgAVWwAVZAAVbQAVdgAVfwAVQAkVSQkVUgkVWwkVZAkVbQkVdgkVfwkVQBIVSRIVUhIVWxIVZBIVbRIVdhIVfxIVQBsVSRsVUhsVWxsVZBsVbRsVdhsVfxsVQCQVSSQVUiQVWyQVZCQVbSQVdiQVfyQVQC0VSS0VUi0VWy0VZC0VbS0Vdi0Vfy0VQDYVSTYVUjYVWzYVZDYVbTYVdjYVfzYVQD8VST8VUj8VWz8VZD8VbT8Vdj8Vfz8VQAAqiQAqkgAqmwAqpAAqrQAqtgAqvwAqgAkqiQkqkgkqmwkqpAkqrQkqtgkqvwkqgBIqiRIqkhIqmxIqpBIqrRIqthIqvxIqgBsqiRsqkhsqmxsqpBsqrRsqthsqvxsqgCQqiSQqkiQqmyQqpCQqrSQqtiQqvyQqgC0qiS0qki0qmy0qpC0qrS0qti0qvy0qgDYqiTYqkjYqmzYqpDYqrTYqtjYqvzYqgD8qiT8qkj8qmz8qpD8qrT8qtj8qvz8qgAA/yQA/0gA/2wA/5AA/7QA/9gA//wA/wAk/yQk/0gk/2wk/5Ak/7Qk/9gk//wk/wBI/yRI/0hI/2xI/5BI/7RI/9hI//xI/wBs/yRs/0hs/2xs/5Bs/7Rs/9hs//xs/wCQ/ySQ/0iQ/2yQ/5CQ/7SQ/9iQ//yQ/wC0/yS0/0i0/2y0/5C0/7S0/9i0//y0/wDY/yTY/0jY/2zY/5DY/7TY/9jY//zY/wD8/yT8/0j8/2z8/5D8/7T8/9j8//z8/yH/C05FVFNDQVBFMi4wAwEAAAAh+QQEGQAfACwAAAAACAAIAAAINwAPHMCBAxiwY8cEEjSIUCAECACACAhi4AACCECABBHiEKJEjhYxAtjYMUCQE14EXgRQyguBgAAAIfkEBRkAAAAsBwAHAAEAAQAACAQAAQQEADs=',
  'base64',
);

let inputDir: string;
let outputDir: string;

beforeEach(async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'zit-write-rel-'));
  inputDir = path.join(root, 'in');
  outputDir = path.join(root, 'out');
  await fs.mkdir(inputDir, { recursive: true });
  await fs.mkdir(outputDir, { recursive: true });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(path.dirname(inputDir), { recursive: true, force: true });
});

async function writeJpeg(name: string, width: number, height: number): Promise<string> {
  const buffer = await sharp({
    create: { width, height, channels: 3, background: { r: 20, g: 130, b: 200 } },
  })
    .jpeg()
    .toBuffer();
  const filePath = path.join(inputDir, name);
  await fs.writeFile(filePath, buffer);
  return filePath;
}

async function sizeOf(p: string): Promise<number> {
  return (await fs.stat(p)).size;
}

describe('writeAtomicVia — crash before rename leaves no file at the final path', () => {
  it('cleans up the temp file and never lands a partial output at the target when produce throws', async () => {
    const target = path.join(outputDir, 'out.bin');
    await expect(
      writeAtomicVia(target, async (tmpPath) => {
        // Simulate a process that writes part of the output then "crashes"
        // before the rename can promote it into place.
        await fs.writeFile(tmpPath, 'half-written payload');
        throw new Error('killed mid-write');
      }),
    ).rejects.toThrow('killed mid-write');

    // The final path must not exist — a later cache check would otherwise
    // treat the truncated bytes as a valid hit.
    await expect(fs.access(target)).rejects.toThrow();
    const leftovers = (await fs.readdir(outputDir)).filter((f) => f.endsWith('.tmp'));
    expect(leftovers).toEqual([]);
  });
});

describe('poisoned-cache invalidation — a truncated output at the final path is not served as a hit', () => {
  it('reprocesses a variant whose on-disk size no longer matches the recorded size', async () => {
    await writeJpeg('photo.jpg', 800, 600);
    const first = await processImages({ inputDir, outputDir });
    expect(first.results[0].status).toBe('processed');

    const variantPath = path.join(outputDir, 'photo', '600w.webp');
    const fullSize = await sizeOf(variantPath);
    // Simulate a poisoned entry: a partial file left by a pre-atomic-write crash.
    await fs.truncate(variantPath, Math.max(1, Math.floor(fullSize / 2)));

    const second = await processImages({ inputDir, outputDir });
    expect(second.results[0].status).toBe('processed');
    expect(second.results[0].reason).toBeUndefined();
    // The variant is regenerated to its full, complete size.
    expect(await sizeOf(variantPath)).toBe(fullSize);
  });

  it('reprocesses an OGP output truncated at the final path (ogonly)', async () => {
    await writeJpeg('card__ogonly.jpg', 600, 600);
    const first = await processImages({ inputDir, outputDir });
    expect(first.results[0].status).toBe('processed');

    const ogpPath = path.join(outputDir, 'card', 'ogp.jpg');
    const fullSize = await sizeOf(ogpPath);
    await fs.truncate(ogpPath, Math.max(1, Math.floor(fullSize / 2)));

    const second = await processImages({ inputDir, outputDir });
    expect(second.results[0].status).toBe('processed');
    expect(await sizeOf(ogpPath)).toBe(fullSize);
  });

  it('reprocesses an animated passthrough copy truncated at the final path', async () => {
    await fs.writeFile(path.join(inputDir, 'clip.gif'), ANIMATED_GIF);
    const first = await processImages({ inputDir, outputDir });
    expect(first.results[0].status).toBe('processed');
    expect(first.results[0].animated).toBe(true);

    const passthroughPath = path.join(outputDir, 'clip', 'original.gif');
    const fullSize = await sizeOf(passthroughPath);
    await fs.truncate(passthroughPath, Math.max(1, Math.floor(fullSize / 2)));

    const second = await processImages({ inputDir, outputDir });
    expect(second.results[0].status).toBe('processed');
    expect(await sizeOf(passthroughPath)).toBe(fullSize);
  });

  it('reprocesses once when a legacy cache entry has no recorded output sizes', async () => {
    await writeJpeg('legacy.jpg', 800, 600);
    const first = await processImages({ inputDir, outputDir });
    expect(first.results[0].status).toBe('processed');

    // Strip outputSizes to mimic an entry written before this field existed.
    const cachePath = path.join(outputDir, 'legacy', '.cache.json');
    const entry = await readCache(cachePath);
    expect(entry).not.toBeNull();
    const { outputSizes: _dropped, ...legacy } = entry as NonNullable<typeof entry>;
    await fs.writeFile(cachePath, JSON.stringify(legacy, null, 2));

    // Unverifiable → reprocess once, which rewrites the entry with sizes.
    const second = await processImages({ inputDir, outputDir });
    expect(second.results[0].status).toBe('processed');
    const rewritten = await readCache(cachePath);
    expect(rewritten?.outputSizes).toBeTruthy();

    // With sizes back in place, the following run is a clean cache hit again.
    const third = await processImages({ inputDir, outputDir });
    expect(third.results[0].status).toBe('skipped');
    expect(third.results[0].reason).toBe('cache-hit');
  });
});
