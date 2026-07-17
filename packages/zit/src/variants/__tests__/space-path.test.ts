/**
 * @verification — proof that paths containing spaces survive the engine's
 * external-process and filesystem calls unmangled: `run()` (variants/run.ts)
 * always invokes `execFile` with an argument array, never a shell string, so
 * a space in a path can never cause token-splitting. This exercises the real
 * `file` binary (unmocked, unlike heic-detect.test.ts) plus the full
 * `processOne` pipeline end to end with spaces in both the input and output
 * directory paths.
 *
 * The `file` probe is feature-detected and skipped with a visible reason on
 * a runner that lacks the `file` binary — same pattern the engine itself
 * uses at runtime.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { hasFileBinary } from '../feature-detect.js';
import { processOne } from '../engine.js';
import { run } from '../run.js';

const fileBinaryAvailable = await hasFileBinary();

let tmpDirWithSpace: string;

beforeAll(async () => {
  tmpDirWithSpace = await fs.mkdtemp(path.join(os.tmpdir(), 'zit variants space '));
});

afterAll(async () => {
  if (tmpDirWithSpace) {
    await fs.rm(tmpDirWithSpace, { recursive: true, force: true });
  }
});

describe.skipIf(!fileBinaryAvailable)('run() execFile safety with a space-containing path', () => {
  it('passes a path with a space as a single argv element, not a shell-split token', async () => {
    const filePath = path.join(tmpDirWithSpace, 'test image.txt');
    await fs.writeFile(filePath, 'hello');

    const { stdout } = await run('file', [filePath]);
    expect(stdout).toContain(filePath);
  });

  it('correctly identifies a real JPEG living at a space-containing path', async () => {
    const jpegPath = path.join(tmpDirWithSpace, 'my photo.jpg');
    await fs.writeFile(
      jpegPath,
      await sharp({ create: { width: 40, height: 40, channels: 3, background: { r: 1, g: 2, b: 3 } } })
        .jpeg()
        .toBuffer(),
    );

    const { stdout } = await run('file', [jpegPath]);
    expect(stdout).toContain(jpegPath);
    expect(stdout).toMatch(/JPEG/i);
  });
});

describe('processOne end-to-end with spaces in both input and output paths', () => {
  it('processes a source whose input path AND output directory both contain spaces', async () => {
    const inputDirWithSpace = path.join(tmpDirWithSpace, 'source images');
    const outputDirWithSpace = path.join(tmpDirWithSpace, 'output variants');
    await fs.mkdir(inputDirWithSpace, { recursive: true });

    const inputPath = path.join(inputDirWithSpace, 'my product photo.jpg');
    await fs.writeFile(
      inputPath,
      await sharp({ create: { width: 500, height: 400, channels: 3, background: { r: 10, g: 20, b: 30 } } })
        .jpeg()
        .toBuffer(),
    );

    const result = await processOne({ inputPath }, { outputDir: outputDirWithSpace, widths: [300] });

    expect(result.status).toBe('processed');
    const variantPath = path.join(outputDirWithSpace, 'my product photo', '300w.webp');
    expect(await fs.readFile(variantPath)).toBeInstanceOf(Buffer);
  });
});
