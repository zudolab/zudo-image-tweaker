import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import sharp from 'sharp';

// Mock the HEIF sibling so the dispatch wiring can be tested without the
// heavy WASM decoder — the engine should hand a `.heic` file to it and then
// build variants from the JPEG buffer it returns.
vi.mock('../../heif/index.js', () => ({ convertHeifToJpeg: vi.fn() }));

import { processOne } from '../engine.js';
import { convertHeifToJpeg } from '../../heif/index.js';

const mockConvert = vi.mocked(convertHeifToJpeg);
let jpeg: Buffer;
let dir: string;
let outputDir: string;

beforeAll(async () => {
  jpeg = await sharp({ create: { width: 400, height: 400, channels: 3, background: { r: 4, g: 8, b: 16 } } })
    .jpeg()
    .toBuffer();
});

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'zit-heic-'));
  outputDir = path.join(dir, 'out');
  mockConvert.mockReset();
  mockConvert.mockResolvedValue({ buffer: jpeg, width: 400, height: 400, iccApplied: false });
});

describe('HEIC dispatch', () => {
  it('detects a .heic source, converts via /heif, and builds variants from the result', async () => {
    const heicPath = path.join(dir, 'photo.heic');
    await fs.writeFile(heicPath, Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70])); // ISOBMFF-ish header bytes

    const result = await processOne({ inputPath: heicPath }, { outputDir });

    expect(mockConvert).toHaveBeenCalledWith(heicPath, { quality: 90 });
    expect(result.status).toBe('processed');
    expect(result.metadata?.originalFormat).toBe('heic');
    expect(await fs.readFile(path.join(outputDir, 'photo', '400w.webp'))).toBeInstanceOf(Buffer);
  });
});
