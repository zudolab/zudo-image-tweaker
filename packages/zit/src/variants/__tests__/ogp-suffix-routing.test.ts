/**
 * Engine-level `__og` / `__ogonly` suffix-routing scenarios not already
 * covered by tags.test.ts (parser unit tests) or engine.test.ts's "tag
 * dispatch" test (which only exercises the exact-suffix, single-underscore,
 * inputDir-scan case).
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { processImages } from '../engine.js';

let inputDir: string;
let outputDir: string;

beforeEach(async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'zit-ogp-suffix-'));
  inputDir = path.join(root, 'in');
  outputDir = path.join(root, 'out');
  await fs.mkdir(inputDir, { recursive: true });
  await fs.mkdir(outputDir, { recursive: true });
});

afterEach(async () => {
  await fs.rm(path.dirname(inputDir), { recursive: true, force: true });
});

async function writeJpeg(name: string, dir: string = inputDir): Promise<string> {
  const buffer = await sharp({
    create: { width: 400, height: 400, channels: 3, background: { r: 40, g: 90, b: 160 } },
  })
    .jpeg()
    .toBuffer();
  const filePath = path.join(dir, name);
  await fs.writeFile(filePath, buffer);
  return filePath;
}

async function exists(p: string): Promise<boolean> {
  return fs.access(p).then(
    () => true,
    () => false,
  );
}

describe('OGP suffix routing — __og in the middle of the name is not a directive', () => {
  it('does not trigger OGP for a filename that merely contains "__og" before other characters', async () => {
    await writeJpeg('product__ogtest.jpg');
    const summary = await processImages({ inputDir, outputDir });

    expect(summary.failed).toEqual([]);
    const [result] = summary.results;
    expect(result.mode).toBe('full');
    expect(result.slug).toBe('product__ogtest');
    expect(await exists(path.join(outputDir, 'product__ogtest', 'ogp.jpg'))).toBe(false);
    expect(await exists(path.join(outputDir, 'product__ogtest', '400w.webp'))).toBe(true);
  });

  it('does not confuse "__ogonlyish" (suffix-like but not exact) for the ogonly directive', async () => {
    await writeJpeg('banner__ogonlyish.jpg');
    const summary = await processImages({ inputDir, outputDir });

    expect(summary.results[0].mode).toBe('full');
    expect(await exists(path.join(outputDir, 'banner__ogonlyish', 'ogp.jpg'))).toBe(false);
  });
});

describe('OGP suffix routing — only the trailing suffix is stripped', () => {
  it('keeps an earlier "__" segment in the slug and only strips the true trailing __og suffix', async () => {
    await writeJpeg('my__cool__og.jpg');
    const summary = await processImages({ inputDir, outputDir });

    expect(summary.failed).toEqual([]);
    const [result] = summary.results;
    expect(result.mode).toBe('og');
    expect(result.slug).toBe('my__cool');
    expect(await exists(path.join(outputDir, 'my__cool', 'ogp.jpg'))).toBe(true);
    expect(await exists(path.join(outputDir, 'my__cool', '400w.webp'))).toBe(true);
  });

  it('keeps an earlier "__" segment in the slug and only strips the true trailing __ogonly suffix', async () => {
    await writeJpeg('summer__sale__ogonly.jpg');
    const summary = await processImages({ inputDir, outputDir });

    const [result] = summary.results;
    expect(result.mode).toBe('ogonly');
    expect(result.slug).toBe('summer__sale');
    expect(await exists(path.join(outputDir, 'summer__sale', 'ogp.jpg'))).toBe(true);
    expect(await exists(path.join(outputDir, 'summer__sale', '400w.webp'))).toBe(false);
  });
});

describe('OGP suffix routing — explicit files list (not just inputDir scanning)', () => {
  it('routes __og/__ogonly/plain correctly when files are supplied via the explicit `files` option', async () => {
    const hero = await writeJpeg('hero__og.jpg');
    const card = await writeJpeg('card__ogonly.jpg');
    const plain = await writeJpeg('plain.jpg');

    const summary = await processImages({ outputDir, files: [hero, card, plain] });

    expect(summary.failed).toEqual([]);
    const modes = Object.fromEntries(summary.results.map((r) => [r.slug, r.mode]));
    expect(modes).toEqual({ hero: 'og', card: 'ogonly', plain: 'full' });
    expect(await exists(path.join(outputDir, 'hero', 'ogp.jpg'))).toBe(true);
    expect(await exists(path.join(outputDir, 'card', '400w.webp'))).toBe(false);
    expect(await exists(path.join(outputDir, 'plain', 'ogp.jpg'))).toBe(false);
  });

  it('routes a source outside inputDir supplied via `files`, ignoring its directory components for the slug', async () => {
    const elsewhere = await fs.mkdtemp(path.join(os.tmpdir(), 'zit-ogp-elsewhere-'));
    try {
      const outside = await writeJpeg('featured__og.jpg', elsewhere);
      const summary = await processImages({ outputDir, files: [outside] });

      expect(summary.failed).toEqual([]);
      expect(summary.results[0]).toMatchObject({ slug: 'featured', mode: 'og' });
      expect(await exists(path.join(outputDir, 'featured', 'ogp.jpg'))).toBe(true);
    } finally {
      await fs.rm(elsewhere, { recursive: true, force: true });
    }
  });
});
