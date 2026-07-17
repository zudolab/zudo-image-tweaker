import sharp, { type SharpInput } from 'sharp';

// EXIF ASCII date tags (DateTimeOriginal / DateTime) are both stored as
// `YYYY:MM:DD HH:MM:SS`. Scanning the raw EXIF segment as latin1 text finds
// either tag without depending on a full EXIF/TIFF IFD parser.
const EXIF_DATE_PATTERN = /(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})/;

/**
 * Find the first `DateTimeOriginal`/`DateTime`-shaped timestamp in a raw EXIF
 * buffer. Treats the timestamp as UTC — cameras store EXIF dates without a
 * time zone, so this is an intentional approximation that preserves the
 * wall-clock values. Returns `null` when no usable date is found.
 */
export function parseExifDate(buffer: Buffer | Uint8Array | null | undefined): Date | null {
  if (!buffer || buffer.length === 0) return null;

  const ascii = Buffer.isBuffer(buffer)
    ? buffer.toString('latin1')
    : Buffer.from(buffer).toString('latin1');

  const match = ascii.match(EXIF_DATE_PATTERN);
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
