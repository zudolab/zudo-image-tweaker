import sharp, { type SharpInput } from 'sharp';

// EXIF ASCII date tags (DateTimeOriginal / DateTime / DateTimeDigitized) are
// all stored as `YYYY:MM:DD HH:MM:SS` (CIPA DC-008 / TIFF 6.0).
const EXIF_DATE_PATTERN = /(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})/;

// TIFF/EXIF tag ids relevant to capture-date resolution (CIPA DC-008).
const TAG_DATETIME = 0x0132; // IFD0 — file modification date
const TAG_EXIF_IFD_POINTER = 0x8769; // IFD0 — offset of the Exif sub-IFD
const TAG_DATETIME_ORIGINAL = 0x9003; // Exif IFD — capture date
const TAG_DATETIME_DIGITIZED = 0x9004; // Exif IFD — digitization date
const TIFF_TYPE_ASCII = 2;
const IFD_ENTRY_SIZE = 12;
// The TIFF header sits at the start of the buffer or right after a short
// wrapper (`Exif\0\0`, JPEG APP1 marker bytes). Searching a small window
// covers those layouts without letting random `II*\0` noise deep inside the
// segment masquerade as a header.
const TIFF_HEADER_SEARCH_WINDOW = 64;
// EXIF date values are exactly 20 bytes; anything much larger in a date tag
// is malformed. A small cap keeps a bogus count from allocating/reading big.
const MAX_ASCII_DATE_BYTES = 64;

/**
 * Validate and convert one `YYYY:MM:DD HH:MM:SS` EXIF timestamp to a `Date`.
 * Treats the timestamp as UTC — cameras store EXIF dates without a time
 * zone, so this is an intentional approximation that preserves the
 * wall-clock values.
 */
function exifTimestampToDate(text: string): Date | null {
  const match = text.match(EXIF_DATE_PATTERN);
  if (!match) return null;

  const [, year, month, day, hour, minute, second] = match;
  const date = new Date(`${year}-${month}-${day}T${hour}:${minute}:${second}Z`);
  if (Number.isNaN(date.getTime())) return null;

  // `Date` silently rolls over out-of-range fields (e.g. `2024:04:31` becomes
  // May 1st) instead of producing Invalid Date, so a match on the pattern
  // isn't proof the value was a real calendar date. Reject anything that
  // doesn't round-trip back to the exact fields we parsed.
  const roundTrips =
    date.getUTCFullYear() === Number(year) &&
    date.getUTCMonth() === Number(month) - 1 &&
    date.getUTCDate() === Number(day) &&
    date.getUTCHours() === Number(hour) &&
    date.getUTCMinutes() === Number(minute) &&
    date.getUTCSeconds() === Number(second);

  return roundTrips ? date : null;
}

function findTiffHeader(buf: Buffer): { base: number; littleEndian: boolean } | null {
  const limit = Math.min(buf.length - 8, TIFF_HEADER_SEARCH_WINDOW);
  for (let i = 0; i <= limit; i++) {
    if (buf[i] === 0x49 && buf[i + 1] === 0x49 && buf[i + 2] === 0x2a && buf[i + 3] === 0x00) {
      return { base: i, littleEndian: true };
    }
    if (buf[i] === 0x4d && buf[i + 1] === 0x4d && buf[i + 2] === 0x00 && buf[i + 3] === 0x2a) {
      return { base: i, littleEndian: false };
    }
  }
  return null;
}

/**
 * Bounded TIFF/IFD walk over an EXIF segment: IFD0 → Exif sub-IFD, reading
 * only the date tags. Prefers `DateTimeOriginal` (capture date) over
 * `DateTimeDigitized` over IFD0 `DateTime` (modification date), so edited
 * photos resolve to when they were shot, not when they were last saved.
 * Every offset/count is bounds-checked; malformed structures yield `null`
 * (the caller falls back to a plain text scan) rather than throwing.
 */
function extractTaggedExifDate(buf: Buffer): Date | null {
  const header = findTiffHeader(buf);
  if (!header) return null;
  const { base, littleEndian } = header;

  const readU16 = (offset: number): number | null =>
    offset >= 0 && offset + 2 <= buf.length
      ? littleEndian
        ? buf.readUInt16LE(offset)
        : buf.readUInt16BE(offset)
      : null;
  const readU32 = (offset: number): number | null =>
    offset >= 0 && offset + 4 <= buf.length
      ? littleEndian
        ? buf.readUInt32LE(offset)
        : buf.readUInt32BE(offset)
      : null;

  // Returns entry offsets for the wanted tags in one IFD, or null when the
  // IFD's own structure (count, extent) doesn't fit inside the buffer.
  const findEntries = (ifdOffset: number, wanted: readonly number[]): Map<number, number> | null => {
    const entryCount = readU16(ifdOffset);
    if (entryCount === null) return null;
    if (ifdOffset + 2 + entryCount * IFD_ENTRY_SIZE > buf.length) return null;
    const found = new Map<number, number>();
    for (let i = 0; i < entryCount; i++) {
      const entryOffset = ifdOffset + 2 + i * IFD_ENTRY_SIZE;
      const tag = readU16(entryOffset);
      if (tag !== null && wanted.includes(tag)) found.set(tag, entryOffset);
    }
    return found;
  };

  const readAsciiValue = (entryOffset: number): string | null => {
    const type = readU16(entryOffset + 2);
    const count = readU32(entryOffset + 4);
    if (type !== TIFF_TYPE_ASCII || count === null || count < 1 || count > MAX_ASCII_DATE_BYTES) {
      return null;
    }
    // TIFF stores values <= 4 bytes inline in the entry, larger ones at an
    // offset relative to the TIFF header.
    let valueOffset: number;
    if (count <= 4) {
      valueOffset = entryOffset + 8;
    } else {
      const rel = readU32(entryOffset + 8);
      if (rel === null) return null;
      valueOffset = base + rel;
    }
    if (valueOffset + count > buf.length) return null;
    return buf.toString('latin1', valueOffset, valueOffset + count);
  };

  const ifd0Rel = readU32(base + 4);
  if (ifd0Rel === null) return null;
  const ifd0 = findEntries(base + ifd0Rel, [TAG_DATETIME, TAG_EXIF_IFD_POINTER]);
  if (ifd0 === null) return null;

  const candidateEntries: number[] = [];
  const exifPointerEntry = ifd0.get(TAG_EXIF_IFD_POINTER);
  if (exifPointerEntry !== undefined) {
    const exifIfdRel = readU32(exifPointerEntry + 8);
    if (exifIfdRel !== null) {
      const exifIfd = findEntries(base + exifIfdRel, [TAG_DATETIME_ORIGINAL, TAG_DATETIME_DIGITIZED]);
      if (exifIfd !== null) {
        for (const tag of [TAG_DATETIME_ORIGINAL, TAG_DATETIME_DIGITIZED]) {
          const entry = exifIfd.get(tag);
          if (entry !== undefined) candidateEntries.push(entry);
        }
      }
    }
  }
  const dateTimeEntry = ifd0.get(TAG_DATETIME);
  if (dateTimeEntry !== undefined) candidateEntries.push(dateTimeEntry);

  for (const entryOffset of candidateEntries) {
    const text = readAsciiValue(entryOffset);
    if (text === null) continue;
    const date = exifTimestampToDate(text);
    if (date) return date;
  }
  return null;
}

/**
 * Extract the capture date from a raw EXIF buffer. A bounded TIFF/IFD parse
 * resolves the tags in preference order — `DateTimeOriginal`, then
 * `DateTimeDigitized`, then IFD0 `DateTime` — so edited photos (where
 * `DateTime` is the modification date) still return when they were shot.
 * Buffers that aren't TIFF-parseable fall back to scanning the bytes for the
 * first timestamp-shaped text, preserving the previous behavior. Timestamps
 * are interpreted as UTC (EXIF dates carry no time zone). Returns `null`
 * when no usable date is found; never throws on malformed input.
 */
export function parseExifDate(buffer: Buffer | Uint8Array | null | undefined): Date | null {
  if (!buffer || buffer.length === 0) return null;

  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);

  try {
    const tagged = extractTaggedExifDate(buf);
    if (tagged) return tagged;
  } catch {
    // Defense in depth: every read is bounds-checked above, but a parser bug
    // on hostile input must degrade to the text-scan fallback, not throw.
  }

  return exifTimestampToDate(buf.toString('latin1'));
}

/**
 * Physically rotate/flip pixel data to match the source's EXIF `Orientation`
 * tag, then re-encode without metadata — except the ICC profile, which is
 * retained with the pixel values untouched (`keepIccProfile`). Use this
 * before serving an image so viewers that ignore EXIF orientation still
 * display it upright.
 *
 * Retaining the profile keeps this usable as a mid-pipeline step (issue
 * #71): a downstream encode can still choose to carry the profile through
 * or to drop it — sharp's default pipeline genuinely converts pixels to
 * sRGB via the embedded profile before dropping it. Stripping the profile
 * HERE would lock a wide-gamut source into an early sRGB conversion.
 */
export async function bakeOrientation(input: SharpInput): Promise<Buffer> {
  return sharp(input).rotate().keepIccProfile().toBuffer();
}

/**
 * Re-encode an image with all metadata (EXIF, ICC profile, XMP, …) removed,
 * without altering pixel orientation.
 */
export async function stripExif(input: SharpInput): Promise<Buffer> {
  return sharp(input).toBuffer();
}

export type Orientation = 'landscape' | 'portrait' | 'square';

/**
 * Classify a pixel dimension pair as landscape, portrait, or square.
 */
export function deriveOrientation(width: number, height: number): Orientation {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new Error(`deriveOrientation: invalid dimensions width=${width} height=${height}`);
  }
  if (width > height) return 'landscape';
  if (width < height) return 'portrait';
  return 'square';
}

/**
 * Filter a list of candidate variant widths down to those that don't exceed
 * the source's width, preserving input order — never upscale.
 */
export function pickVariantWidths(srcWidth: number, widths: number[]): number[] {
  if (!Number.isFinite(srcWidth) || srcWidth <= 0) return [];
  return widths.filter((w) => w <= srcWidth);
}
