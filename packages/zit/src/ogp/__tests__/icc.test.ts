/**
 * Regression tests for issue #71: ICC colour management through both OGP
 * encode branches. OGP cards are emitted as plain untagged sRGB — the
 * source's embedded profile must be honoured via genuine pixel conversion,
 * not silently dropped.
 *
 * Assertion model: sharp's `.raw()` decode is colour-managed, so it returns
 * the colour a browser would display; output-renders-like-source is the
 * invariant, and it catches both a dropped-without-conversion profile and
 * a mis-tag. See variants/__tests__/icc.test.ts for the full rationale.
 */
import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { generateOgpFromLandscape, generateOgpImage, generateSmartOgp } from '../index.js';

// sRGB pure red in Display-P3 device values — see variants/__tests__/icc.test.ts.
const SOLID = { r: 234, g: 51, b: 35 };
const TOLERANCE = 8;

async function makeP3Jpeg(width: number, height: number): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: SOLID } })
    .jpeg({ quality: 100 })
    .withIccProfile('p3')
    .toBuffer();
}

async function renderedPixelAt(buffer: Buffer, x: number, y: number): Promise<[number, number, number]> {
  const { data, info } = await sharp(buffer).raw().toBuffer({ resolveWithObject: true });
  const i = (y * info.width + x) * info.channels;
  return [data[i], data[i + 1], data[i + 2]];
}

function expectSameColour(actual: [number, number, number], expected: [number, number, number], label: string) {
  for (let c = 0; c < 3; c++) {
    expect(Math.abs(actual[c] - expected[c]), `${label}: channel ${c} rendered ${actual[c]} vs source ${expected[c]}`).toBeLessThanOrEqual(TOLERANCE);
  }
}

describe('OGP: ICC colour management (issue #71)', () => {
  it('composite branch renders the P3 source colour, emitted as untagged sRGB', async () => {
    const source = await makeP3Jpeg(800, 800);
    const sourceColour = await renderedPixelAt(source, 400, 400);

    const result = await generateOgpImage(source);

    expect((await sharp(result.buffer).metadata()).icc).toBeUndefined();
    // The centered card (default 600px on the 1200x630 canvas) is an
    // unblurred cover-crop of the source: its center must render the
    // source colour. A keepIccProfile() on the composite stage re-tags
    // these already-converted pixels and breaks exactly this assertion.
    expectSameColour(await renderedPixelAt(result.buffer, 600, 315), sourceColour, 'composite card center');
  });

  it('landscape branch renders the P3 source colour, emitted as untagged sRGB', async () => {
    const source = await makeP3Jpeg(1800, 900);
    const sourceColour = await renderedPixelAt(source, 900, 450);

    const result = await generateOgpFromLandscape(source);

    expect((await sharp(result.buffer).metadata()).icc).toBeUndefined();
    expectSameColour(await renderedPixelAt(result.buffer, 600, 315), sourceColour, 'landscape center');
  });

  it('generateSmartOgp renders the source colour on both dispatch branches', async () => {
    const square = await generateSmartOgp(await makeP3Jpeg(800, 800));
    expect(square.method).toBe('composite');
    const squareColour = await renderedPixelAt(await makeP3Jpeg(8, 8), 4, 4);
    expectSameColour(await renderedPixelAt(square.buffer, 600, 315), squareColour, 'smart composite');

    const wide = await generateSmartOgp(await makeP3Jpeg(1800, 900));
    expect(wide.method).toBe('landscape');
    expectSameColour(await renderedPixelAt(wide.buffer, 600, 315), squareColour, 'smart landscape');
  });

  it('an untagged source passes through unshifted', async () => {
    const source = await sharp({ create: { width: 800, height: 800, channels: 3, background: SOLID } })
      .jpeg({ quality: 100 })
      .toBuffer();

    const result = await generateOgpImage(source);
    expect((await sharp(result.buffer).metadata()).icc).toBeUndefined();
    expectSameColour(await renderedPixelAt(result.buffer, 600, 315), [SOLID.r, SOLID.g, SOLID.b], 'untagged card center');
  });
});
