import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { bakeOrientation, deriveOrientation, parseExifDate, pickVariantWidths, stripExif } from './index.js';

describe('parseExifDate', () => {
  it('finds a DateTimeOriginal-shaped timestamp inside a raw EXIF buffer', () => {
    // A real EXIF segment is TIFF/IFD-structured binary; parseExifDate only
    // needs the ASCII date text to be present somewhere in the buffer, so a
    // minimal synthetic buffer with binary noise around the date is enough.
    const noise = Buffer.from([0x45, 0x78, 0x69, 0x66, 0x00, 0x00, 0x4d, 0x4d]);
    const dateAscii = Buffer.from('2024:03:14 10:22:05', 'latin1');
    const buffer = Buffer.concat([noise, dateAscii, Buffer.from([0x00, 0x00])]);

    const date = parseExifDate(buffer);
    expect(date).toBeInstanceOf(Date);
    expect(date?.toISOString()).toBe('2024-03-14T10:22:05.000Z');
  });

  it('returns null for an empty or missing buffer', () => {
    expect(parseExifDate(Buffer.alloc(0))).toBeNull();
    expect(parseExifDate(null)).toBeNull();
    expect(parseExifDate(undefined)).toBeNull();
  });

  it('returns null when no date pattern is present', () => {
    const buffer = Buffer.from('no timestamp in here', 'latin1');
    expect(parseExifDate(buffer)).toBeNull();
  });

  it('accepts a Uint8Array as well as a Buffer', () => {
    const buffer = new Uint8Array(Buffer.from('DateTime: 2023:01:02 03:04:05', 'latin1'));
    const date = parseExifDate(buffer);
    expect(date?.toISOString()).toBe('2023-01-02T03:04:05.000Z');
  });

  it('rejects pattern-matching but calendar-invalid dates instead of silently rolling over', () => {
    // `Date` normalizes these into the next month rather than producing
    // Invalid Date, so a naive NaN check alone would accept them.
    expect(parseExifDate(Buffer.from('2024:04:31 00:00:00', 'latin1'))).toBeNull();
    expect(parseExifDate(Buffer.from('2023:02:29 00:00:00', 'latin1'))).toBeNull();
  });

  it('accepts a valid leap-day date', () => {
    const date = parseExifDate(Buffer.from('2024:02:29 12:00:00', 'latin1'));
    expect(date?.toISOString()).toBe('2024-02-29T12:00:00.000Z');
  });
});

describe('bakeOrientation / stripExif', () => {
  const width = 4;
  const height = 2;

  async function orientedFixture(orientation: number): Promise<Buffer> {
    const raw = Buffer.alloc(width * height * 3, 128);
    return sharp(raw, { raw: { width, height, channels: 3 } })
      .withMetadata({ orientation })
      .jpeg()
      .toBuffer();
  }

  it('bakeOrientation physically rotates pixels to match EXIF orientation 6 (90deg CW) and strips metadata', async () => {
    const oriented = await orientedFixture(6);
    const orientedMeta = await sharp(oriented).metadata();
    expect(orientedMeta.orientation).toBe(6);
    expect(orientedMeta.width).toBe(width);
    expect(orientedMeta.height).toBe(height);

    const baked = await bakeOrientation(oriented);
    expect(Buffer.isBuffer(baked)).toBe(true);

    const bakedMeta = await sharp(baked).metadata();
    expect(bakedMeta.orientation).toBeUndefined();
    // Orientation 6 is a 90deg rotation, so the visual (post-rotation)
    // width/height swap relative to the stored dimensions.
    expect(bakedMeta.width).toBe(height);
    expect(bakedMeta.height).toBe(width);
  });

  it('stripExif removes metadata without altering pixel orientation', async () => {
    const oriented = await orientedFixture(6);

    const stripped = await stripExif(oriented);
    expect(Buffer.isBuffer(stripped)).toBe(true);

    const strippedMeta = await sharp(stripped).metadata();
    expect(strippedMeta.orientation).toBeUndefined();
    expect(strippedMeta.width).toBe(width);
    expect(strippedMeta.height).toBe(height);
  });
});

describe('deriveOrientation', () => {
  it('is landscape when width > height', () => {
    expect(deriveOrientation(4000, 3000)).toBe('landscape');
  });

  it('is portrait when width < height', () => {
    expect(deriveOrientation(3000, 4000)).toBe('portrait');
  });

  it('is square when width === height', () => {
    expect(deriveOrientation(3000, 3000)).toBe('square');
  });

  it('rejects non-positive or non-finite dimensions', () => {
    expect(() => deriveOrientation(0, 100)).toThrow();
    expect(() => deriveOrientation(-10, 100)).toThrow();
    expect(() => deriveOrientation(Number.NaN, 100)).toThrow();
  });
});

describe('pickVariantWidths', () => {
  const widths = [400, 800, 1600];

  it('emits all widths when the source is big enough', () => {
    expect(pickVariantWidths(4000, widths)).toEqual([400, 800, 1600]);
    expect(pickVariantWidths(1600, widths)).toEqual([400, 800, 1600]);
  });

  it('omits widths larger than the source (no upscaling)', () => {
    expect(pickVariantWidths(1599, widths)).toEqual([400, 800]);
    expect(pickVariantWidths(800, widths)).toEqual([400, 800]);
    expect(pickVariantWidths(799, widths)).toEqual([400]);
    expect(pickVariantWidths(400, widths)).toEqual([400]);
  });

  it('emits nothing when the source is smaller than the narrowest width', () => {
    expect(pickVariantWidths(399, widths)).toEqual([]);
    expect(pickVariantWidths(0, widths)).toEqual([]);
    expect(pickVariantWidths(-1, widths)).toEqual([]);
    expect(pickVariantWidths(Number.NaN, widths)).toEqual([]);
  });

  it('preserves the input widths order', () => {
    expect(pickVariantWidths(2000, [1600, 400, 800])).toEqual([1600, 400, 800]);
  });
});
