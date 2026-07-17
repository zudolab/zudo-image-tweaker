import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import sharp from 'sharp';

// Keep isCorruptionError real; stub only the external-tool repair so the
// variant-stage retry can be exercised deterministically.
vi.mock('../repair.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../repair.js')>();
  return { ...actual, repairCorruptedImage: vi.fn() };
});

import { processOne, VariantProcessingError } from '../engine.js';
import { repairCorruptedImage } from '../repair.js';

const mockRepair = vi.mocked(repairCorruptedImage);
let validJpeg: Buffer;
let dir: string;
let outputDir: string;
let truncatedPath: string;

beforeAll(async () => {
  validJpeg = await sharp({ create: { width: 1200, height: 1200, channels: 3, background: { r: 30, g: 90, b: 150 } } })
    .jpeg({ quality: 92 })
    .toBuffer();
});

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'zit-engine-repair-'));
  outputDir = path.join(dir, 'out');
  // Header stays valid (metadata() succeeds) but the pixel stream is cut —
  // the decode inside variant generation raises "premature end of JPEG".
  truncatedPath = path.join(dir, 'truncated.jpg');
  await fs.writeFile(truncatedPath, validJpeg.subarray(0, Math.floor(validJpeg.length * 0.5)));
  mockRepair.mockReset();
});

describe('variant-stage corruption repair', () => {
  it('repairs the original and retries when decode fails after a passing metadata probe', async () => {
    mockRepair.mockResolvedValue(validJpeg);
    const result = await processOne({ inputPath: truncatedPath }, { outputDir });

    expect(result.status).toBe('processed');
    expect(mockRepair).toHaveBeenCalledTimes(1);
    expect(mockRepair).toHaveBeenCalledWith(truncatedPath);
    expect(await fs.readFile(path.join(outputDir, 'truncated', '600w.webp'))).toBeInstanceOf(Buffer);
  });

  it('fails cleanly when repair is unavailable', async () => {
    mockRepair.mockResolvedValue(null);
    await expect(processOne({ inputPath: truncatedPath }, { outputDir })).rejects.toBeInstanceOf(
      VariantProcessingError,
    );
  });

  it("tags a failed retry with stage 'variants' instead of a raw untagged error (#45)", async () => {
    // Repair "succeeds" but hands back bytes that are still pixel-truncated,
    // so the retried pipeline fails exactly like the first attempt did.
    mockRepair.mockResolvedValue(validJpeg.subarray(0, Math.floor(validJpeg.length * 0.5)));
    await expect(processOne({ inputPath: truncatedPath }, { outputDir })).rejects.toMatchObject({
      name: 'VariantProcessingError',
      stage: 'variants',
    });
  });
});
