/**
 * Decide whether a raw EXIF `Orientation` tag value (0x0112, values 1-8)
 * requires baking pixels upright before upload.
 *
 * Orientation `1` (or a missing/malformed tag) means the pixels are already
 * upright — no canvas round-trip needed. Any other valid value (2-8) means
 * the decoder must rotate/flip on display, so we bake it in via canvas
 * before the bytes leave the browser (see `bakeOrientation` in
 * `prepare-upload.ts`, which delegates the actual rotate/flip math to
 * `createImageBitmap(..., { imageOrientation: 'from-image' })`).
 */
export function needsOrientationBake(exifOrientation: number | undefined): boolean {
  return exifOrientation !== undefined && exifOrientation >= 2 && exifOrientation <= 8;
}
