import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { bakeOrientation, deriveOrientation, parseExifDate, pickVariantWidths, stripExif } from './index.js';

const TAG_DATETIME = 0x0132;
const TAG_EXIF_IFD_POINTER = 0x8769;
const TAG_DATETIME_ORIGINAL = 0x9003;
const TAG_DATETIME_DIGITIZED = 0x9004;
const TIFF_TYPE_ASCII = 2;
const TIFF_TYPE_LONG = 4;
const IFD_ENTRY_SIZE = 12;

interface ExifSegmentOptions {
  littleEndian: boolean;
  /** IFD0 DateTime (modification date). */
  dateTime?: string;
  /** Exif IFD DateTimeOriginal (capture date). */
  dateTimeOriginal?: string;
  /** Exif IFD DateTimeDigitized. */
  dateTimeDigitized?: string;
  /** Prepend the `Exif\0\0` APP1 identifier before the TIFF header. */
  exifPrefix?: boolean;
}

/**
 * Build a structurally valid EXIF segment (TIFF header + IFD0 + optional
 * Exif sub-IFD) with the given date tags, in either byte order. Layout:
 * header, IFD0, Exif IFD, then a data heap holding the ASCII date values.
 */
function buildExifSegment(options: ExifSegmentOptions): Buffer {
  const { littleEndian: le } = options;
  const exifTags: Array<[number, string]> = [];
  if (options.dateTimeOriginal) exifTags.push([TAG_DATETIME_ORIGINAL, options.dateTimeOriginal]);
  if (options.dateTimeDigitized) exifTags.push([TAG_DATETIME_DIGITIZED, options.dateTimeDigitized]);
  const ifd0Tags: Array<[number, string]> = [];
  if (options.dateTime) ifd0Tags.push([TAG_DATETIME, options.dateTime]);

  const ifd0EntryCount = ifd0Tags.length + (exifTags.length > 0 ? 1 : 0);
  const headerSize = 8;
  const ifd0Size = 2 + ifd0EntryCount * IFD_ENTRY_SIZE + 4;
  const exifIfdOffset = headerSize + ifd0Size;
  const exifIfdSize = exifTags.length > 0 ? 2 + exifTags.length * IFD_ENTRY_SIZE + 4 : 0;
  const heapStart = exifIfdOffset + exifIfdSize;
  const asciiValues = [...ifd0Tags, ...exifTags].map(([, v]) => v);
  const heapSize = asciiValues.reduce((sum, v) => sum + v.length + 1, 0);

  const buf = Buffer.alloc(heapStart + heapSize);
  const w16 = (value: number, offset: number) =>
    le ? buf.writeUInt16LE(value, offset) : buf.writeUInt16BE(value, offset);
  const w32 = (value: number, offset: number) =>
    le ? buf.writeUInt32LE(value, offset) : buf.writeUInt32BE(value, offset);

  buf.write(le ? 'II' : 'MM', 0, 'latin1');
  w16(42, 2);
  w32(headerSize, 4); // IFD0 immediately after the header

  let heapCursor = heapStart;
  const writeAsciiEntry = (entryOffset: number, tag: number, value: string): void => {
    w16(tag, entryOffset);
    w16(TIFF_TYPE_ASCII, entryOffset + 2);
    w32(value.length + 1, entryOffset + 4); // count includes the NUL terminator
    w32(heapCursor, entryOffset + 8);
    buf.write(value, heapCursor, 'latin1');
    heapCursor += value.length + 1;
  };

  w16(ifd0EntryCount, headerSize);
  let entryOffset = headerSize + 2;
  for (const [tag, value] of ifd0Tags) {
    writeAsciiEntry(entryOffset, tag, value);
    entryOffset += IFD_ENTRY_SIZE;
  }
  if (exifTags.length > 0) {
    w16(TAG_EXIF_IFD_POINTER, entryOffset);
    w16(TIFF_TYPE_LONG, entryOffset + 2);
    w32(1, entryOffset + 4);
    w32(exifIfdOffset, entryOffset + 8);
    entryOffset += IFD_ENTRY_SIZE;
  }
  w32(0, entryOffset); // next-IFD pointer: none

  if (exifTags.length > 0) {
    w16(exifTags.length, exifIfdOffset);
    let exifEntryOffset = exifIfdOffset + 2;
    for (const [tag, value] of exifTags) {
      writeAsciiEntry(exifEntryOffset, tag, value);
      exifEntryOffset += IFD_ENTRY_SIZE;
    }
    w32(0, exifEntryOffset);
  }

  return options.exifPrefix ? Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), buf]) : buf;
}

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

  describe.each([
    { label: 'little-endian (II)', littleEndian: true },
    { label: 'big-endian (MM)', littleEndian: false },
  ])('tag-aware TIFF/IFD parse, $label', ({ littleEndian }) => {
    const modified = '2025:06:01 09:00:00';
    const captured = '2020:01:15 08:30:00';
    const digitized = '2021:07:04 12:00:00';

    it('prefers DateTimeOriginal over a divergent IFD0 DateTime', () => {
      // The heap stores the IFD0 DateTime bytes BEFORE DateTimeOriginal, so
      // a raw text scan would return the modification date — only a real
      // tag-aware parse resolves the capture date here.
      const segment = buildExifSegment({ littleEndian, dateTime: modified, dateTimeOriginal: captured });
      expect(parseExifDate(segment)?.toISOString()).toBe('2020-01-15T08:30:00.000Z');
    });

    it('prefers DateTimeOriginal over DateTimeDigitized', () => {
      const segment = buildExifSegment({
        littleEndian,
        dateTime: modified,
        dateTimeDigitized: digitized,
        dateTimeOriginal: captured,
      });
      expect(parseExifDate(segment)?.toISOString()).toBe('2020-01-15T08:30:00.000Z');
    });

    it('falls back to DateTimeDigitized when DateTimeOriginal is absent', () => {
      const segment = buildExifSegment({ littleEndian, dateTime: modified, dateTimeDigitized: digitized });
      expect(parseExifDate(segment)?.toISOString()).toBe('2021-07-04T12:00:00.000Z');
    });

    it('falls back to IFD0 DateTime when the Exif IFD tags are absent', () => {
      const segment = buildExifSegment({ littleEndian, dateTime: modified });
      expect(parseExifDate(segment)?.toISOString()).toBe('2025-06-01T09:00:00.000Z');
    });

    it('handles the Exif\\0\\0 APP1 prefix before the TIFF header', () => {
      const segment = buildExifSegment({
        littleEndian,
        dateTime: modified,
        dateTimeOriginal: captured,
        exifPrefix: true,
      });
      expect(parseExifDate(segment)?.toISOString()).toBe('2020-01-15T08:30:00.000Z');
    });

    it('skips a calendar-invalid DateTimeOriginal and uses the next candidate', () => {
      const segment = buildExifSegment({
        littleEndian,
        dateTime: modified,
        dateTimeOriginal: '2023:02:29 00:00:00',
      });
      expect(parseExifDate(segment)?.toISOString()).toBe('2025-06-01T09:00:00.000Z');
    });
  });

  describe('malformed EXIF robustness', () => {
    it('returns null for a TIFF header whose IFD0 offset points past the buffer', () => {
      const buf = Buffer.alloc(16);
      buf.write('II', 0, 'latin1');
      buf.writeUInt16LE(42, 2);
      buf.writeUInt32LE(0xffff_ff00, 4);
      expect(parseExifDate(buf)).toBeNull();
    });

    it('returns null for a bogus IFD entry count that overruns the buffer', () => {
      const buf = Buffer.alloc(16);
      buf.write('MM', 0, 'latin1');
      buf.writeUInt16BE(42, 2);
      buf.writeUInt32BE(8, 4);
      buf.writeUInt16BE(0xffff, 8); // claims 65535 entries in an 16-byte buffer
      expect(parseExifDate(buf)).toBeNull();
    });

    it('skips an ASCII value whose offset points past the buffer and uses the next candidate', () => {
      const segment = buildExifSegment({
        littleEndian: true,
        dateTime: '2025:06:01 09:00:00',
        dateTimeOriginal: '2020:01:15 08:30:00',
      });
      // Corrupt the DateTimeOriginal value offset (Exif IFD's first entry).
      // Its candidate is skipped, so the next candidate (DateTime) wins.
      const exifIfdOffset = segment.readUInt32LE(8 + 2 + 1 * 12 + 8);
      segment.writeUInt32LE(0xffff_0000, exifIfdOffset + 2 + 8);
      expect(parseExifDate(segment)?.toISOString()).toBe('2025-06-01T09:00:00.000Z');
    });

    it('survives truncation at every length of a valid segment without throwing', () => {
      const segment = buildExifSegment({
        littleEndian: true,
        dateTime: '2025:06:01 09:00:00',
        dateTimeOriginal: '2020:01:15 08:30:00',
        exifPrefix: true,
      });
      for (let length = 0; length < segment.length; length++) {
        expect(() => parseExifDate(segment.subarray(0, length))).not.toThrow();
      }
    });

    it('never throws on random fuzz buffers seeded with TIFF headers', () => {
      for (let round = 0; round < 200; round++) {
        const buf = Buffer.alloc(64 + Math.floor(Math.random() * 192));
        for (let i = 0; i < buf.length; i++) buf[i] = Math.floor(Math.random() * 256);
        buf.write(round % 2 === 0 ? 'II' : 'MM', 0, 'latin1');
        if (round % 2 === 0) buf.writeUInt16LE(42, 2);
        else buf.writeUInt16BE(42, 2);
        expect(() => parseExifDate(buf)).not.toThrow();
      }
    });
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

  it('bakeOrientation retains the ICC profile while still dropping the orientation tag (issue #71)', async () => {
    const oriented = await sharp(await orientedFixture(6))
      .withMetadata({ orientation: 6 })
      .withIccProfile('p3')
      .toBuffer();
    const sourceIcc = Buffer.from((await sharp(oriented).metadata()).icc!);

    const baked = await bakeOrientation(oriented);

    const bakedMeta = await sharp(baked).metadata();
    expect(bakedMeta.orientation).toBeUndefined();
    expect(bakedMeta.icc).toBeDefined();
    expect(Buffer.from(bakedMeta.icc!).equals(sourceIcc)).toBe(true);
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
