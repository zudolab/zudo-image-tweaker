/**
 * @verification — proof that HEIC input paths containing spaces are passed
 * as argv/fs-call elements, never through a shell string. `convertHeifToJpeg`
 * feature-detects `sips` via `execFile` with an argument array (never a
 * shell string), and `convertHeifToJpegNode` reads the path via
 * `fs.readFile` directly — neither goes through shell interpolation, so a
 * space in the path can never cause token-splitting.
 */

import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import sharp from 'sharp';
import { convertHeifToJpeg } from '../index.js';

let tmpDirWithSpace: string;

beforeAll(async () => {
  tmpDirWithSpace = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'heif convert test '));
});

afterAll(async () => {
  if (tmpDirWithSpace) {
    await fsPromises.rm(tmpDirWithSpace, { recursive: true, force: true });
  }
});

describe('HEIC path-with-space safety', () => {
  test('convertHeifToJpeg succeeds when the input path contains a space', async () => {
    const source = path.join(
      path.dirname(new URL(import.meta.url).pathname),
      'fixtures',
      'tmap-gainmap.heic',
    );
    const spacedPath = path.join(tmpDirWithSpace, 'test image with spaces.heic');
    await fsPromises.copyFile(source, spacedPath);

    // On this (Linux) test environment `sips` is absent, so this exercises
    // the ENOENT -> Node fallback branch with a space-containing path end
    // to end; on macOS it would exercise `sips` directly via execFile's
    // argument array, which is equally space-safe.
    const result = await convertHeifToJpeg(spacedPath);

    const metadata = await sharp(result.buffer).metadata();
    expect(metadata.width).toBe(3024);
    expect(metadata.height).toBe(3024);
  });
});
