import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import sharp from 'sharp';

// Force blurhash encoding to fail so the fallback behaviour can be observed.
vi.mock('../../blurhash/index.js', () => ({
  encodeImageToBlurhash: vi.fn().mockRejectedValue(new Error('encode failed')),
}));

import { processOne } from '../engine.js';

let dir: string;
let outputDir: string;
let jpegPath: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'zit-blurhash-'));
  outputDir = path.join(dir, 'out');
  jpegPath = path.join(dir, 'img.jpg');
  await fs.writeFile(
    jpegPath,
    await sharp({ create: { width: 800, height: 600, channels: 3, background: { r: 7, g: 7, b: 7 } } })
      .jpeg()
      .toBuffer(),
  );
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('blurhash fallback', () => {
  it('records the configured fallbackBlurhash when encoding fails', async () => {
    const result = await processOne({ inputPath: jpegPath }, { outputDir, fallbackBlurhash: 'LKO2:N%2Tw=w' });
    expect(result.metadata?.blurhash).toBe('LKO2:N%2Tw=w');
  });

  it('records null (no baked-in literal) when encoding fails and no fallback is configured', async () => {
    const result = await processOne({ inputPath: jpegPath }, { outputDir });
    expect(result.metadata?.blurhash).toBeNull();
  });
});
