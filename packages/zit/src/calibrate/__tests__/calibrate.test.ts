import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import {
  calibrateTargetFromSamples,
  normalizeBackgroundColor,
  sampleBackgroundColor,
  type RgbColor,
} from '../index.js';

function buildRawImage(
  width: number,
  height: number,
  colorAt: (x: number, y: number) => RgbColor,
): Buffer {
  const raw = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const { r, g, b } = colorAt(x, y);
      const idx = (y * width + x) * 3;
      raw[idx] = r;
      raw[idx + 1] = g;
      raw[idx + 2] = b;
    }
  }
  return raw;
}

async function toPng(raw: Buffer, width: number, height: number): Promise<Buffer> {
  return sharp(raw, { raw: { width, height, channels: 3 } }).png().toBuffer();
}

function solidColorAt(color: RgbColor): (x: number, y: number) => RgbColor {
  return () => color;
}

function quadrantColorAt(
  width: number,
  height: number,
  colors: [RgbColor, RgbColor, RgbColor, RgbColor],
): (x: number, y: number) => RgbColor {
  return (x, y) => {
    const left = x < width / 2;
    const top = y < height / 2;
    if (top && left) return colors[0];
    if (top && !left) return colors[1];
    if (!top && left) return colors[2];
    return colors[3];
  };
}

async function readRawRgb(buffer: Buffer): Promise<{ data: Buffer; width: number; height: number }> {
  const { data, info } = await sharp(buffer)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

function pixelAt(data: Buffer, width: number, x: number, y: number): RgbColor {
  const idx = (y * width + x) * 3;
  return { r: data[idx], g: data[idx + 1], b: data[idx + 2] };
}

describe('sampleBackgroundColor', () => {
  it('averages four distinct corner-quadrant colors', async () => {
    const colors: [RgbColor, RgbColor, RgbColor, RgbColor] = [
      { r: 10, g: 20, b: 30 }, // top-left
      { r: 200, g: 150, b: 100 }, // top-right
      { r: 50, g: 60, b: 70 }, // bottom-left
      { r: 90, g: 180, b: 220 }, // bottom-right
    ];
    const raw = buildRawImage(200, 200, quadrantColorAt(200, 200, colors));
    const png = await toPng(raw, 200, 200);

    const result = await sampleBackgroundColor(png);

    expect(result).toEqual({ r: 88, g: 103, b: 105 });
  });

  it('ignores the image center, only sampling the four corners', async () => {
    const bg: RgbColor = { r: 40, g: 40, b: 40 };
    const centerColor: RgbColor = { r: 250, g: 5, b: 5 };
    const colorAt = (x: number, y: number): RgbColor =>
      x >= 80 && x < 120 && y >= 80 && y < 120 ? centerColor : bg;
    const raw = buildRawImage(200, 200, colorAt);
    const png = await toPng(raw, 200, 200);

    const result = await sampleBackgroundColor(png);

    expect(result).toEqual(bg);
  });

  it('honors a custom patchSize and its derived minimum-dimension check', async () => {
    const colors: [RgbColor, RgbColor, RgbColor, RgbColor] = [
      { r: 0, g: 0, b: 0 },
      { r: 100, g: 100, b: 100 },
      { r: 200, g: 200, b: 200 },
      { r: 60, g: 60, b: 60 },
    ];
    const raw = buildRawImage(30, 30, quadrantColorAt(30, 30, colors));
    const png = await toPng(raw, 30, 30);

    await expect(sampleBackgroundColor(png)).rejects.toThrow(/too small/i);

    const result = await sampleBackgroundColor(png, { patchSize: 10 });
    expect(result).toEqual({ r: 90, g: 90, b: 90 });
  });
});

describe('calibrateTargetFromSamples', () => {
  it('averages the sampled background of multiple reference images', async () => {
    const image1 = await toPng(buildRawImage(60, 60, solidColorAt({ r: 100, g: 50, b: 200 })), 60, 60);
    const image2 = await toPng(buildRawImage(60, 60, solidColorAt({ r: 200, g: 150, b: 0 })), 60, 60);
    const image3 = await toPng(buildRawImage(60, 60, solidColorAt({ r: 0, g: 250, b: 100 })), 60, 60);

    const result = await calibrateTargetFromSamples([image1, image2, image3]);

    expect(result).toEqual({ r: 100, g: 150, b: 100 });
  });

  it('rejects an empty reference list', async () => {
    await expect(calibrateTargetFromSamples([])).rejects.toThrow(/at least one/i);
  });
});

describe('normalizeBackgroundColor', () => {
  const BG: RgbColor = { r: 150, g: 100, b: 60 };
  const GRAY: RgbColor = { r: 128, g: 128, b: 128 };

  function bgWithGrayPatch(x: number, y: number): RgbColor {
    return x >= 80 && x < 120 && y >= 80 && y < 120 ? GRAY : BG;
  }

  it('moves the background toward the target while leaving a neutral-gray patch (near-)invariant', async () => {
    const raw = buildRawImage(200, 200, bgWithGrayPatch);
    const png = await toPng(raw, 200, 200);
    const target: RgbColor = { r: 180, g: 80, b: 90 };

    const result = await normalizeBackgroundColor(png, { target, format: 'png' });

    expect(result.applied.scaleR).toBeCloseTo(1.2, 5);
    expect(result.applied.scaleG).toBeCloseTo(0.8, 5);
    expect(result.applied.scaleB).toBeCloseTo(1.5, 5);

    const { data, width } = await readRawRgb(result.buffer);

    // A background pixel (top-left corner patch) lands exactly on target:
    // the sampled current color equals the reference hue exactly (weight 1)
    // and the unclamped scale is applied in full.
    expect(pixelAt(data, width, 5, 5)).toEqual(target);

    // The neutral-gray patch has zero saturation, so it's gated out of
    // correction entirely and must come back unchanged.
    expect(pixelAt(data, width, 100, 100)).toEqual(GRAY);
  });

  it('clamps per-channel scale factors to the default [0.5, 2.0] range', async () => {
    const raw = buildRawImage(200, 200, solidColorAt({ r: 50, g: 50, b: 50 }));
    const png = await toPng(raw, 200, 200);
    const target: RgbColor = { r: 250, g: 5, b: 50 };

    const result = await normalizeBackgroundColor(png, { target, format: 'png' });

    expect(result.applied.scaleR).toBeCloseTo(2.0, 5); // 250/50 = 5.0, clamped down
    expect(result.applied.scaleG).toBeCloseTo(0.5, 5); // 5/50 = 0.1, clamped up
    expect(result.applied.scaleB).toBeCloseTo(1.0, 5); // 50/50 = 1.0, within range
  });

  it('honors a custom channelClamp range', async () => {
    const raw = buildRawImage(200, 200, solidColorAt({ r: 50, g: 50, b: 50 }));
    const png = await toPng(raw, 200, 200);
    const target: RgbColor = { r: 250, g: 5, b: 50 };

    const result = await normalizeBackgroundColor(png, {
      target,
      format: 'png',
      channelClamp: [0.8, 1.2],
    });

    expect(result.applied.scaleR).toBeCloseTo(1.2, 5);
    expect(result.applied.scaleG).toBeCloseTo(0.8, 5);
    expect(result.applied.scaleB).toBeCloseTo(1.0, 5);
  });

  it('leaves every pixel untouched when the sampled background is achromatic', async () => {
    // A gray/white background has no meaningful hue to match pixels
    // against. A red patch in the middle is saturated and would land at
    // hue 0 — the same degenerate hue an achromatic reference reports —
    // so without the achromatic-reference gate it would be wrongly
    // "corrected" as if it were background.
    const WHITE_BG: RgbColor = { r: 220, g: 220, b: 220 };
    const RED_PATCH: RgbColor = { r: 220, g: 20, b: 20 };
    const colorAt = (x: number, y: number): RgbColor =>
      x >= 80 && x < 120 && y >= 80 && y < 120 ? RED_PATCH : WHITE_BG;
    const raw = buildRawImage(200, 200, colorAt);
    const png = await toPng(raw, 200, 200);
    const target: RgbColor = { r: 255, g: 255, b: 255 };

    const result = await normalizeBackgroundColor(png, { target, format: 'png' });
    const { data, width } = await readRawRgb(result.buffer);

    expect(pixelAt(data, width, 5, 5)).toEqual(WHITE_BG);
    expect(pixelAt(data, width, 100, 100)).toEqual(RED_PATCH);
  });

  it('applies EXIF orientation before sampling/correcting so the output is upright', async () => {
    // Stored (as-encoded) dimensions are 60 wide x 80 tall; orientation 6
    // ("rotate 90deg clockwise to display correctly") means the true
    // displayed image is 80 wide x 60 tall. A correct implementation
    // auto-rotates before processing and returns an upright buffer with no
    // lingering orientation tag.
    const storedWidth = 60;
    const storedHeight = 80;
    const raw = buildRawImage(storedWidth, storedHeight, solidColorAt({ r: 180, g: 80, b: 40 }));
    const jpeg = await sharp(raw, { raw: { width: storedWidth, height: storedHeight, channels: 3 } })
      .withMetadata({ orientation: 6 })
      .jpeg({ quality: 100 })
      .toBuffer();

    const result = await normalizeBackgroundColor(jpeg, {
      target: { r: 180, g: 80, b: 40 },
      format: 'jpeg',
    });
    const outMeta = await sharp(result.buffer).metadata();

    expect(outMeta.width).toBe(80);
    expect(outMeta.height).toBe(60);
    expect(outMeta.orientation ?? 1).toBe(1);
  });

  it('preserves the alpha channel for transparent input instead of flattening it opaque', async () => {
    const width = 200;
    const height = 200;
    const rgba = Buffer.alloc(width * height * 4);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const idx = (y * width + x) * 4;
        const isHole = x >= 90 && x < 110 && y >= 90 && y < 110;
        rgba[idx] = 180;
        rgba[idx + 1] = 80;
        rgba[idx + 2] = 40;
        rgba[idx + 3] = isHole ? 0 : 255;
      }
    }
    const png = await sharp(rgba, { raw: { width, height, channels: 4 } }).png().toBuffer();

    const result = await normalizeBackgroundColor(png, {
      target: { r: 100, g: 200, b: 60 },
      format: 'png',
    });
    const { data, info } = await sharp(result.buffer).raw().toBuffer({ resolveWithObject: true });

    expect(info.channels).toBe(4);
    const holeIdx = (100 * info.width + 100) * 4;
    expect(data[holeIdx + 3]).toBe(0);
    const opaqueIdx = (5 * info.width + 5) * 4;
    expect(data[opaqueIdx + 3]).toBe(255);
  });

  it('preserves a wide-gamut (Display-P3) ICC profile byte-identically (issue #35)', async () => {
    const raw = buildRawImage(200, 200, solidColorAt(BG));
    const p3Jpeg = await sharp(raw, { raw: { width: 200, height: 200, channels: 3 } })
      .jpeg({ quality: 100 })
      .withIccProfile('p3')
      .toBuffer();
    const sourceIcc = Buffer.from((await sharp(p3Jpeg).metadata()).icc!);

    const result = await normalizeBackgroundColor(p3Jpeg, {
      target: { r: 180, g: 80, b: 90 },
      format: 'jpeg',
    });

    const outMeta = await sharp(result.buffer).metadata();
    expect(outMeta.icc).toBeDefined();
    expect(Buffer.from(outMeta.icc!).equals(sourceIcc)).toBe(true);
  });

  it('emits no ICC profile when the source carries none', async () => {
    const raw = buildRawImage(200, 200, solidColorAt(BG));
    const png = await toPng(raw, 200, 200);

    const result = await normalizeBackgroundColor(png, { target: { r: 180, g: 80, b: 90 }, format: 'png' });

    expect((await sharp(result.buffer).metadata()).icc).toBeUndefined();
  });

  it('rejects a non-positive or fractional patchSize instead of silently miscounting pixels', async () => {
    const raw = buildRawImage(200, 200, solidColorAt(BG));
    const png = await toPng(raw, 200, 200);
    const target: RgbColor = { r: 180, g: 80, b: 90 };

    await expect(normalizeBackgroundColor(png, { target, patchSize: 0 })).rejects.toThrow(/positive integer/i);
    await expect(normalizeBackgroundColor(png, { target, patchSize: -5 })).rejects.toThrow(/positive integer/i);
    await expect(normalizeBackgroundColor(png, { target, patchSize: 10.5 })).rejects.toThrow(/positive integer/i);
  });

  it('EXIF policy: EXIF is always dropped from the output (documented in the module/function JSDoc)', async () => {
    const raw = buildRawImage(200, 200, solidColorAt(BG));
    const jpeg = await sharp(raw, { raw: { width: 200, height: 200, channels: 3 } })
      .withExif({ IFD0: { Make: 'ZitTestCamera' } })
      .jpeg({ quality: 100 })
      .toBuffer();
    expect((await sharp(jpeg).metadata()).exif).toBeDefined();

    const result = await normalizeBackgroundColor(jpeg, { target: { r: 180, g: 80, b: 90 }, format: 'jpeg' });

    expect((await sharp(result.buffer).metadata()).exif).toBeUndefined();
  });
});
