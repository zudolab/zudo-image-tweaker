import { noTagParser } from './tags.js';
import type { ProcessOneConfig } from './types.js';

/** Width ladder the photo preset emits. */
export const PHOTO_VARIANT_WIDTHS = [400, 800, 1600];

/**
 * Config fragment reproducing the source photo pipeline on top of the same
 * engine: a smaller [400, 800, 1600] width ladder, EXIF orientation baked
 * into pixels and all metadata stripped (see the `stripMetadata` behavior
 * matrix in ProcessOneConfig), and no OGP or filename-tag dispatch (every
 * file is a plain full-variant image).
 *
 * Spread it into a call and add the paths, e.g.
 * `processImages({ ...photoVariantsPreset, inputDir, outputDir })`.
 */
export const photoVariantsPreset = {
  widths: PHOTO_VARIANT_WIDTHS,
  bakeExifOrientation: true,
  stripMetadata: true,
  tagParser: noTagParser,
} satisfies Partial<ProcessOneConfig>;
