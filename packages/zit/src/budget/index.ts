/**
 * Encode an image so its output stays under a byte-count ceiling, by
 * progressively lowering quality (and, when quality alone isn't enough,
 * width) until the result fits.
 *
 * Two presets cover the two shapes this problem takes in practice:
 *
 * - **Exact-width preset** (`exactWidth` set): the output width is fixed —
 *   smaller sources are upscaled to it, larger ones downscaled — and only
 *   PNG compression quality steps down across a small ladder of rungs
 *   (palette quantization kicks in at the lower rungs). Useful when a
 *   downstream consumer requires an exact pixel width regardless of size.
 * - **Step-down preset** (`exactWidth` omitted): the source's aspect ratio
 *   is kept, output format auto-detects JPEG vs PNG from the alpha
 *   channel, and once the quality ladder at the current width is
 *   exhausted the width itself steps down (down to `minWidth`) before the
 *   ladder is retried. Useful when only a total byte ceiling matters, not
 *   an exact width.
 *
 * Both presets share the same budget-loop, GIF-skip, and input-loading
 * machinery; `qualityLadder`, `minWidth`, `widthStepFactor`, and
 * `paletteQuantization` let a caller override either preset's defaults.
 */

import fs from 'node:fs/promises';
import sharp from 'sharp';
import type { PngOptions } from 'sharp';

export interface Step {
  width: number;
  quality: number;
  bytes: number;
}

export type BudgetResult =
  | {
      ok: true;
      buffer: Buffer;
      format: 'jpeg' | 'png';
      width: number;
      quality: number;
      bytes: number;
      steps: Step[];
    }
  | {
      ok: false;
      reason: 'unreachable-budget' | 'animated-gif-skipped';
      steps: Step[];
    };

export interface EncodeUnderByteBudgetOptions {
  /** Byte-count ceiling the encoded output must not exceed. */
  maxBytes: number;
  /**
   * Explicit output format, or `'auto'` to detect from the source's alpha
   * channel (PNG when present, JPEG otherwise). Defaults to `'png'` when
   * `exactWidth` is set and this is omitted, `'auto'` behavior otherwise.
   */
  format?: 'jpeg' | 'png' | 'auto';
  /** Fixed output width; enables the exact-width preset. Upscales smaller sources. */
  exactWidth?: number;
  /** Overrides the default quality rungs tried at each width. */
  qualityLadder?: number[];
  /** Step-down preset only: width floor the step-down loop won't go below. Defaults to 400. */
  minWidth?: number;
  /** Step-down preset only: multiplier applied to width on each step-down. Defaults to 0.85. */
  widthStepFactor?: number;
  /** Whether the lower quality rungs may engage palette quantization for PNG output. Defaults to true. */
  paletteQuantization?: boolean;
}

const DEFAULT_MIN_WIDTH = 400;
const DEFAULT_WIDTH_STEP_FACTOR = 0.85;

const JPEG_QUALITY_LADDER = [90, 82, 75, 65, 55, 45, 35];
const EXACT_WIDTH_PNG_QUALITY_LADDER = [95, 85, 75, 65, 50];
// 100 is a sentinel for the highest-fidelity rung: no explicit sharp
// `quality` option is set, so PNG encoding stays near-lossless.
const STEP_DOWN_PNG_QUALITY_LADDER = [100, 90, 80, 65, 50];

/**
 * Encode `input` into a buffer no larger than `options.maxBytes`, stepping
 * down quality (and, in the step-down preset, width) until it fits.
 * Never throws for an unreachable budget or an animated GIF — both are
 * reported through the returned result's `ok: false` shape.
 */
export async function encodeUnderByteBudget(
  input: Buffer | string,
  options: EncodeUnderByteBudgetOptions,
): Promise<BudgetResult> {
  const {
    maxBytes,
    format: formatOption,
    exactWidth,
    qualityLadder,
    minWidth = DEFAULT_MIN_WIDTH,
    widthStepFactor = DEFAULT_WIDTH_STEP_FACTOR,
    paletteQuantization = true,
  } = options;

  const inputBuffer = await loadInput(input);
  const metadata = await sharp(inputBuffer).metadata();

  if (isAnimatedGif(metadata.format, metadata.pages)) {
    return { ok: false, reason: 'animated-gif-skipped', steps: [] };
  }

  if (!metadata.width || !metadata.height) {
    throw new Error('Could not read image dimensions from source');
  }

  const format = resolveFormat(formatOption, Boolean(metadata.hasAlpha), exactWidth !== undefined);

  if (exactWidth !== undefined) {
    return encodeExactWidth(inputBuffer, {
      format,
      exactWidth,
      maxBytes,
      qualityLadder: qualityLadder ?? EXACT_WIDTH_PNG_QUALITY_LADDER,
      paletteQuantization,
    });
  }

  // Both presets auto-orient via `.rotate()`, so downstream width tracking
  // must use the post-rotation width. `sharp().metadata()` always reports
  // the stored (pre-rotation) dimensions, even ahead of a pending
  // `.rotate()` call — EXIF orientations 5-8 rotate 90/270 degrees and so
  // swap width and height once actually rendered.
  const orientedWidth = isSwappedOrientation(metadata.orientation) ? metadata.height : metadata.width;

  return encodeWithWidthStepDown(inputBuffer, {
    format,
    sourceWidth: orientedWidth,
    maxBytes,
    qualityLadder: qualityLadder ?? (format === 'jpeg' ? JPEG_QUALITY_LADDER : STEP_DOWN_PNG_QUALITY_LADDER),
    minWidth,
    widthStepFactor,
    paletteQuantization,
  });
}

// ---------------------------------------------------------------------------
// Exact-width preset
// ---------------------------------------------------------------------------

async function encodeExactWidth(
  inputBuffer: Buffer,
  opts: {
    format: 'jpeg' | 'png';
    exactWidth: number;
    maxBytes: number;
    qualityLadder: number[];
    paletteQuantization: boolean;
  },
): Promise<BudgetResult> {
  const { format, exactWidth, maxBytes, qualityLadder, paletteQuantization } = opts;
  const steps: Step[] = [];

  for (const quality of qualityLadder) {
    const buffer = await encodeAtExactWidth(inputBuffer, format, exactWidth, quality, paletteQuantization);
    steps.push({ width: exactWidth, quality, bytes: buffer.length });

    if (buffer.length <= maxBytes) {
      return { ok: true, buffer, format, width: exactWidth, quality, bytes: buffer.length, steps };
    }
  }

  return { ok: false, reason: 'unreachable-budget', steps };
}

async function encodeAtExactWidth(
  inputBuffer: Buffer,
  format: 'jpeg' | 'png',
  width: number,
  quality: number,
  paletteQuantization: boolean,
): Promise<Buffer> {
  const pipeline = sharp(inputBuffer)
    .rotate() // auto-orient from EXIF
    .resize(width, null, { withoutEnlargement: false }); // allow upscaling to the exact width

  if (format === 'png') {
    return pipeline.png(exactWidthPngOptions(quality, paletteQuantization)).toBuffer();
  }
  return pipeline.jpeg({ quality, mozjpeg: true }).toBuffer();
}

function exactWidthPngOptions(quality: number, paletteQuantization: boolean): PngOptions {
  const opts: PngOptions = { compressionLevel: 9, effort: 10, quality };
  if (paletteQuantization && quality <= 65) {
    opts.palette = true;
    opts.colors = quality <= 50 ? 128 : 256;
    opts.dither = 1.0;
  } else {
    opts.palette = false;
  }
  return opts;
}

// ---------------------------------------------------------------------------
// Step-down preset
// ---------------------------------------------------------------------------

async function encodeWithWidthStepDown(
  inputBuffer: Buffer,
  opts: {
    format: 'jpeg' | 'png';
    sourceWidth: number;
    maxBytes: number;
    qualityLadder: number[];
    minWidth: number;
    widthStepFactor: number;
    paletteQuantization: boolean;
  },
): Promise<BudgetResult> {
  const { format, sourceWidth, maxBytes, qualityLadder, minWidth, widthStepFactor, paletteQuantization } = opts;
  const steps: Step[] = [];

  let width = sourceWidth;

  while (true) {
    for (const quality of qualityLadder) {
      // Keep the original size on the very first attempt; resize down once
      // a step-down has actually happened.
      const targetWidth = width === sourceWidth ? null : width;
      const buffer = await encodeAtWidth(inputBuffer, format, targetWidth, quality, paletteQuantization);
      steps.push({ width, quality, bytes: buffer.length });

      if (buffer.length <= maxBytes) {
        return { ok: true, buffer, format, width, quality, bytes: buffer.length, steps };
      }
    }

    const nextWidth = Math.round(width * widthStepFactor);
    if (nextWidth < minWidth || nextWidth >= width) {
      // The step factor would undershoot minWidth — try the floor itself
      // once before giving up (unless we're already there).
      if (width > minWidth) {
        width = minWidth;
        continue;
      }
      break;
    }
    width = nextWidth;
  }

  return { ok: false, reason: 'unreachable-budget', steps };
}

async function encodeAtWidth(
  inputBuffer: Buffer,
  format: 'jpeg' | 'png',
  width: number | null,
  quality: number,
  paletteQuantization: boolean,
): Promise<Buffer> {
  let pipeline = sharp(inputBuffer).rotate(); // auto-orient from EXIF

  if (width) {
    pipeline = pipeline.resize(width, null, { fit: 'inside', withoutEnlargement: true });
  }

  if (format === 'png') {
    return pipeline.png(stepDownPngOptions(quality, paletteQuantization)).toBuffer();
  }
  return pipeline.jpeg({ quality, mozjpeg: true }).toBuffer();
}

function stepDownPngOptions(quality: number, paletteQuantization: boolean): PngOptions {
  const opts: PngOptions = { compressionLevel: 9, effort: 10 };
  if (quality < 100) {
    opts.quality = quality;
  }
  if (paletteQuantization && quality <= 80) {
    opts.palette = true;
    opts.colors = quality <= 50 ? 128 : 256;
  } else {
    opts.palette = false;
  }
  return opts;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** EXIF orientations 5-8 rotate the image 90/270 degrees, swapping width and height. */
function isSwappedOrientation(orientation: number | undefined): boolean {
  return orientation !== undefined && orientation >= 5 && orientation <= 8;
}

function isAnimatedGif(format: string | undefined, pages: number | undefined): boolean {
  return format === 'gif' && pages !== undefined && pages > 1;
}

/**
 * Explicit override wins. An explicit `'auto'` always detects from the
 * alpha channel. Omitted format defaults to PNG in the exact-width preset
 * (its only original output format) and to alpha-detection otherwise.
 */
function resolveFormat(
  formatOption: 'jpeg' | 'png' | 'auto' | undefined,
  hasAlpha: boolean,
  exactWidthMode: boolean,
): 'jpeg' | 'png' {
  if (formatOption === 'jpeg' || formatOption === 'png') {
    return formatOption;
  }
  if (formatOption === undefined && exactWidthMode) {
    return 'png';
  }
  return hasAlpha ? 'png' : 'jpeg';
}

function isRemoteUrl(src: string): boolean {
  return /^https?:\/\//i.test(src);
}

async function loadInput(input: Buffer | string): Promise<Buffer> {
  if (Buffer.isBuffer(input)) {
    return input;
  }

  if (isRemoteUrl(input)) {
    let response: Response;
    try {
      response = await fetch(input);
    } catch (error) {
      throw new Error(`Failed to fetch "${input}": ${(error as Error).message}`, { cause: error });
    }
    if (!response.ok) {
      throw new Error(`Failed to fetch "${input}": HTTP ${response.status} ${response.statusText}`);
    }
    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }

  try {
    return await fs.readFile(input);
  } catch (error) {
    throw new Error(`Failed to read local file "${input}": ${(error as Error).message}`, { cause: error });
  }
}
