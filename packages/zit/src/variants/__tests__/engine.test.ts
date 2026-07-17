import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import sharp from 'sharp';
import {
  processImages,
  processOne,
  selectVariantWidths,
  VariantProcessingError,
} from '../engine.js';
import { photoVariantsPreset } from '../presets.js';
import type { VariantMetadata } from '../types.js';

// A real 2-frame animated GIF (8x8, produced by ffmpeg) — sharp can't
// synthesize animation, so it's embedded. metadata reports pages=2.
const ANIMATED_GIF = Buffer.from(
  'R0lGODlhCAAIAPcfMQAAACQAAEgAAGwAAJAAALQAANgAAPwAAAAkACQkAEgkAGwkAJAkALQkANgkAPwkAABIACRIAEhIAGxIAJBIALRIANhIAPxIAABsACRsAEhsAGxsAJBsALRsANhsAPxsAACQACSQAEiQAGyQAJCQALSQANiQAPyQAAC0ACS0AEi0AGy0AJC0ALS0ANi0APy0AADYACTYAEjYAGzYAJDYALTYANjYAPzYAAD8ACT8AEj8AGz8AJD8ALT8ANj8APz8AAAAVSQAVUgAVWwAVZAAVbQAVdgAVfwAVQAkVSQkVUgkVWwkVZAkVbQkVdgkVfwkVQBIVSRIVUhIVWxIVZBIVbRIVdhIVfxIVQBsVSRsVUhsVWxsVZBsVbRsVdhsVfxsVQCQVSSQVUiQVWyQVZCQVbSQVdiQVfyQVQC0VSS0VUi0VWy0VZC0VbS0Vdi0Vfy0VQDYVSTYVUjYVWzYVZDYVbTYVdjYVfzYVQD8VST8VUj8VWz8VZD8VbT8Vdj8Vfz8VQAAqiQAqkgAqmwAqpAAqrQAqtgAqvwAqgAkqiQkqkgkqmwkqpAkqrQkqtgkqvwkqgBIqiRIqkhIqmxIqpBIqrRIqthIqvxIqgBsqiRsqkhsqmxsqpBsqrRsqthsqvxsqgCQqiSQqkiQqmyQqpCQqrSQqtiQqvyQqgC0qiS0qki0qmy0qpC0qrS0qti0qvy0qgDYqiTYqkjYqmzYqpDYqrTYqtjYqvzYqgD8qiT8qkj8qmz8qpD8qrT8qtj8qvz8qgAA/yQA/0gA/2wA/5AA/7QA/9gA//wA/wAk/yQk/0gk/2wk/5Ak/7Qk/9gk//wk/wBI/yRI/0hI/2xI/5BI/7RI/9hI//xI/wBs/yRs/0hs/2xs/5Bs/7Rs/9hs//xs/wCQ/ySQ/0iQ/2yQ/5CQ/7SQ/9iQ//yQ/wC0/yS0/0i0/2y0/5C0/7S0/9i0//y0/wDY/yTY/0jY/2zY/5DY/7TY/9jY//zY/wD8/yT8/0j8/2z8/5D8/7T8/9j8//z8/yH/C05FVFNDQVBFMi4wAwEAAAAh+QQEGQAfACwAAAAACAAIAAAINwAPHMCBAxiwY8cEEjSIUCAECACACAhi4AACCECABBHiEKJEjhYxAtjYMUCQE14EXgRQyguBgAAAIfkEBRkAAAAsBwAHAAEAAQAACAQAAQQEADs=',
  'base64',
);

let inputDir: string;
let outputDir: string;

beforeEach(async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'zit-variants-'));
  inputDir = path.join(root, 'in');
  outputDir = path.join(root, 'out');
  await fs.mkdir(inputDir, { recursive: true });
  await fs.mkdir(outputDir, { recursive: true });
});

afterEach(async () => {
  await fs.rm(path.dirname(inputDir), { recursive: true, force: true });
});

async function writeJpeg(
  name: string,
  width: number,
  height: number,
  bg: { r: number; g: number; b: number } = { r: 20, g: 130, b: 200 },
): Promise<string> {
  const buffer = await sharp({ create: { width, height, channels: 3, background: bg } })
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

async function pixelWidth(p: string): Promise<number> {
  return (await sharp(await fs.readFile(p)).metadata()).width ?? 0;
}

async function listSlug(slug: string): Promise<string[]> {
  return (await fs.readdir(path.join(outputDir, slug))).sort();
}

describe('width selection', () => {
  it('never upscales — emits only configured widths that fit the source', () => {
    expect(selectVariantWidths(1000, [600, 900, 1200, 1600, 2000])).toEqual([600, 900]);
    expect(selectVariantWidths(2000, [600, 2000])).toEqual([600, 2000]);
  });

  it('falls back to a single source-width variant when the source is smaller than every width', () => {
    expect(selectVariantWidths(300, [600, 900])).toEqual([300]);
  });
});

describe('processImages — variants', () => {
  it('emits webp variants named `<w>w.webp` for every fitting width, and nothing wider', async () => {
    await writeJpeg('landscape.jpg', 1000, 800);
    const summary = await processImages({ inputDir, outputDir });

    expect(summary.failed).toEqual([]);
    expect(await listSlug('landscape')).toEqual(['.cache.json', '600w.webp', '900w.webp']);
    expect(await pixelWidth(path.join(outputDir, 'landscape', '600w.webp'))).toBe(600);
    expect(await pixelWidth(path.join(outputDir, 'landscape', '900w.webp'))).toBe(900);

    const [result] = summary.results;
    expect(result.metadata).toMatchObject({ slug: 'landscape', width: 1000, height: 800, hasVariants: true });
    expect(result.metadata?.aspectRatio).toBeCloseTo(80, 5);
    expect(result.metadata?.originalFormat).toBe('jpg');
  });

  it('emits a single source-width variant for a tiny image', async () => {
    await writeJpeg('tiny.jpg', 300, 200);
    const summary = await processImages({ inputDir, outputDir });
    expect(await listSlug('tiny')).toEqual(['.cache.json', '300w.webp']);
    expect(await pixelWidth(path.join(outputDir, 'tiny', '300w.webp'))).toBe(300);
    expect(summary.results[0].metadata?.hasVariants).toBe(true);
  });

  it('honours custom widths, formats and output-name function', async () => {
    await writeJpeg('c.jpg', 500, 500);
    await processImages({
      inputDir,
      outputDir,
      widths: [200, 400],
      formats: ['webp'],
      outputName: (w, f) => `img-${w}.${f}`,
    });
    expect(await listSlug('c')).toEqual(['.cache.json', 'img-200.webp', 'img-400.webp']);
  });

  it('auto-orients from EXIF: stored dims are swapped, the variant is upright', async () => {
    const buffer = await sharp({ create: { width: 200, height: 100, channels: 3, background: { r: 9, g: 9, b: 9 } } })
      .withMetadata({ orientation: 6 })
      .jpeg()
      .toBuffer();
    await fs.writeFile(path.join(inputDir, 'rot.jpg'), buffer);

    const summary = await processImages({ inputDir, outputDir });
    expect(summary.results[0].metadata).toMatchObject({ width: 100, height: 200 });
    const variant = await sharp(await fs.readFile(path.join(outputDir, 'rot', '100w.webp'))).metadata();
    expect(variant.width).toBe(100);
    expect(variant.height).toBe(200);
  });
});

describe('processImages — tag dispatch', () => {
  it('routes __og to variants + OGP, __ogonly to OGP only, and plain files to variants only', async () => {
    await writeJpeg('hero__og.jpg', 800, 800);
    await writeJpeg('card__ogonly.jpg', 800, 800);
    await writeJpeg('plain.jpg', 800, 800);

    const summary = await processImages({ inputDir, outputDir });
    expect(summary.failed).toEqual([]);

    expect(await exists(path.join(outputDir, 'hero', '600w.webp'))).toBe(true);
    expect(await exists(path.join(outputDir, 'hero', 'ogp.jpg'))).toBe(true);

    expect(await listSlug('card')).toEqual(['.cache.json', 'ogp.jpg']);

    expect(await exists(path.join(outputDir, 'plain', '600w.webp'))).toBe(true);
    expect(await exists(path.join(outputDir, 'plain', 'ogp.jpg'))).toBe(false);

    const modes = Object.fromEntries(summary.results.map((r) => [r.slug, r.mode]));
    expect(modes).toEqual({ hero: 'og', card: 'ogonly', plain: 'full' });
  });
});

describe('processImages — caching', () => {
  it('skips unchanged inputs, reprocesses on a deleted output, and reprocesses on a content change', async () => {
    const file = await writeJpeg('p.jpg', 800, 600);

    const first = await processImages({ inputDir, outputDir });
    expect(first.results[0].status).toBe('processed');
    expect(await exists(path.join(outputDir, 'p', '.cache.json'))).toBe(true);

    const second = await processImages({ inputDir, outputDir });
    expect(second.results[0].status).toBe('skipped');
    expect(second.results[0].reason).toBe('cache-hit');

    // Missing-output detection: delete a variant and it comes back.
    await fs.rm(path.join(outputDir, 'p', '600w.webp'));
    const third = await processImages({ inputDir, outputDir });
    expect(third.results[0].status).toBe('processed');
    expect(await exists(path.join(outputDir, 'p', '600w.webp'))).toBe(true);

    // Content change invalidates the cache.
    await fs.writeFile(file, await sharp({ create: { width: 800, height: 600, channels: 3, background: { r: 1, g: 2, b: 3 } } }).jpeg().toBuffer());
    const fourth = await processImages({ inputDir, outputDir });
    expect(fourth.results[0].status).toBe('processed');
  });

  it('reprocesses when a newly-added width is not yet on disk', async () => {
    await writeJpeg('w.jpg', 2000, 1500);
    await processImages({ inputDir, outputDir, widths: [600] });
    expect(await exists(path.join(outputDir, 'w', '900w.webp'))).toBe(false);

    const rerun = await processImages({ inputDir, outputDir, widths: [600, 900] });
    expect(rerun.results[0].status).toBe('processed');
    expect(await exists(path.join(outputDir, 'w', '900w.webp'))).toBe(true);
  });
});

describe('processImages — callbacks', () => {
  it('awaits an async onMetadata for every produced and cache-hit image', async () => {
    await writeJpeg('a.jpg', 700, 700);
    await writeJpeg('b.jpg', 700, 700);

    const collected: VariantMetadata[] = [];
    const onMetadata = async (record: VariantMetadata) => {
      await new Promise((r) => setTimeout(r, 5));
      collected.push(record);
    };

    await processImages({ inputDir, outputDir, onMetadata });
    expect(collected.map((r) => r.slug).sort()).toEqual(['a', 'b']);

    // Cache-hit run still replays the metadata callback.
    collected.length = 0;
    await processImages({ inputDir, outputDir, onMetadata });
    expect(collected.map((r) => r.slug).sort()).toEqual(['a', 'b']);
  });
});

describe('processImages — error policy', () => {
  it('collects per-file failures, keeps going, and awaits onError', async () => {
    await writeJpeg('good.jpg', 800, 600);
    // Binary noise (with NUL bytes) that `file` reports as data, not text,
    // and sharp cannot decode — an unrepairable probe failure.
    await fs.writeFile(path.join(inputDir, 'bad.png'), Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe, 0x00, 0x2a, 0x13]));

    const errors: string[] = [];
    const summary = await processImages({
      inputDir,
      outputDir,
      onError: async (report) => {
        await new Promise((r) => setTimeout(r, 5));
        errors.push(report.slug);
      },
    });

    expect(summary.results.map((r) => r.slug)).toEqual(['good']);
    expect(summary.failed).toHaveLength(1);
    expect(summary.failed[0]).toMatchObject({ slug: 'bad', stage: 'probe' });
    expect(errors).toEqual(['bad']); // onError was awaited before the run resolved
    expect(await exists(path.join(outputDir, 'good', '600w.webp'))).toBe(true);
  });

  it('processOne throws a VariantProcessingError carrying the failing stage', async () => {
    const bad = path.join(inputDir, 'x.png');
    await fs.writeFile(bad, Buffer.from([0x00, 0x11, 0x22, 0xff, 0x00, 0x99]));
    await expect(processOne({ inputPath: bad }, { outputDir })).rejects.toBeInstanceOf(
      VariantProcessingError,
    );
    await expect(processOne({ inputPath: bad }, { outputDir })).rejects.toMatchObject({
      stage: 'probe',
    });
  });
});

describe('processImages — animated GIF passthrough', () => {
  it('copies the original and emits no width variants', async () => {
    await fs.writeFile(path.join(inputDir, 'anim.gif'), ANIMATED_GIF);
    const summary = await processImages({ inputDir, outputDir });

    expect(summary.failed).toEqual([]);
    const result = summary.results[0];
    expect(result.animated).toBe(true);
    expect(result.variants).toEqual([]);
    expect(result.metadata?.hasVariants).toBe(false);
    expect(await exists(path.join(outputDir, 'anim', 'original.gif'))).toBe(true);
    expect(await exists(path.join(outputDir, 'anim', '600w.webp'))).toBe(false);
    // The passthrough copy is byte-identical to the source.
    expect(await fs.readFile(path.join(outputDir, 'anim', 'original.gif'))).toEqual(ANIMATED_GIF);
  });
});

describe('processImages — orphan cleanup', () => {
  it('is opt-in and only removes directories directly under the output dir', async () => {
    await writeJpeg('keep.jpg', 400, 400);
    await fs.mkdir(path.join(outputDir, 'orphan'), { recursive: true });
    await fs.writeFile(path.join(outputDir, 'orphan', 'junk.txt'), 'stale');
    await fs.writeFile(path.join(outputDir, 'loose.txt'), 'not a slug dir');

    // Without the flag nothing is removed.
    const noCleanup = await processImages({ inputDir, outputDir });
    expect(noCleanup.removed).toEqual([]);
    expect(await exists(path.join(outputDir, 'orphan'))).toBe(true);

    // With the flag the orphan dir goes; the kept slug and loose file remain.
    const cleaned = await processImages({ inputDir, outputDir, cleanupOrphans: true });
    expect(cleaned.removed).toEqual([path.resolve(outputDir, 'orphan')]);
    expect(await exists(path.join(outputDir, 'orphan'))).toBe(false);
    expect(await exists(path.join(outputDir, 'keep'))).toBe(true);
    expect(await exists(path.join(outputDir, 'loose.txt'))).toBe(true);
  });
});

describe('processImages — safety and cache invalidation', () => {
  it('rejects a source whose slug would escape the output dir', async () => {
    // "...jpg" → basename minus ".jpg" is "..", which would resolve to the
    // parent of outputDir. It must be refused, not written.
    await fs.writeFile(path.join(inputDir, '...jpg'), await sharp({ create: { width: 40, height: 40, channels: 3, background: { r: 0, g: 0, b: 0 } } }).jpeg().toBuffer());
    const summary = await processImages({ inputDir, outputDir });
    expect(summary.results).toEqual([]);
    expect(summary.failed[0]).toMatchObject({ stage: 'slug' });
    expect(await exists(path.resolve(outputDir, '..', '600w.webp'))).toBe(false);
  });

  it('reprocesses an unchanged source when a content-affecting option (quality) changes', async () => {
    await writeJpeg('q.jpg', 800, 600);
    const first = await processImages({ inputDir, outputDir, quality: 85 });
    expect(first.results[0].status).toBe('processed');

    const sameConfig = await processImages({ inputDir, outputDir, quality: 85 });
    expect(sameConfig.results[0].status).toBe('skipped');

    const changed = await processImages({ inputDir, outputDir, quality: 40 });
    expect(changed.results[0].status).toBe('processed');
  });

  it('rejects duplicate output slugs instead of racing on one directory', async () => {
    await writeJpeg('dup.jpg', 500, 500);
    await writeJpeg('dup.png', 500, 500); // same slug "dup" from a different extension
    const summary = await processImages({ inputDir, outputDir });

    expect(summary.results).toEqual([]);
    expect(summary.failed).toHaveLength(2);
    expect(summary.failed.every((f) => f.stage === 'slug' && f.slug === 'dup')).toBe(true);
  });
});

describe('processImages — animated __og', () => {
  it('emits both the passthrough and an OGP card from the first frame', async () => {
    await fs.writeFile(path.join(inputDir, 'clip__og.gif'), ANIMATED_GIF);
    const summary = await processImages({ inputDir, outputDir });

    expect(summary.failed).toEqual([]);
    expect(summary.results[0].animated).toBe(true);
    expect(await exists(path.join(outputDir, 'clip', 'original.gif'))).toBe(true);
    expect(await exists(path.join(outputDir, 'clip', 'ogp.jpg'))).toBe(true);
    // A second run is a cache hit only if the OGP is part of expected outputs.
    const rerun = await processImages({ inputDir, outputDir });
    expect(rerun.results[0].status).toBe('skipped');
  });
});

describe('photoVariantsPreset', () => {
  it('uses the [400, 800, 1600] ladder, disables tag dispatch, and strips metadata', async () => {
    await writeJpeg('shot.jpg', 1200, 900);
    // A __og-looking name must NOT trigger OGP under the preset.
    await writeJpeg('framed__og.jpg', 1200, 900);

    const summary = await processImages({ ...photoVariantsPreset, inputDir, outputDir });
    expect(summary.failed).toEqual([]);

    expect(await listSlug('shot')).toEqual(['.cache.json', '400w.webp', '800w.webp']);
    expect(await exists(path.join(outputDir, 'shot', '1600w.webp'))).toBe(false);

    // Tag dispatch off: slug keeps the suffix and no OGP is generated.
    expect(await exists(path.join(outputDir, 'framed__og', '400w.webp'))).toBe(true);
    expect(await exists(path.join(outputDir, 'framed__og', 'ogp.jpg'))).toBe(false);

    const variant = await sharp(await fs.readFile(path.join(outputDir, 'shot', '400w.webp'))).metadata();
    expect(variant.orientation).toBeUndefined();
  });
});
