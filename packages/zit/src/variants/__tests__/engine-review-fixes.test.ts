/**
 * Regression tests for the seven code-review fixes tracked in issue #23.
 * Each `describe` below pins one previously-broken behaviour in the variants
 * engine so it can't silently regress.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { processImages } from '../engine.js';
import { readCache } from '../hash-cache.js';
import type { ParsedTag } from '../types.js';

// A real 2-frame animated GIF (8x8) — sharp can't synthesise animation, so
// it's embedded; metadata reports pages=2. Matches engine.test.ts's fixture.
const ANIMATED_GIF = Buffer.from(
  'R0lGODlhCAAIAPcfMQAAACQAAEgAAGwAAJAAALQAANgAAPwAAAAkACQkAEgkAGwkAJAkALQkANgkAPwkAABIACRIAEhIAGxIAJBIALRIANhIAPxIAABsACRsAEhsAGxsAJBsALRsANhsAPxsAACQACSQAEiQAGyQAJCQALSQANiQAPyQAAC0ACS0AEi0AGy0AJC0ALS0ANi0APy0AADYACTYAEjYAGzYAJDYALTYANjYAPzYAAD8ACT8AEj8AGz8AJD8ALT8ANj8APz8AAAAVSQAVUgAVWwAVZAAVbQAVdgAVfwAVQAkVSQkVUgkVWwkVZAkVbQkVdgkVfwkVQBIVSRIVUhIVWxIVZBIVbRIVdhIVfxIVQBsVSRsVUhsVWxsVZBsVbRsVdhsVfxsVQCQVSSQVUiQVWyQVZCQVbSQVdiQVfyQVQC0VSS0VUi0VWy0VZC0VbS0Vdi0Vfy0VQDYVSTYVUjYVWzYVZDYVbTYVdjYVfzYVQD8VST8VUj8VWz8VZD8VbT8Vdj8Vfz8VQAAqiQAqkgAqmwAqpAAqrQAqtgAqvwAqgAkqiQkqkgkqmwkqpAkqrQkqtgkqvwkqgBIqiRIqkhIqmxIqpBIqrRIqthIqvxIqgBsqiRsqkhsqmxsqpBsqrRsqthsqvxsqgCQqiSQqkiQqmyQqpCQqrSQqtiQqvyQqgC0qiS0qki0qmy0qpC0qrS0qti0qvy0qgDYqiTYqkjYqmzYqpDYqrTYqtjYqvzYqgD8qiT8qkj8qmz8qpD8qrT8qtj8qvz8qgAA/yQA/0gA/2wA/5AA/7QA/9gA//wA/wAk/yQk/0gk/2wk/5Ak/7Qk/9gk//wk/wBI/yRI/0hI/2xI/5BI/7RI/9hI//xI/wBs/yRs/0hs/2xs/5Bs/7Rs/9hs//xs/wCQ/ySQ/0iQ/2yQ/5CQ/7SQ/9iQ//yQ/wC0/yS0/0i0/2y0/5C0/7S0/9i0//y0/wDY/yTY/0jY/2zY/5DY/7TY/9jY//zY/wD8/yT8/0j8/2z8/5D8/7T8/9j8//z8/yH/C05FVFNDQVBFMi4wAwEAAAAh+QQEGQAfACwAAAAACAAIAAAINwAPHMCBAxiwY8cEEjSIUCAECACACAhi4AACCECABBHiEKJEjhYxAtjYMUCQE14EXgRQyguBgAAAIfkEBRkAAAAsBwAHAAEAAQAACAQAAQQEADs=',
  'base64',
);

let inputDir: string;
let outputDir: string;

beforeEach(async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'zit-review-fixes-'));
  inputDir = path.join(root, 'in');
  outputDir = path.join(root, 'out');
  await fs.mkdir(inputDir, { recursive: true });
  await fs.mkdir(outputDir, { recursive: true });
});

afterEach(async () => {
  await fs.rm(path.dirname(inputDir), { recursive: true, force: true });
});

async function writeJpeg(name: string, width = 800, height = 800): Promise<string> {
  const buffer = await sharp({
    create: { width, height, channels: 3, background: { r: 20, g: 130, b: 200 } },
  })
    .jpeg()
    .toBuffer();
  const filePath = path.join(inputDir, name);
  await fs.writeFile(filePath, buffer);
  return filePath;
}

async function exists(p: string): Promise<boolean> {
  return fs.access(p).then(
    () => true,
    () => false,
  );
}

// Fix 1 — engine.ts:498
describe('processImages — a throwing custom tagParser', () => {
  it('records a slug-stage failure and keeps processing the other files', async () => {
    await writeJpeg('good.jpg', 400, 400);
    await writeJpeg('bad.jpg', 400, 400);

    // Throws for one specific file; the whole batch used to reject.
    const tagParser = (filename: string): ParsedTag => {
      if (filename.startsWith('bad')) throw new Error('tagParser boom');
      return { mode: 'full', slug: path.basename(filename, path.extname(filename)) };
    };

    const summary = await processImages({ inputDir, outputDir, tagParser });

    expect(summary.results.map((r) => r.slug)).toEqual(['good']);
    expect(summary.failed).toHaveLength(1);
    expect(summary.failed[0]).toMatchObject({ slug: 'bad.jpg', stage: 'slug' });
    expect(summary.failed[0].error).toMatch(/boom/);
    expect(await exists(path.join(outputDir, 'good', '400w.webp'))).toBe(true);
  });
});

// Fix 2 — engine.ts:457
describe('processImages — concurrency validation', () => {
  it('rejects a non-finite or non-positive concurrency instead of silently no-oping', async () => {
    await writeJpeg('x.jpg', 400, 400);
    await expect(processImages({ inputDir, outputDir, concurrency: Number.NaN })).rejects.toThrow(
      /concurrency/i,
    );
    await expect(processImages({ inputDir, outputDir, concurrency: 0 })).rejects.toThrow(
      /concurrency/i,
    );
    await expect(
      processImages({ inputDir, outputDir, concurrency: Number.POSITIVE_INFINITY }),
    ).rejects.toThrow(/concurrency/i);
    // A valid concurrency still processes normally.
    const ok = await processImages({ inputDir, outputDir, concurrency: 2 });
    expect(ok.results.map((r) => r.slug)).toEqual(['x']);
  });
});

// Fix 3 — engine.ts:299
describe('processImages — cache invalidates on a tag-mode change', () => {
  it('reprocesses when a source is renamed __og -> __ogonly with identical bytes', async () => {
    const ogPath = await writeJpeg('photo__og.jpg', 800, 800);
    const first = await processImages({ outputDir, files: [ogPath] });
    expect(first.results[0]).toMatchObject({ slug: 'photo', mode: 'og', status: 'processed' });
    expect(first.results[0].metadata).not.toBeNull();
    expect(await exists(path.join(outputDir, 'photo', '600w.webp'))).toBe(true);
    expect(await exists(path.join(outputDir, 'photo', 'ogp.jpg'))).toBe(true);

    // Same bytes, only the tag changes — the __og outputs must NOT satisfy
    // the __ogonly expected-output subset as a stale cache hit.
    const ogonlyPath = path.join(inputDir, 'photo__ogonly.jpg');
    await fs.copyFile(ogPath, ogonlyPath);
    const second = await processImages({ outputDir, files: [ogonlyPath] });

    expect(second.results[0]).toMatchObject({
      slug: 'photo',
      mode: 'ogonly',
      status: 'processed',
    });
    expect(second.results[0].metadata).toBeNull();
  });
});

// Fix 4 — engine.ts:130
describe('processImages — the naming scheme is part of the cache identity', () => {
  it('does not accept stale files left by an older run under a different naming scheme', async () => {
    await writeJpeg('n.jpg', 800, 600);
    const schemeA = (w: number, f: string) => `a-${w}.${f}`;
    const schemeB = (w: number, f: string) => `b-${w}.${f}`;

    // Run 1: scheme A at one quality → leaves a-600.webp on disk.
    await processImages({ inputDir, outputDir, quality: 85, outputName: schemeA });
    expect(await exists(path.join(outputDir, 'n', 'a-600.webp'))).toBe(true);

    // Run 2: scheme B at a different quality → the cache now describes scheme
    // B; the scheme-A file lingers, now stale (encoded at the old quality).
    await processImages({ inputDir, outputDir, quality: 40, outputName: schemeB });

    // Run 3: back to scheme A at the new quality. The lingering a-600.webp
    // must not be accepted — the stored output manifest doesn't match the
    // scheme-B cache entry, forcing a reprocess.
    const rerun = await processImages({ inputDir, outputDir, quality: 40, outputName: schemeA });
    expect(rerun.results[0].status).toBe('processed');
  });

  // Self-review (codex finding B): the manifest also covers the sub-min-width
  // fallback filename, which a fingerprint of only the configured widths can't.
  it('covers the source-width fallback filename, not just the configured widths', async () => {
    // A tiny source (narrower than every configured width) only emits the
    // single fallback variant at its own width.
    await writeJpeg('tiny.jpg', 300, 300);
    // Two schemes that AGREE at the configured widths but DIFFER at the
    // fallback width — so a fingerprint sampled over configured widths alone
    // would collide and miss the difference.
    const schemeA = (w: number, f: string) => `img-${w}.${f}`;
    const schemeB = (w: number, f: string) => (w >= 600 ? `img-${w}.${f}` : `alt-${w}.${f}`);

    await processImages({ inputDir, outputDir, quality: 85, outputName: schemeA, widths: [600, 900] });
    expect(await exists(path.join(outputDir, 'tiny', 'img-300.webp'))).toBe(true);

    // Scheme B at a different quality → reprocesses (config differs), leaving
    // img-300.webp stale on disk while the cache now describes scheme B.
    await processImages({ inputDir, outputDir, quality: 40, outputName: schemeB, widths: [600, 900] });

    // Back to scheme A at the new quality: the stale img-300.webp must not be
    // accepted as a hit — the manifest ['alt-300.webp'] doesn't match.
    const rerun = await processImages({
      inputDir,
      outputDir,
      quality: 40,
      outputName: schemeA,
      widths: [600, 900],
    });
    expect(rerun.results[0].status).toBe('processed');
  });
});

// Self-review (codex finding A): fix 1 must not let orphan cleanup delete the
// still-backed outputs of an input whose tagParser threw this run.
describe('processImages — cleanup is skipped when a tagParser throws', () => {
  it('does not delete a failed input\'s existing output directory as an orphan', async () => {
    await writeJpeg('keep.jpg', 400, 400);

    // First run (default parser): produce the output directory.
    await processImages({ inputDir, outputDir });
    expect(await exists(path.join(outputDir, 'keep', '400w.webp'))).toBe(true);

    // Second run with a parser that throws for keep.jpg AND cleanupOrphans on.
    // keep.jpg is absent from `entries`, so its slug can't enter the keep-set;
    // cleanup must be skipped rather than delete outputDir/keep.
    const tagParser = (filename: string): ParsedTag => {
      if (filename.startsWith('keep')) throw new Error('parser down');
      return { mode: 'full', slug: path.basename(filename, path.extname(filename)) };
    };
    const summary = await processImages({ inputDir, outputDir, tagParser, cleanupOrphans: true });

    expect(summary.failed).toHaveLength(1);
    expect(summary.failed[0]).toMatchObject({ stage: 'slug' });
    expect(summary.removed).toEqual([]);
    // The previously-generated output survived the failed run.
    expect(await exists(path.join(outputDir, 'keep', '400w.webp'))).toBe(true);
  });
});

// Fix 5 — engine.ts:401
describe('processImages — OGP failure stage in the full pipeline', () => {
  it('reports an OGP-specific failure as stage "ogp", not "variants", after variants succeed', async () => {
    await writeJpeg('hero__og.jpg', 800, 800);

    // An invalid OGP canvas width makes only the OGP step throw (a
    // non-corruption error, so no repair retry); the width variants, which
    // don't consult ogpOptions, still succeed first.
    const summary = await processImages({
      inputDir,
      outputDir,
      ogpOptions: { width: -1 },
    });

    expect(summary.results).toEqual([]);
    expect(summary.failed).toHaveLength(1);
    expect(summary.failed[0]).toMatchObject({ slug: 'hero', stage: 'ogp' });
    // Variants were written before the OGP step failed.
    expect(await exists(path.join(outputDir, 'hero', '600w.webp'))).toBe(true);
    expect(await exists(path.join(outputDir, 'hero', 'ogp.jpg'))).toBe(false);
  });
});

// Fix 6 — engine.ts:355
describe('processImages — animated __ogonly reports animation', () => {
  it('reports animated:true for an animated GIF tagged __ogonly, in the result and the cache', async () => {
    await fs.writeFile(path.join(inputDir, 'clip__ogonly.gif'), ANIMATED_GIF);

    const summary = await processImages({ inputDir, outputDir });
    expect(summary.failed).toEqual([]);
    const result = summary.results[0];
    expect(result).toMatchObject({
      slug: 'clip',
      mode: 'ogonly',
      status: 'processed',
      animated: true,
    });
    expect(result.metadata).toBeNull();
    expect(await exists(path.join(outputDir, 'clip', 'ogp.jpg'))).toBe(true);

    // The cache entry recorded animated:true, so a cache-hit rerun agrees.
    const rerun = await processImages({ inputDir, outputDir });
    expect(rerun.results[0]).toMatchObject({ status: 'skipped', animated: true });
  });
});

// Cache-shape note (fixes 3 + 4) — an older-format entry lacking `mode`.
describe('processImages — pre-mode (older-format) cache entries', () => {
  it('treats an entry without a mode field as a miss and reprocesses without crashing', async () => {
    await writeJpeg('legacy.jpg', 800, 600);
    const first = await processImages({ inputDir, outputDir });
    expect(first.results[0].status).toBe('processed');

    // Rewrite the sidecar in the pre-fix shape: drop the fields this change
    // added (`mode` and `outputs`) entirely.
    const cachePath = path.join(outputDir, 'legacy', '.cache.json');
    const entry = await readCache(cachePath);
    expect(entry).not.toBeNull();
    const legacy = { ...(entry as unknown as Record<string, unknown>) };
    delete legacy.mode;
    delete legacy.outputs;
    await fs.writeFile(cachePath, JSON.stringify(legacy, null, 2));

    // A rerun must not crash and must reprocess (mode mismatch -> miss).
    const second = await processImages({ inputDir, outputDir });
    expect(second.failed).toEqual([]);
    expect(second.results[0].status).toBe('processed');

    // And the rewritten sidecar now carries the current shape again.
    const rehydrated = await readCache(cachePath);
    expect(rehydrated?.mode).toBe('full');
  });
});
