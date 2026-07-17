import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import sharp from 'sharp';

vi.mock('../run.js', () => ({
  run: vi.fn(),
  isMissingBinaryError: (error: unknown) =>
    (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT',
}));

import { resetFeatureDetectionCache } from '../feature-detect.js';
import { isCorruptionError, repairCorruptedImage } from '../repair.js';
import { run } from '../run.js';

const mockRun = vi.mocked(run);
let validJpeg: Buffer;
let inputPath: string;

function enoent(): NodeJS.ErrnoException {
  return Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' });
}

/** Mock impl: version probes for `only` succeed; a real invocation writes a valid JPEG to its last arg. */
function toolPresent(only: 'magick' | 'ffmpeg' | 'both') {
  return async (command: string, args: string[]) => {
    const present = only === 'both' || command === only;
    if (args.includes('-version')) {
      if (present) return { stdout: '', stderr: '' };
      throw enoent();
    }
    const outputPath = args[args.length - 1];
    await fsPromises.writeFile(outputPath, validJpeg);
    return { stdout: '', stderr: '' };
  };
}

beforeAll(async () => {
  validJpeg = await sharp({
    create: { width: 8, height: 8, channels: 3, background: { r: 1, g: 2, b: 3 } },
  })
    .jpeg()
    .toBuffer();
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'zit-repair-'));
  inputPath = path.join(dir, 'broken.jpg');
  await fsPromises.writeFile(inputPath, Buffer.from([0xff, 0xd8, 0x00, 0x00])); // truncated JPEG-ish
});

beforeEach(() => {
  resetFeatureDetectionCache();
  mockRun.mockReset();
});

describe('isCorruptionError', () => {
  it('recognises libvips/sharp corruption signatures only', () => {
    expect(isCorruptionError(new Error('VipsJpeg: Premature end of JPEG file'))).toBe(true);
    expect(isCorruptionError(new Error('bad Huffman code'))).toBe(true);
    expect(isCorruptionError(new Error('libspng read error'))).toBe(true);
    expect(isCorruptionError(new Error('Input buffer has unsupported image format'))).toBe(false);
    expect(isCorruptionError(undefined)).toBe(false);
  });
});

describe('repairCorruptedImage', () => {
  it('repairs via ImageMagick when available, returning a decodable buffer', async () => {
    mockRun.mockImplementation(toolPresent('magick'));
    const repaired = await repairCorruptedImage(inputPath);
    expect(repaired).not.toBeNull();
    await expect(sharp(repaired!).metadata()).resolves.toMatchObject({ width: 8, height: 8 });
    // magick is invoked with an argument array (input + flags + output), never a shell string.
    const magickCall = mockRun.mock.calls.find((c) => c[0] === 'magick' && !c[1].includes('-version'));
    expect(Array.isArray(magickCall?.[1])).toBe(true);
    expect(magickCall?.[1][0]).toBe(inputPath);
  });

  it('falls back to ffmpeg on a plain-Linux host without magick', async () => {
    mockRun.mockImplementation(toolPresent('ffmpeg'));
    const repaired = await repairCorruptedImage(inputPath);
    expect(repaired).not.toBeNull();
    await expect(sharp(repaired!).metadata()).resolves.toMatchObject({ width: 8 });
    expect(mockRun.mock.calls.some((c) => c[0] === 'ffmpeg' && !c[1].includes('-version'))).toBe(true);
  });

  it('warns and skips (returns null) when neither magick nor ffmpeg is installed — never throws', async () => {
    mockRun.mockRejectedValue(enoent());
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const repaired = await repairCorruptedImage(inputPath);
    expect(repaired).toBeNull();
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });
});
