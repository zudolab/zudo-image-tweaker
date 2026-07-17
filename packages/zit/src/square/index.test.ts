/**
 * Unit tests for src/square/index.ts
 *
 * Verifies:
 * - cropToSquare: output is square with correct side length; anchors top/center/bottom
 *   select different extract offsets (landscape: horizontal crop; portrait: vertical crop).
 * - padToSquare: portrait pads left only; landscape pads top only; square is a no-op;
 *   padded pixels match the background color.
 * - padToSquareCentered: portrait pads left+right symmetrically; landscape pads top+bottom
 *   symmetrically; square is a no-op; padded pixels match the background color; the long
 *   axis is never padded.
 * - insetOnSquare: content shrinks onto a same-size canvas with a background border;
 *   pre-existing borders stack.
 * - trimPadSquare: near-background border is trimmed before padding, so pre-framed
 *   input does NOT stack margins; exact margin lands on the content's longer axis.
 */

import { describe, it, expect, vi } from 'vitest';
import sharp from 'sharp';
import {
  cropToSquare,
  padToSquare,
  padToSquareCentered,
  insetOnSquare,
  trimPadSquare,
} from './index.js';

// Every test here drives real `sharp` resize/composite work. The vitest per-test
// default of 5s is tight for heavy image ops on a busy / shared machine, so give
// the sharp work generous head-room.
vi.setConfig({ testTimeout: 20000 });

// ---------------------------------------------------------------------------
// Fixture helpers — synthetic in-memory images via sharp (no filesystem I/O)
// ---------------------------------------------------------------------------

/** Create a synthetic JPEG buffer filled with a solid colour. */
async function makeJpeg(w: number, h: number, r = 100, g = 150, b = 200): Promise<Buffer> {
  return sharp({ create: { width: w, height: h, channels: 3, background: { r, g, b } } })
    .jpeg()
    .toBuffer();
}

/** Read the dimensions of an image buffer. */
async function dims(buf: Buffer) {
  const { width, height } = await sharp(buf).metadata();
  return { width: width!, height: height! };
}

/**
 * Sample a pixel from a buffer at (x, y) and return {r, g, b}.
 * Decodes via raw pixels to avoid JPEG compression artefacts on edge pixels.
 */
async function pixel(buf: Buffer, x: number, y: number) {
  const raw = await sharp(buf).raw().toBuffer({ resolveWithObject: true });
  const { width, channels } = raw.info;
  const offset = (y * width + x) * channels;
  return {
    r: raw.data[offset],
    g: raw.data[offset + 1],
    b: raw.data[offset + 2],
  };
}

/** Like `pixel`, but also returns the alpha channel (0-255) and channel count. */
async function pixelWithAlpha(buf: Buffer, x: number, y: number) {
  const raw = await sharp(buf).raw().toBuffer({ resolveWithObject: true });
  const { width, channels } = raw.info;
  const offset = (y * width + x) * channels;
  return {
    r: raw.data[offset],
    g: raw.data[offset + 1],
    b: raw.data[offset + 2],
    a: channels === 4 ? raw.data[offset + 3] : 255,
    channels,
  };
}

// ---------------------------------------------------------------------------
// cropToSquare
// ---------------------------------------------------------------------------

describe('cropToSquare', () => {
  it('landscape 1200×849: output is 849×849', async () => {
    const src = await makeJpeg(1200, 849);
    const result = await cropToSquare(src);
    expect(result).toMatchObject({ width: 849, height: 849 });
    expect(await dims(result.buffer)).toEqual({ width: 849, height: 849 });
  });

  it('portrait 849×1200: output is 849×849', async () => {
    const src = await makeJpeg(849, 1200);
    const result = await cropToSquare(src);
    expect(result).toMatchObject({ width: 849, height: 849 });
    expect(await dims(result.buffer)).toEqual({ width: 849, height: 849 });
  });

  it('square 600×600: output remains 600×600', async () => {
    const src = await makeJpeg(600, 600);
    const result = await cropToSquare(src);
    expect(result).toMatchObject({ width: 600, height: 600 });
  });

  it('portrait: anchor=top keeps top pixels (no vertical offset)', async () => {
    // Portrait 100×200 image with a red top half (y 0-99) and blue bottom half (y 100-199).
    const topHalf = await sharp({
      create: { width: 100, height: 100, channels: 3, background: { r: 255, g: 0, b: 0 } },
    })
      .png()
      .toBuffer();
    const botHalf = await sharp({
      create: { width: 100, height: 100, channels: 3, background: { r: 0, g: 0, b: 255 } },
    })
      .png()
      .toBuffer();

    const composite = await sharp({
      create: { width: 100, height: 200, channels: 3, background: { r: 0, g: 0, b: 0 } },
    })
      .composite([
        { input: topHalf, top: 0, left: 0 },
        { input: botHalf, top: 100, left: 0 },
      ])
      .png()
      .toBuffer();

    // anchor=top: crop keeps y[0..99], so top-left pixel should be red
    const resultTop = await cropToSquare(composite, { anchor: 'top' });
    const topPx = await pixel(resultTop.buffer, 0, 0);
    expect(topPx.r).toBeGreaterThan(200); // red
    expect(topPx.b).toBeLessThan(50);

    // anchor=bottom: crop keeps y[100..199], so top-left of output should be blue
    const resultBot = await cropToSquare(composite, { anchor: 'bottom' });
    const botPx = await pixel(resultBot.buffer, 0, 0);
    expect(botPx.b).toBeGreaterThan(200); // blue
    expect(botPx.r).toBeLessThan(50);
  });

  it('rejects invalid anchor', async () => {
    const src = await makeJpeg(100, 80);
    // @ts-expect-error intentional bad anchor
    await expect(cropToSquare(src, { anchor: 'middle' })).rejects.toThrow('Invalid anchor');
  });
});

// ---------------------------------------------------------------------------
// padToSquare
// ---------------------------------------------------------------------------

describe('padToSquare', () => {
  it('portrait 100×200: output is 200×200; left pixel is background (pad left)', async () => {
    // Portrait (h > w): pad LEFT by h-w=100 → output 200×200.
    // Background is on the left; original content is right-aligned.
    const src = await sharp({
      create: { width: 100, height: 200, channels: 3, background: { r: 255, g: 0, b: 0 } },
    })
      .png()
      .toBuffer();

    const result = await padToSquare(src);

    // Output must be 200×200
    expect(result).toMatchObject({ width: 200, height: 200 });
    expect(await dims(result.buffer)).toEqual({ width: 200, height: 200 });

    // Top-left pixel of output should be white (padded left area, default background)
    const topLeft = await pixel(result.buffer, 0, 0);
    expect(topLeft.r).toBe(255);
    expect(topLeft.g).toBe(255);
    expect(topLeft.b).toBe(255);

    // Top-right pixel should be from original red content (right side)
    const topRight = await pixel(result.buffer, 199, 0);
    expect(topRight.r).toBeGreaterThan(200);
    expect(topRight.g).toBeLessThan(50);
  });

  it('landscape 200×100: output is 200×200; top pixel is background (pad top)', async () => {
    // Landscape (w > h): pad TOP by w-h=100 → output 200×200.
    // Background is on top; original content is bottom-aligned.
    const src = await sharp({
      create: { width: 200, height: 100, channels: 3, background: { r: 0, g: 0, b: 255 } },
    })
      .png()
      .toBuffer();

    const result = await padToSquare(src);

    expect(result).toMatchObject({ width: 200, height: 200 });
    expect(await dims(result.buffer)).toEqual({ width: 200, height: 200 });

    // Top-left pixel should be white (padded area, default background)
    const topPx = await pixel(result.buffer, 0, 0);
    expect(topPx.r).toBe(255);
    expect(topPx.g).toBe(255);
    expect(topPx.b).toBe(255);

    // Bottom side should still be blue original content
    const botPx = await pixel(result.buffer, 100, 199);
    expect(botPx.b).toBeGreaterThan(200);
    expect(botPx.r).toBeLessThan(50);
  });

  it('square input is a no-op: same dimensions', async () => {
    const src = await makeJpeg(300, 300);
    const result = await padToSquare(src);
    expect(result).toMatchObject({ width: 300, height: 300 });
    expect(await dims(result.buffer)).toEqual({ width: 300, height: 300 });
  });

  it('portrait: right and bottom are NOT extended (original content at right/bottom)', async () => {
    // 100×200 (portrait, h > w) → pad LEFT by 100; output 200×200.
    // Right and bottom are not extended; original green content is at x=100..199 (full height).
    const src = await sharp({
      create: { width: 100, height: 200, channels: 3, background: { r: 0, g: 255, b: 0 } },
    })
      .png()
      .toBuffer();
    const result = await padToSquare(src);

    // Bottom-right corner of output should be green (original content — right-aligned)
    const br = await pixel(result.buffer, 199, 199);
    expect(br.g).toBeGreaterThan(200); // green
    expect(br.r).toBeLessThan(50);

    // Right column is NOT all-background (original content is there)
    const rightMid = await pixel(result.buffer, 199, 100);
    expect(rightMid.g).toBeGreaterThan(200);
  });

  it('landscape: right and bottom are NOT extended (original content at bottom)', async () => {
    // 200×100 (landscape, w > h) → pad TOP by 100; output 200×200.
    // Right and bottom are not extended; original content appears in bottom half.
    const src = await sharp({
      create: { width: 200, height: 100, channels: 3, background: { r: 255, g: 0, b: 128 } },
    })
      .png()
      .toBuffer();
    const result = await padToSquare(src);

    // Bottom-right pixel should be original content (red-ish, NOT background white)
    const br = await pixel(result.buffer, 199, 199);
    expect(br.r).toBeGreaterThan(200);
    const isWhite = br.r === 255 && br.g === 255 && br.b === 255;
    expect(isWhite).toBe(false);

    // Top row should be white (padded area, default background)
    const topRow = await pixel(result.buffer, 100, 0);
    expect(topRow.r).toBe(255);
    expect(topRow.g).toBe(255);
    expect(topRow.b).toBe(255);
  });

  it('honors a custom background color', async () => {
    const src = await sharp({
      create: { width: 100, height: 200, channels: 3, background: { r: 0, g: 255, b: 0 } },
    })
      .png()
      .toBuffer();
    const result = await padToSquare(src, { background: { r: 10, g: 20, b: 30 } });
    const padded = await pixel(result.buffer, 0, 0);
    expect(padded).toEqual({ r: 10, g: 20, b: 30 });
  });

  it('honors a translucent background color (alpha is not flattened to opaque)', async () => {
    const src = await sharp({
      create: { width: 100, height: 200, channels: 3, background: { r: 0, g: 255, b: 0 } },
    })
      .png()
      .toBuffer();
    const result = await padToSquare(src, {
      background: { r: 10, g: 20, b: 30, alpha: 0.5 },
    });
    const padded = await pixelWithAlpha(result.buffer, 0, 0);
    expect(padded.channels).toBe(4);
    expect(padded).toMatchObject({ r: 10, g: 20, b: 30 });
    expect(padded.a).toBeGreaterThan(100);
    expect(padded.a).toBeLessThan(150);
  });
});

// ---------------------------------------------------------------------------
// padToSquareCentered
// ---------------------------------------------------------------------------

describe('padToSquareCentered', () => {
  it('portrait 100×200: output is 200×200; symmetric background pad on left+right, none on top/bottom', async () => {
    // Portrait (h > w): pad LEFT and RIGHT by (200-100)/2 = 50 each → output 200×200.
    // Original red content occupies the horizontal centre (x 50..149), full height.
    const src = await sharp({
      create: { width: 100, height: 200, channels: 3, background: { r: 255, g: 0, b: 0 } },
    })
      .png()
      .toBuffer();

    const result = await padToSquareCentered(src);

    // Output must be exactly square 200×200
    expect(result).toMatchObject({ width: 200, height: 200 });
    expect(await dims(result.buffer)).toEqual({ width: 200, height: 200 });

    // Left pad (x 0..49) is white
    const left = await pixel(result.buffer, 10, 100);
    expect(left).toMatchObject({ r: 255, g: 255, b: 255 });

    // Right pad (x 150..199) is white — symmetric with the left
    const right = await pixel(result.buffer, 190, 100);
    expect(right).toMatchObject({ r: 255, g: 255, b: 255 });

    // Centre column is original red content
    const centre = await pixel(result.buffer, 100, 100);
    expect(centre.r).toBeGreaterThan(200);
    expect(centre.g).toBeLessThan(50);

    // Long (vertical) axis is NOT padded — top and bottom rows at the centre column are red
    const top = await pixel(result.buffer, 100, 0);
    expect(top.r).toBeGreaterThan(200);
    const bottom = await pixel(result.buffer, 100, 199);
    expect(bottom.r).toBeGreaterThan(200);

    // Pad symmetry: the background boundary is at the same offset from each edge.
    // x=49 should still be background, x=50 should be content (red).
    expect((await pixel(result.buffer, 49, 100)).r).toBe(255);
    expect((await pixel(result.buffer, 50, 100)).r).toBeGreaterThan(200);
    expect((await pixel(result.buffer, 150, 100)).r).toBe(255);
    expect((await pixel(result.buffer, 149, 100)).r).toBeGreaterThan(200);
  });

  it('landscape 200×100: output is 200×200; symmetric background pad on top+bottom, none on left/right', async () => {
    // Landscape (w > h): pad TOP and BOTTOM by (200-100)/2 = 50 each → output 200×200.
    // Original blue content occupies the vertical centre (y 50..149), full width.
    const src = await sharp({
      create: { width: 200, height: 100, channels: 3, background: { r: 0, g: 0, b: 255 } },
    })
      .png()
      .toBuffer();

    const result = await padToSquareCentered(src);

    expect(result).toMatchObject({ width: 200, height: 200 });
    expect(await dims(result.buffer)).toEqual({ width: 200, height: 200 });

    // Top pad (y 0..49) is white
    const top = await pixel(result.buffer, 100, 10);
    expect(top).toMatchObject({ r: 255, g: 255, b: 255 });

    // Bottom pad (y 150..199) is white — symmetric with the top
    const bottom = await pixel(result.buffer, 100, 190);
    expect(bottom).toMatchObject({ r: 255, g: 255, b: 255 });

    // Centre row is original blue content
    const centre = await pixel(result.buffer, 100, 100);
    expect(centre.b).toBeGreaterThan(200);
    expect(centre.r).toBeLessThan(50);

    // Long (horizontal) axis is NOT padded — left and right columns at the centre row are blue
    const leftMid = await pixel(result.buffer, 0, 100);
    expect(leftMid.b).toBeGreaterThan(200);
    const rightMid = await pixel(result.buffer, 199, 100);
    expect(rightMid.b).toBeGreaterThan(200);

    // Pad symmetry: y=49 background (r=255), y=50 blue content (r=0); y=150 background, y=149 content.
    // Use the red channel — blue is 255 for both background and blue content, so it can't
    // distinguish the boundary.
    expect((await pixel(result.buffer, 100, 49)).r).toBe(255);
    expect((await pixel(result.buffer, 100, 50)).r).toBeLessThan(50);
    expect((await pixel(result.buffer, 100, 150)).r).toBe(255);
    expect((await pixel(result.buffer, 100, 149)).r).toBeLessThan(50);
  });

  it('square input is a no-op: same dimensions', async () => {
    const src = await makeJpeg(300, 300);
    const result = await padToSquareCentered(src);
    expect(result).toMatchObject({ width: 300, height: 300 });
    expect(await dims(result.buffer)).toEqual({ width: 300, height: 300 });
  });

  it('odd difference: output stays exactly square (extra pixel on the after side)', async () => {
    // Portrait 100×201 → pad total 101: floor(101/2)=50 left, 51 right → 201×201 square.
    const src = await sharp({
      create: { width: 100, height: 201, channels: 3, background: { r: 0, g: 255, b: 0 } },
    })
      .png()
      .toBuffer();
    const result = await padToSquareCentered(src);
    expect(result).toMatchObject({ width: 201, height: 201 });
    expect(await dims(result.buffer)).toEqual({ width: 201, height: 201 });
  });
});

// ---------------------------------------------------------------------------
// insetOnSquare
// ---------------------------------------------------------------------------

describe('insetOnSquare', () => {
  it('square 400×400 margin 0.10: output is 400×400; outer ring background, center content', async () => {
    // Solid blue square. With margin 0.10 the outer 40px ring is background, the
    // inner ~320px box holds the (scaled) blue content.
    const src = await makeJpeg(400, 400, 0, 0, 255);
    const result = await insetOnSquare(src, { margin: 0.1 });

    // Output stays N×N square
    expect(result).toMatchObject({ width: 400, height: 400 });
    expect(await dims(result.buffer)).toEqual({ width: 400, height: 400 });

    // Border region (outer margin*N = 40px ring) is pure white #ffffff (default background) —
    // sample a few points well inside the ring on each side.
    const corners = [
      [5, 5],
      [395, 5],
      [5, 395],
      [395, 395],
      [200, 5], // top edge
      [200, 395], // bottom edge
      [5, 200], // left edge
      [395, 200], // right edge
    ];
    for (const [x, y] of corners) {
      const px = await pixel(result.buffer, x, y);
      expect(px).toMatchObject({ r: 255, g: 255, b: 255 });
    }

    // Center contains non-background (scaled blue) content
    const center = await pixel(result.buffer, 200, 200);
    expect(center.b).toBeGreaterThan(200);
    expect(center.r).toBeLessThan(50);
  });

  it('rejects out-of-range margin', async () => {
    const src = await makeJpeg(200, 200);
    await expect(insetOnSquare(src, { margin: 0.6 })).rejects.toThrow('Invalid margin');
  });

  it('tiny input with a valid margin does not crash (inner box clamps to 1px)', async () => {
    // 2×2 input, margin 0.4 → naive inner = round(2 * 0.2) = 0, which sharp's
    // resize() rejects. The clamp keeps this a valid (if degenerate) inset.
    const src = await makeJpeg(2, 2);
    const result = await insetOnSquare(src, { margin: 0.4 });
    expect(result).toMatchObject({ width: 2, height: 2 });
    expect(await dims(result.buffer)).toEqual({ width: 2, height: 2 });
  });

  it('non-square landscape input 400×200 margin 0.10: content centered on short axis', async () => {
    // Landscape 400×200: side = min(400, 200) = 200. inner = round(200 * 0.80) = 160.
    // Resize 400×200 with fit:inside into 160×160 box → resized = 160×80 (preserves 2:1 ratio).
    // left = round((200 - 160) / 2) = 20, top = round((200 - 80) / 2) = 60.
    // So background margin: left 20px, right 20px (equal), top 60px, bottom 60px (equal).
    const src = await sharp({
      create: { width: 400, height: 200, channels: 3, background: { r: 255, g: 0, b: 0 } },
    })
      .png()
      .toBuffer();

    const result = await insetOnSquare(src, { margin: 0.1 });

    // Output is N×N where N = min(400, 200) = 200
    expect(result).toMatchObject({ width: 200, height: 200 });
    expect(await dims(result.buffer)).toEqual({ width: 200, height: 200 });

    // Top margin (y 0..59) should be background — sample at y=10, centre x
    const topMid = await pixel(result.buffer, 100, 10);
    expect(topMid).toMatchObject({ r: 255, g: 255, b: 255 });

    // Bottom margin (y 140..199) should be background — sample at y=190, centre x
    const botMid = await pixel(result.buffer, 100, 190);
    expect(botMid).toMatchObject({ r: 255, g: 255, b: 255 });

    // Left margin (x 0..19) should be background — sample at x=5, centre y
    const leftMid = await pixel(result.buffer, 5, 100);
    expect(leftMid).toMatchObject({ r: 255, g: 255, b: 255 });

    // Right margin (x 180..199) should be background — sample at x=195, centre y
    const rightMid = await pixel(result.buffer, 195, 100);
    expect(rightMid).toMatchObject({ r: 255, g: 255, b: 255 });

    // Centre of image should be the red content
    const centre = await pixel(result.buffer, 100, 100);
    expect(centre.r).toBeGreaterThan(200);
    expect(centre.g).toBeLessThan(50);

    // Background margins on the short axis (top/bottom) should be roughly equal:
    // first non-background row from top ≈ first non-background row from bottom.
    // Decode the raw buffer ONCE and scan in-memory rather than re-decoding per row.
    const rawOut = await sharp(result.buffer).raw().toBuffer({ resolveWithObject: true });
    const { width: outW, channels: outCh } = rawOut.info;
    const redGreenAt = (x: number, y: number) => {
      const o = (y * outW + x) * outCh;
      return { r: rawOut.data[o], g: rawOut.data[o + 1] };
    };
    // Scan from top to find content start row.
    let topContentRow = -1;
    for (let y = 0; y < 200; y++) {
      const px = redGreenAt(100, y);
      if (px.r > 200 && px.g < 50) {
        topContentRow = y;
        break;
      }
    }
    // Scan from bottom to find content end row.
    let botContentRow = -1;
    for (let y = 199; y >= 0; y--) {
      const px = redGreenAt(100, y);
      if (px.r > 200 && px.g < 50) {
        botContentRow = y;
        break;
      }
    }
    expect(topContentRow).toBeGreaterThan(0); // some top background margin exists
    expect(botContentRow).toBeLessThan(199); // some bottom background margin exists
    // Top and bottom background margins are equal-ish (within 1px for rounding).
    const topMarginPx = topContentRow;
    const botMarginPx = 199 - botContentRow;
    expect(Math.abs(topMarginPx - botMarginPx)).toBeLessThanOrEqual(1);
  });

  it('honors a custom background color', async () => {
    const src = await makeJpeg(200, 200, 0, 0, 255);
    const result = await insetOnSquare(src, { margin: 0.1, background: { r: 9, g: 9, b: 9 } });
    const border = await pixel(result.buffer, 5, 5);
    expect(border).toEqual({ r: 9, g: 9, b: 9 });
  });

  it('honors a translucent background color (alpha is not flattened to opaque)', async () => {
    const src = await makeJpeg(200, 200, 0, 0, 255);
    const result = await insetOnSquare(src, {
      margin: 0.1,
      background: { r: 9, g: 9, b: 9, alpha: 0.5 },
    });
    const border = await pixelWithAlpha(result.buffer, 5, 5);
    expect(border.channels).toBe(4);
    expect(border).toMatchObject({ r: 9, g: 9, b: 9 });
    expect(border.a).toBeGreaterThan(100);
    expect(border.a).toBeLessThan(150);
  });
});

// ---------------------------------------------------------------------------
// trimPadSquare
// ---------------------------------------------------------------------------

/**
 * Composite a solid-colour rect centred on a white PNG canvas (lossless so the
 * content/background boundary stays crisp for bbox detection).
 */
async function makeContentOnWhite(
  contentW: number,
  contentH: number,
  canvasW: number,
  canvasH: number,
  color = { r: 200, g: 30, b: 30 },
): Promise<Buffer> {
  const rect = await sharp({
    create: { width: contentW, height: contentH, channels: 3, background: color },
  })
    .png()
    .toBuffer();
  return sharp({
    create: {
      width: canvasW,
      height: canvasH,
      channels: 3,
      background: { r: 255, g: 255, b: 255 },
    },
  })
    .composite([
      {
        input: rect,
        top: Math.round((canvasH - contentH) / 2),
        left: Math.round((canvasW - contentW) / 2),
      },
    ])
    .png()
    .toBuffer();
}

/** First non-white row scanning down a column. */
async function firstContentRow(buf: Buffer, x: number) {
  const raw = await sharp(buf).raw().toBuffer({ resolveWithObject: true });
  const { width, height, channels } = raw.info;
  for (let y = 0; y < height; y++) {
    const o = (y * width + x) * channels;
    const r = raw.data[o],
      g = raw.data[o + 1],
      b = raw.data[o + 2];
    if (!(r >= 245 && g >= 245 && b >= 245)) return y;
  }
  return -1;
}

/** First non-white column scanning across a row. */
async function firstContentCol(buf: Buffer, y: number) {
  const raw = await sharp(buf).raw().toBuffer({ resolveWithObject: true });
  const { width, channels } = raw.info;
  for (let x = 0; x < width; x++) {
    const o = (y * width + x) * channels;
    const r = raw.data[o],
      g = raw.data[o + 1],
      b = raw.data[o + 2];
    if (!(r >= 245 && g >= 245 && b >= 245)) return x;
  }
  return -1;
}

describe('trimPadSquare', () => {
  it('over-margined portrait input does NOT stack: yields EXACTLY 10% top/bottom', async () => {
    // 100×200 red content on a 300×400 white canvas (input already has a wide
    // ~33%/50% margin). insetOnSquare would stack that; trimPadSquare trims it
    // away first, so the longer (vertical) axis ends at exactly 80% → 10% each end.
    const src = await makeContentOnWhite(100, 200, 300, 400);
    const result = await trimPadSquare(src, { margin: 0.1 });

    // longSide = 200 → side = round(200 / 0.8) = 250.
    expect(result).toMatchObject({ width: 250, height: 250 });
    expect(await dims(result.buffer)).toEqual({ width: 250, height: 250 });

    // Corners are pure white.
    for (const [x, y] of [
      [3, 3],
      [247, 3],
      [3, 247],
      [247, 247],
    ]) {
      expect(await pixel(result.buffer, x, y)).toMatchObject({ r: 255, g: 255, b: 255 });
    }

    // Top margin = round((250-200)/2) = 25px = exactly 10% of 250 (±1px rounding).
    const top = await firstContentRow(result.buffer, 125);
    expect(Math.abs(top - 25)).toBeLessThanOrEqual(1);
    expect(top / 250).toBeCloseTo(0.1, 1);

    // Centre is the red content.
    const centre = await pixel(result.buffer, 125, 125);
    expect(centre.r).toBeGreaterThan(150);
    expect(centre.g).toBeLessThan(80);
  });

  it('tight (zero-margin) input gains an exact 10% border on all sides', async () => {
    // 200×200 blue filling the frame (no border). Trim is a no-op; pad adds 10%.
    const src = await sharp({
      create: { width: 200, height: 200, channels: 3, background: { r: 0, g: 0, b: 255 } },
    })
      .png()
      .toBuffer();
    const result = await trimPadSquare(src, { margin: 0.1 });

    expect(result).toMatchObject({ width: 250, height: 250 });
    const top = await firstContentRow(result.buffer, 125);
    const left = await firstContentCol(result.buffer, 125);
    expect(Math.abs(top - 25)).toBeLessThanOrEqual(1);
    expect(Math.abs(left - 25)).toBeLessThanOrEqual(1);
    expect(await pixel(result.buffer, 3, 3)).toMatchObject({ r: 255, g: 255, b: 255 });
    expect((await pixel(result.buffer, 125, 125)).b).toBeGreaterThan(200);
  });

  it('landscape content: margin lands on the longer (horizontal) axis', async () => {
    // 200×100 green centred on 400×300 white. longSide = 200 (width) → side = 250.
    // Left/right margin = round((250-200)/2) = 25 = 10%; top/bottom larger.
    const src = await makeContentOnWhite(200, 100, 400, 300, { r: 20, g: 200, b: 40 });
    const result = await trimPadSquare(src, { margin: 0.1 });

    expect(result).toMatchObject({ width: 250, height: 250 });
    const left = await firstContentCol(result.buffer, 125);
    expect(Math.abs(left - 25)).toBeLessThanOrEqual(1);
    expect(left / 250).toBeCloseTo(0.1, 1);
    // Vertical margin is larger than 10% (content height 100 < width 200).
    const top = await firstContentRow(result.buffer, 125);
    expect(top).toBeGreaterThan(60);
  });

  it('defaults to 10% margin when none is passed', async () => {
    const src = await makeContentOnWhite(160, 160, 240, 240);
    const result = await trimPadSquare(src);
    // longSide = 160 → side = round(160 / 0.8) = 200.
    expect(result).toMatchObject({ width: 200, height: 200 });
    const top = await firstContentRow(result.buffer, 100);
    expect(Math.abs(top - 20)).toBeLessThanOrEqual(1); // 20 / 200 = 10%
  });

  it('rejects out-of-range margin', async () => {
    const src = await makeJpeg(200, 200);
    await expect(trimPadSquare(src, { margin: 0.6 })).rejects.toThrow('Invalid margin');
  });

  it('rejects out-of-range / NaN threshold', async () => {
    const src = await makeJpeg(200, 200);
    await expect(trimPadSquare(src, { threshold: -1 })).rejects.toThrow('Invalid threshold');
    await expect(trimPadSquare(src, { threshold: 300 })).rejects.toThrow('Invalid threshold');
    await expect(trimPadSquare(src, { threshold: Number.NaN })).rejects.toThrow(
      'Invalid threshold',
    );
  });

  it('all-white input emits a white square (no crash)', async () => {
    const src = await makeJpeg(300, 240, 255, 255, 255);
    const result = await trimPadSquare(src, { margin: 0.1 });
    expect(result).toMatchObject({ width: 300, height: 300 });
    expect(await pixel(result.buffer, 150, 150)).toMatchObject({ r: 255, g: 255, b: 255 });
  });

  it('honors a custom background color', async () => {
    const src = await sharp({
      create: { width: 200, height: 200, channels: 3, background: { r: 0, g: 0, b: 255 } },
    })
      .png()
      .toBuffer();
    const result = await trimPadSquare(src, { margin: 0.1, background: { r: 5, g: 5, b: 5 } });
    expect(await pixel(result.buffer, 3, 3)).toEqual({ r: 5, g: 5, b: 5 });
  });

  it('honors a translucent background color (alpha is not flattened to opaque)', async () => {
    const src = await sharp({
      create: { width: 200, height: 200, channels: 3, background: { r: 0, g: 0, b: 255 } },
    })
      .png()
      .toBuffer();
    const result = await trimPadSquare(src, {
      margin: 0.1,
      background: { r: 5, g: 5, b: 5, alpha: 0.5 },
    });
    const border = await pixelWithAlpha(result.buffer, 3, 3);
    expect(border.channels).toBe(4);
    expect(border).toMatchObject({ r: 5, g: 5, b: 5 });
    expect(border.a).toBeGreaterThan(100);
    expect(border.a).toBeLessThan(150);
  });

  it('transparent-background content trims to the opaque bounding box, not the whole canvas (issue #77)', async () => {
    // 300x300 fully transparent canvas with an opaque 100x100 black rect
    // centered on it. The transparent surround holds black RGB (0,0,0) —
    // if alpha isn't considered, contentBBox sees "not near-white" pixels
    // everywhere and treats the entire canvas as content (no trim at all).
    // With alpha considered, the transparent surround must read as background.
    const canvas = 300;
    const rectSize = 100;
    const channels = 4;
    const raw = Buffer.alloc(canvas * canvas * channels, 0); // all-zero: transparent black everywhere
    const rectOffset = (canvas - rectSize) / 2;
    for (let y = rectOffset; y < rectOffset + rectSize; y++) {
      for (let x = rectOffset; x < rectOffset + rectSize; x++) {
        const i = (y * canvas + x) * channels;
        raw[i] = 10;
        raw[i + 1] = 10;
        raw[i + 2] = 10;
        raw[i + 3] = 255; // fully opaque
      }
    }
    const src = await sharp(raw, { raw: { width: canvas, height: canvas, channels } })
      .png()
      .toBuffer();

    const result = await trimPadSquare(src, { margin: 0.1 });

    // longSide = 100 (the opaque rect) → side = round(100 / 0.8) = 125.
    // The old (buggy) behavior would trim nothing and yield a 300x300 output.
    expect(result).toMatchObject({ width: 125, height: 125 });
    expect(await dims(result.buffer)).toEqual({ width: 125, height: 125 });

    // Corners are the default white pad background, not leftover transparent/black.
    const corner = await pixelWithAlpha(result.buffer, 3, 3);
    expect(corner).toMatchObject({ r: 255, g: 255, b: 255 });

    // Center is the trimmed opaque content.
    const centre = await pixelWithAlpha(result.buffer, 62, 62);
    expect(centre.r).toBeLessThan(50);
    expect(centre.a).toBeGreaterThan(200);
  });
});
