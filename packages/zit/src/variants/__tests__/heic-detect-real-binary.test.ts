/**
 * Exercises `isHeicSource` / `isNonImageFile` against the real `file`
 * binary (unmocked, unlike heic-detect.test.ts) so a regression in the
 * MIME-type parsing can't hide behind a mocked stdout format. Skipped
 * with a visible reason on a runner that lacks the `file` binary — same
 * pattern as space-path.test.ts.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { hasFileBinary } from '../feature-detect.js';
import { isHeicSource, isNonImageFile } from '../heic.js';

const fileBinaryAvailable = await hasFileBinary();

const fixtureHeic = path.join(
  import.meta.dirname,
  '..',
  '..',
  'heif',
  '__tests__',
  'fixtures',
  'test-image-with-rotation.heic',
);

let tmpDir: string;

beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'zit-heic-detect-real-'));
});

afterAll(async () => {
  if (tmpDir) {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

describe.skipIf(!fileBinaryAvailable)('real `file` binary detection', () => {
  it('detects a real HEIC payload wearing a .jpg extension via its true MIME type', async () => {
    const jpegNamedHeic = path.join(tmpDir, 'a.jpg');
    await fs.copyFile(fixtureHeic, jpegNamedHeic);

    expect(await isHeicSource(jpegNamedHeic)).toBe(true);
    expect(await isNonImageFile(jpegNamedHeic)).toBe(false);
  });

  it('does not misdetect a real HEIC payload as non-image', async () => {
    const heicNamedNormally = path.join(tmpDir, 'a.heic');
    await fs.copyFile(fixtureHeic, heicNamedNormally);

    expect(await isNonImageFile(heicNamedNormally)).toBe(false);
  });

  it('flags a real HTML document saved as an image', async () => {
    const htmlAsJpeg = path.join(tmpDir, 'error-page.jpg');
    await fs.writeFile(htmlAsJpeg, '<html><body>404 Not Found</body></html>');

    expect(await isNonImageFile(htmlAsJpeg)).toBe(true);
  });

  it('flags a real plain-text file saved as an image', async () => {
    const textAsPng = path.join(tmpDir, 'notice.png');
    await fs.writeFile(textAsPng, 'This is a plain text response, not an image.');

    expect(await isNonImageFile(textAsPng)).toBe(true);
  });

  it('flags a real XML error response saved as an image', async () => {
    const xmlAsJpeg = path.join(tmpDir, 'error.jpg');
    await fs.writeFile(xmlAsJpeg, '<?xml version="1.0"?><error>not found</error>');

    expect(await isNonImageFile(xmlAsJpeg)).toBe(true);
  });

  it('correctly handles a real HEIC payload under a directory named HTML-exports/', async () => {
    const htmlExportsDir = path.join(tmpDir, 'HTML-exports');
    await fs.mkdir(htmlExportsDir, { recursive: true });
    const jpegNamedHeic = path.join(htmlExportsDir, 'photo.jpg');
    await fs.copyFile(fixtureHeic, jpegNamedHeic);

    expect(await isHeicSource(jpegNamedHeic)).toBe(true);
    expect(await isNonImageFile(jpegNamedHeic)).toBe(false);
  });

  it('does not route a genuine JPEG under a directory named HEIC-converted/ into HEIF conversion', async () => {
    const heicConvertedDir = path.join(tmpDir, 'HEIC-converted');
    await fs.mkdir(heicConvertedDir, { recursive: true });
    const genuineJpeg = path.join(heicConvertedDir, 'photo.jpg');
    await fs.writeFile(
      genuineJpeg,
      await sharp({ create: { width: 20, height: 20, channels: 3, background: { r: 1, g: 2, b: 3 } } })
        .jpeg()
        .toBuffer(),
    );

    expect(await isHeicSource(genuineJpeg)).toBe(false);
  });
});
