/**
 * Regression tests for issue #71: ICC colour management through the
 * variants pipeline.
 *
 * Assertion model: sharp's `.raw()` decode is colour-managed (it honours an
 * embedded ICC profile and converts to sRGB), so `renderedPixel()` returns
 * the colour a browser would DISPLAY. The invariant under test is that
 * every output renders the same colour as its source — which fails both
 * for a dropped-without-conversion profile (untagged P3 bytes read as
 * sRGB) and for a mis-tag (sRGB bytes tagged P3). Profile presence is
 * asserted on top, per the configured strategy.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import sharp from 'sharp';

// Only the WASM-heavy HEIC converter is stubbed; the engine's dispatch to
// it is what routes our profile-bearing JPEG intermediate into the pipeline.
vi.mock('../../heif/index.js', () => ({ convertHeifToJpeg: vi.fn() }));

import { processOne } from '../engine.js';
import { convertHeifToJpeg } from '../../heif/index.js';

const mockConvert = vi.mocked(convertHeifToJpeg);

// sRGB pure red expressed in Display-P3 device values is ~(234,51,35): the
// two encodings differ by ~20-40 per channel, far beyond the ±8 tolerance,
// so a source/output rendered-colour mismatch reliably detects any
// missing or double conversion.
const SOLID = { r: 234, g: 51, b: 35 };
const TOLERANCE = 8;

/** A Display-P3-tagged JPEG (sharp converts the sRGB input values into P3). */
async function makeP3Jpeg(width: number, height: number): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: SOLID } })
    .jpeg({ quality: 100 })
    .withIccProfile('p3')
    .toBuffer();
}

/** The colour-managed (browser-visible) colour at the image center. */
async function renderedPixel(input: Buffer): Promise<[number, number, number]> {
  const { data, info } = await sharp(input).raw().toBuffer({ resolveWithObject: true });
  const i = (Math.floor(info.height / 2) * info.width + Math.floor(info.width / 2)) * info.channels;
  return [data[i], data[i + 1], data[i + 2]];
}

function expectSameColour(actual: [number, number, number], expected: [number, number, number], label: string) {
  for (let c = 0; c < 3; c++) {
    expect(Math.abs(actual[c] - expected[c]), `${label}: channel ${c} rendered ${actual[c]} vs source ${expected[c]}`).toBeLessThanOrEqual(TOLERANCE);
  }
}

let root: string;
let inputDir: string;
let outputDir: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'zit-icc-'));
  inputDir = path.join(root, 'in');
  outputDir = path.join(root, 'out');
  await fs.mkdir(inputDir, { recursive: true });
  await fs.mkdir(outputDir, { recursive: true });
  mockConvert.mockReset();
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe('variants: ICC colour management (issue #71)', () => {
  it('retains the source profile byte-identically, rendering unchanged, for every format branch', async () => {
    const source = await makeP3Jpeg(400, 400);
    const sourceIcc = Buffer.from((await sharp(source).metadata()).icc!);
    const sourceColour = await renderedPixel(source);
    const inputPath = path.join(inputDir, 'photo.jpg');
    await fs.writeFile(inputPath, source);

    const result = await processOne(
      { inputPath },
      { outputDir, widths: [200], formats: ['webp', 'jpg', 'png', 'avif'] },
    );

    expect(result.status).toBe('processed');
    expect(result.variants).toHaveLength(4);
    for (const variant of result.variants) {
      const buffer = await fs.readFile(variant.path);
      const meta = await sharp(buffer).metadata();
      expect(meta.icc, `${variant.filename} should carry the ICC profile`).toBeDefined();
      expect(Buffer.from(meta.icc!).equals(sourceIcc), `${variant.filename} profile should be byte-identical`).toBe(true);
      expectSameColour(await renderedPixel(buffer), sourceColour, variant.filename);
    }
  });

  it('stripMetadata: true converts pixels to sRGB before stripping — profile gone, no colour shift', async () => {
    const source = await makeP3Jpeg(400, 400);
    const sourceColour = await renderedPixel(source);
    const inputPath = path.join(inputDir, 'photo.jpg');
    await fs.writeFile(inputPath, source);

    const result = await processOne(
      { inputPath },
      { outputDir, widths: [200], formats: ['webp', 'jpg'], stripMetadata: true },
    );

    expect(result.status).toBe('processed');
    for (const variant of result.variants) {
      const buffer = await fs.readFile(variant.path);
      const meta = await sharp(buffer).metadata();
      expect(meta.icc, `${variant.filename} should have no ICC profile`).toBeUndefined();
      expect(meta.exif).toBeUndefined();
      // Untagged output is read as sRGB — matching the source's rendered
      // colour proves the pixels were genuinely converted, not just
      // stripped of their tag.
      expectSameColour(await renderedPixel(buffer), sourceColour, variant.filename);
    }
  });

  it('bakeExifOrientation: true bakes the rotation and still retains the profile', async () => {
    // Orientation 6 = 90deg rotation: a stored 400x200 displays as 200x400.
    const source = await sharp({ create: { width: 400, height: 200, channels: 3, background: SOLID } })
      .jpeg({ quality: 100 })
      .withMetadata({ orientation: 6 })
      .withIccProfile('p3')
      .toBuffer();
    const sourceColour = await renderedPixel(source);
    const inputPath = path.join(inputDir, 'rotated.jpg');
    await fs.writeFile(inputPath, source);

    const result = await processOne(
      { inputPath },
      { outputDir, widths: [100], formats: ['webp'], bakeExifOrientation: true },
    );

    expect(result.status).toBe('processed');
    const buffer = await fs.readFile(result.variants[0].path);
    const meta = await sharp(buffer).metadata();
    // Displayed aspect is portrait (200x400) → the 100w variant is 100x200.
    expect(meta.width).toBe(100);
    expect(meta.height).toBe(200);
    expect(meta.orientation).toBeUndefined();
    expect(meta.icc).toBeDefined();
    expectSameColour(await renderedPixel(buffer), sourceColour, '100w.webp');
  });

  it('the profile embedded by the HEIC→JPEG intermediate survives into final variants', async () => {
    // Mirror /heif's real output shape: a JPEG whose scan data is untouched
    // device-space pixels with the extracted profile spliced in as an APP2
    // segment (convertHeifToJpeg does exactly this). Splicing the P3
    // profile into an sRGB-encoded JPEG yields device values that RENDER
    // differently from the untagged original — so a survived-and-honoured
    // profile is distinguishable from a dropped one.
    const untagged = await sharp({ create: { width: 400, height: 400, channels: 3, background: SOLID } })
      .jpeg({ quality: 100 })
      .toBuffer();
    const p3Icc = Buffer.from((await sharp(await makeP3Jpeg(8, 8)).metadata()).icc!);
    const intermediate = spliceIccIntoJpeg(untagged, p3Icc);
    const sourceColour = await renderedPixel(intermediate);
    // Sanity: the tag must change the rendering vs the untagged bytes,
    // otherwise the assertions below would pass vacuously.
    const untaggedColour = await renderedPixel(untagged);
    expect(Math.abs(sourceColour[0] - untaggedColour[0]) + Math.abs(sourceColour[1] - untaggedColour[1])).toBeGreaterThan(TOLERANCE);

    mockConvert.mockResolvedValue({ buffer: intermediate, width: 400, height: 400, iccApplied: true });
    const heicPath = path.join(inputDir, 'photo.heic');
    await fs.writeFile(heicPath, Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70]));

    const result = await processOne(
      { inputPath: heicPath },
      { outputDir, widths: [200], formats: ['webp', 'jpg'] },
    );

    expect(mockConvert).toHaveBeenCalledOnce();
    expect(result.status).toBe('processed');
    for (const variant of result.variants) {
      const buffer = await fs.readFile(variant.path);
      const meta = await sharp(buffer).metadata();
      expect(meta.icc, `${variant.filename} should carry the HEIC profile`).toBeDefined();
      expect(Buffer.from(meta.icc!).equals(p3Icc), `${variant.filename} profile should be byte-identical`).toBe(true);
      expectSameColour(await renderedPixel(buffer), sourceColour, variant.filename);
    }
  });

  it('the OGP card for an __og-tagged P3 source renders the source colour (sRGB-converted)', async () => {
    const source = await makeP3Jpeg(800, 800);
    const sourceColour = await renderedPixel(source);
    const inputPath = path.join(inputDir, 'photo__og.jpg');
    await fs.writeFile(inputPath, source);

    const result = await processOne({ inputPath }, { outputDir, widths: [200], formats: ['webp'] });

    expect(result.status).toBe('processed');
    expect(result.ogp).not.toBeNull();
    const buffer = await fs.readFile(result.ogp!.path);
    // OGP cards are emitted as plain untagged sRGB (see /ogp) — the source
    // colour must survive via genuine conversion.
    expect((await sharp(buffer).metadata()).icc).toBeUndefined();
    // Center of the 1200x630 card = the unblurred foreground crop.
    const { data, info } = await sharp(buffer).raw().toBuffer({ resolveWithObject: true });
    const i = (315 * info.width + 600) * info.channels;
    expectSameColour([data[i], data[i + 1], data[i + 2]], sourceColour, 'ogp.jpg card center');
  });
});

/**
 * Minimal APP2 ICC splice (single-chunk; test profiles are far below the
 * 64KB segment limit), byte-compatible with /heif's embedIccProfileInJpeg.
 */
function spliceIccIntoJpeg(jpeg: Buffer, icc: Buffer): Buffer {
  const identifier = Buffer.from('ICC_PROFILE\0', 'latin1');
  const header = Buffer.alloc(4 + identifier.length + 2);
  header.writeUInt8(0xff, 0);
  header.writeUInt8(0xe2, 1);
  header.writeUInt16BE(2 + identifier.length + 1 + 1 + icc.length, 2);
  identifier.copy(header, 4);
  header.writeUInt8(1, 4 + identifier.length);
  header.writeUInt8(1, 4 + identifier.length + 1);
  return Buffer.concat([jpeg.subarray(0, 2), header, icc, jpeg.subarray(2)]);
}
