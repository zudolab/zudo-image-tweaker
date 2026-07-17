/**
 * Full metadata-contract matrix for issue #29 (sub-issue #81), on top of
 * the ICC semantics established for issue #71 (see icc.test.ts).
 *
 * Every {stripMetadata} × {bakeExifOrientation} combination is run over
 * the same EXIF-oriented, Display-P3-tagged source and asserted cell by
 * cell: EXIF presence, ICC presence, physical orientation, and rendered
 * pixel colour (sharp's `.raw()` decode is colour-managed, so it returns
 * the colour a browser would display).
 *
 * The single-encode guarantee — enabling a flag must not add a redundant
 * lossy re-encode — is asserted via output-byte equivalence: the encode
 * path is identical across flag combinations except for profile
 * retention, so `bakeExifOrientation: true` outputs must be byte-for-byte
 * identical to the flagless ones (an intermediate re-encode would change
 * the bytes fed to the final encoder and break the equality).
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { processOne } from '../engine.js';

// sRGB pure red expressed in Display-P3 device values differs by ~20-40
// per channel from the sRGB encoding, so a rendered-colour mismatch
// reliably detects a dropped-without-conversion or double-converted
// profile. (Same fixture strategy as icc.test.ts.)
const SOLID = { r: 234, g: 51, b: 35 };
const TOLERANCE = 8;

// Orientation 6 = 90° rotation: stored 400x200 landscape, displays as
// 200x400 portrait. A 100-wide variant of the upright image is 100x200.
const STORED = { width: 400, height: 200 };
const VARIANT = { width: 100, height: 200 };

async function makeOrientedP3Jpeg(): Promise<Buffer> {
  return sharp({ create: { ...STORED, channels: 3, background: SOLID } })
    .jpeg({ quality: 100 })
    .withMetadata({ orientation: 6 })
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
    expect(
      Math.abs(actual[c] - expected[c]),
      `${label}: channel ${c} rendered ${actual[c]} vs source ${expected[c]}`,
    ).toBeLessThanOrEqual(TOLERANCE);
  }
}

interface Cell {
  stripMetadata: boolean;
  bakeExifOrientation: boolean;
}

const MATRIX: Cell[] = [
  { stripMetadata: false, bakeExifOrientation: false },
  { stripMetadata: false, bakeExifOrientation: true },
  { stripMetadata: true, bakeExifOrientation: false },
  { stripMetadata: true, bakeExifOrientation: true },
];

const FORMATS = ['webp', 'jpg'];

let root: string;
let inputPath: string;
let source: Buffer;
let sourceColour: [number, number, number];
let sourceIcc: Buffer;

async function runCell(cell: Cell) {
  const outputDir = path.join(root, `out-strip${cell.stripMetadata}-bake${cell.bakeExifOrientation}`);
  const result = await processOne(
    { inputPath },
    { outputDir, widths: [VARIANT.width], formats: FORMATS, ...cell },
  );
  expect(result.status).toBe('processed');
  expect(result.variants).toHaveLength(FORMATS.length);
  const buffers = new Map<string, Buffer>();
  for (const variant of result.variants) {
    buffers.set(variant.format, await fs.readFile(variant.path));
  }
  return buffers;
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'zit-meta-contract-'));
  const inputDir = path.join(root, 'in');
  await fs.mkdir(inputDir, { recursive: true });
  source = await makeOrientedP3Jpeg();
  sourceColour = await renderedPixel(source);
  sourceIcc = Buffer.from((await sharp(source).metadata()).icc!);
  inputPath = path.join(inputDir, 'photo.jpg');
  await fs.writeFile(inputPath, source);
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe('variants: stripMetadata × bakeExifOrientation contract (issues #29/#81)', () => {
  // Sanity: the fixture really carries the metadata whose fate is under test.
  it('fixture carries EXIF orientation and a P3 profile', async () => {
    const meta = await sharp(source).metadata();
    expect(meta.orientation).toBe(6);
    expect(meta.icc).toBeDefined();
    expect(meta.exif).toBeDefined();
  });

  for (const cell of MATRIX) {
    const label = `stripMetadata: ${cell.stripMetadata}, bakeExifOrientation: ${cell.bakeExifOrientation}`;
    it(`${label} — EXIF dropped, ICC ${cell.stripMetadata ? 'dropped' : 'retained'}, orientation baked, colour correct`, async () => {
      const buffers = await runCell(cell);
      for (const [format, buffer] of buffers) {
        const meta = await sharp(buffer).metadata();
        // EXIF/XMP: always dropped, orientation tag included.
        expect(meta.exif, `${format}: EXIF must be dropped`).toBeUndefined();
        expect(meta.orientation, `${format}: orientation tag must not be emitted`).toBeUndefined();
        // Orientation: always physically baked — portrait output dimensions.
        expect(meta.width, `${format}: width`).toBe(VARIANT.width);
        expect(meta.height, `${format}: height`).toBe(VARIANT.height);
        // ICC: retained byte-identically unless stripMetadata.
        if (cell.stripMetadata) {
          expect(meta.icc, `${format}: ICC must be stripped`).toBeUndefined();
        } else {
          expect(meta.icc, `${format}: ICC must be retained`).toBeDefined();
          expect(Buffer.from(meta.icc!).equals(sourceIcc), `${format}: ICC must be byte-identical`).toBe(true);
        }
        // Colour: renders like the source in every cell — the P3 source is
        // either carried with its profile or genuinely converted to sRGB
        // before the profile is stripped, never mis-rendered.
        expectSameColour(await renderedPixel(buffer), sourceColour, `${label} / ${format}`);
      }
    });
  }

  it('bakeExifOrientation adds no re-encode: outputs are byte-identical to the flagless ones', async () => {
    const flagless = await runCell({ stripMetadata: false, bakeExifOrientation: false });
    const baked = await runCell({ stripMetadata: false, bakeExifOrientation: true });
    for (const format of FORMATS) {
      expect(baked.get(format)!.equals(flagless.get(format)!), `${format}: single-encode equivalence`).toBe(true);
    }
  });

  it('stripMetadata + bakeExifOrientation adds no re-encode over stripMetadata alone', async () => {
    const stripOnly = await runCell({ stripMetadata: true, bakeExifOrientation: false });
    const both = await runCell({ stripMetadata: true, bakeExifOrientation: true });
    for (const format of FORMATS) {
      expect(both.get(format)!.equals(stripOnly.get(format)!), `${format}: single-encode equivalence`).toBe(true);
    }
  });
});
