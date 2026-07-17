import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { alphaTrim, composeProductPhoto } from '../index.js';
import type { ComposeProductPhotoOptions } from '../index.js';

async function createTransparentSquarePng(canvasSize: number, squareSize: number): Promise<Buffer> {
  const channels = 4;
  const raw = Buffer.alloc(canvasSize * canvasSize * channels, 0);
  const offset = Math.round((canvasSize - squareSize) / 2);
  for (let y = offset; y < offset + squareSize; y++) {
    for (let x = offset; x < offset + squareSize; x++) {
      const i = (y * canvasSize + x) * channels;
      raw[i] = 200;
      raw[i + 1] = 50;
      raw[i + 2] = 50;
      raw[i + 3] = 255;
    }
  }
  return sharp(raw, { raw: { width: canvasSize, height: canvasSize, channels } }).png().toBuffer();
}

describe('alphaTrim', () => {
  it('trims fully-transparent padding down to the opaque content', async () => {
    const padded = await createTransparentSquarePng(200, 40);
    const trimmed = await alphaTrim(padded);
    const meta = await sharp(trimmed).metadata();
    expect(meta.width).toBeLessThan(200);
    expect(meta.height).toBeLessThan(200);
    expect(meta.width).toBeGreaterThanOrEqual(38);
  });

  it('respects a custom threshold', async () => {
    const padded = await createTransparentSquarePng(200, 40);
    const trimmed = await alphaTrim(padded, { threshold: 1 });
    const meta = await sharp(trimmed).metadata();
    expect(meta.width).toBeLessThan(200);
  });
});

describe('composeProductPhoto', () => {
  it('requires a background', async () => {
    const subject = await createTransparentSquarePng(300, 100);
    // @ts-expect-error — intentionally omitting the required `background` to exercise the runtime guard
    await expect(composeProductPhoto(subject, {})).rejects.toThrow(/background/i);
  });

  it('composes onto a flat color background at the default canvas size', async () => {
    const subject = await createTransparentSquarePng(300, 100);
    const result = await composeProductPhoto(subject, { background: { color: '#ffffff' } });

    expect(result.format).toBe('jpeg');
    expect(result.width).toBe(1600);
    expect(result.height).toBe(1600);

    const meta = await sharp(result.buffer).metadata();
    expect(meta.format).toBe('jpeg');
    expect(meta.width).toBe(1600);
  });

  it('respects custom size, fit, and quality', async () => {
    const subject = await createTransparentSquarePng(300, 100);
    const result = await composeProductPhoto(subject, {
      background: { color: '#112233' },
      size: 400,
      fit: 300,
      quality: 60,
    });

    expect(result.width).toBe(400);
    expect(result.height).toBe(400);
  });

  it('scales the default fit with a custom size instead of staying pinned to 1440', async () => {
    const subject = await createTransparentSquarePng(300, 100);
    // A canvas smaller than the default 1440px container must not throw —
    // the default fit should scale down (90% of size) rather than overflow it.
    const result = await composeProductPhoto(subject, { background: { color: '#ffffff' }, size: 400 });

    expect(result.width).toBe(400);
    expect(result.height).toBe(400);
  });

  it('composes onto an image background', async () => {
    const subject = await createTransparentSquarePng(300, 100);
    const background = await sharp({
      create: { width: 500, height: 500, channels: 3, background: { r: 10, g: 200, b: 10 } },
    })
      .jpeg()
      .toBuffer();

    const result = await composeProductPhoto(subject, { background, size: 500, fit: 400 });
    expect(result.width).toBe(500);
    expect(result.height).toBe(500);
  });

  it('changes the output when shadow: true is set', async () => {
    const subject = await createTransparentSquarePng(300, 100);
    const options: Omit<ComposeProductPhotoOptions, 'shadow'> = {
      background: { color: '#ffffff' },
      size: 300,
      fit: 200,
    };

    const withoutShadow = await composeProductPhoto(subject, options);
    const withShadow = await composeProductPhoto(subject, { ...options, shadow: true });

    expect(withShadow.buffer.equals(withoutShadow.buffer)).toBe(false);
  });

  it('forwards shadow tuning options through the shadow object form', async () => {
    const subject = await createTransparentSquarePng(300, 100);
    const base = { background: { color: '#ffffff' } as const, size: 300, fit: 200 };

    const grounded = await composeProductPhoto(subject, { ...base, shadow: { mode: 'grounded' } });
    const floating = await composeProductPhoto(subject, { ...base, shadow: { mode: 'floating' } });

    expect(grounded.buffer.equals(floating.buffer)).toBe(false);
  });
});
