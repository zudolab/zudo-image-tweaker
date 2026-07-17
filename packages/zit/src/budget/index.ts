/**
 * Encode an image so its output stays under a byte-count ceiling, by
 * progressively lowering quality (and, when quality alone isn't enough,
 * width) until the result fits.
 *
 * Two presets cover the two shapes this problem takes in practice:
 *
 * - **Exact-width preset** (`exactWidth` set): the output width is fixed —
 *   smaller sources are upscaled to it, larger ones downscaled — and only
 *   compression quality steps down across a small ladder of rungs matched
 *   to the output format (for PNG, palette quantization engages below the
 *   near-lossless top rung). Useful when a downstream consumer requires an
 *   exact pixel width regardless of size.
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

interface LoadInputOptions {
  fetchTimeoutMs: number;
  maxInputBytes: number;
}

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
  /** Remote-URL inputs only: milliseconds before the fetch is aborted. Defaults to 30000. */
  fetchTimeoutMs?: number;
  /** Remote-URL inputs only: byte cap on the downloaded input. Defaults to 100MB. */
  maxInputBytes?: number;
}

const DEFAULT_MIN_WIDTH = 400;
const DEFAULT_WIDTH_STEP_FACTOR = 0.85;
const DEFAULT_FETCH_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_INPUT_BYTES = 100 * 1024 * 1024;

const JPEG_QUALITY_LADDER = [90, 82, 75, 65, 55, 45, 35];
// sharp only honors PNG `quality` when palette quantization is engaged
// (libimagequant); with `palette: false` it is silently ignored, which made
// non-palette rungs byte-identical no-ops (issue #26). Rungs at or above
// this threshold are the near-lossless attempt (no palette, no quality);
// every rung below quantizes, so its quality value actually takes effect.
const PNG_NEAR_LOSSLESS_QUALITY = 95;
const EXACT_WIDTH_PNG_QUALITY_LADDER = [95, 85, 75, 65, 50];
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
    fetchTimeoutMs = DEFAULT_FETCH_TIMEOUT_MS,
    maxInputBytes = DEFAULT_MAX_INPUT_BYTES,
  } = options;

  const inputBuffer = await loadInput(input, { fetchTimeoutMs, maxInputBytes });
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
      qualityLadder: qualityLadder ?? (format === 'jpeg' ? JPEG_QUALITY_LADDER : EXACT_WIDTH_PNG_QUALITY_LADDER),
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
  const attempted = new Set<string>();

  for (const quality of qualityLadder) {
    const signature = encoderSignature(format, quality, paletteQuantization);
    if (attempted.has(signature)) {
      continue; // this rung resolves to encoder options already tried — a no-op attempt
    }
    attempted.add(signature);

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
    return pipeline.png(pngOptions(quality, paletteQuantization)).toBuffer();
  }
  return pipeline.jpeg({ quality, mozjpeg: true }).toBuffer();
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
    const attempted = new Set<string>();

    for (const quality of qualityLadder) {
      const signature = encoderSignature(format, quality, paletteQuantization);
      if (attempted.has(signature)) {
        continue; // this rung resolves to encoder options already tried at this width — a no-op attempt
      }
      attempted.add(signature);

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
    return pipeline.png(pngOptions(quality, paletteQuantization)).toBuffer();
  }
  return pipeline.jpeg({ quality, mozjpeg: true }).toBuffer();
}

function pngOptions(quality: number, paletteQuantization: boolean): PngOptions {
  const opts: PngOptions = { compressionLevel: 9, effort: 10 };
  if (paletteQuantization && quality < PNG_NEAR_LOSSLESS_QUALITY) {
    opts.palette = true;
    // On the pinned sharp/libvips stack (sharp 0.35.3, vips 8.18.3,
    // imagequant shim 2.4.1) the palette `quality` option is inert, and the
    // colour cap is bucketed by PNG bitdepth — the only effective palette
    // sizes are 256, 16, 4, and 2 (verified empirically). The colour cap is
    // therefore the rung's real lever, mapped from its nominal quality;
    // `quality` is deliberately not passed so rungs resolving to the same
    // colour bucket dedupe as no-op attempts instead of re-encoding.
    opts.colors = quality >= 70 ? 256 : quality >= 45 ? 16 : 4;
    opts.dither = 1.0;
  } else {
    opts.palette = false;
  }
  return opts;
}

/**
 * Canonical fingerprint of the encoder options a rung resolves to, used to
 * skip rungs that cannot change the output (e.g. every non-palette PNG rung
 * encodes identically, since sharp ignores `quality` without a palette).
 */
function encoderSignature(format: 'jpeg' | 'png', quality: number, paletteQuantization: boolean): string {
  if (format === 'png') {
    return JSON.stringify(pngOptions(quality, paletteQuantization));
  }
  return JSON.stringify({ quality });
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

async function loadInput(input: Buffer | string, options: LoadInputOptions): Promise<Buffer> {
  if (Buffer.isBuffer(input)) {
    return input;
  }

  if (isRemoteUrl(input)) {
    return loadRemote(input, options);
  }

  try {
    return await fs.readFile(input);
  } catch (error) {
    throw new Error(`Failed to read local file "${input}": ${(error as Error).message}`, { cause: error });
  }
}

/**
 * Fetch a remote input with a wall-clock timeout and a downloaded-bytes cap
 * (issue #62) — remote URLs may be user-influenced, so an unbounded fetch is
 * a memory/hang DoS vector. Node built-ins only: AbortController covers both
 * the headers and the body download, and the body is streamed chunk by chunk
 * so an over-cap response is aborted without ever being fully buffered.
 */
async function loadRemote(url: string, { fetchTimeoutMs, maxInputBytes }: LoadInputOptions): Promise<Buffer> {
  const controller = new AbortController();
  const timeoutError = new Error(`Failed to fetch "${url}": timed out after ${fetchTimeoutMs}ms`);
  const timer = setTimeout(() => controller.abort(timeoutError), fetchTimeoutMs);

  const rethrowMapped = (error: unknown): never => {
    if (controller.signal.reason === timeoutError) {
      throw timeoutError;
    }
    if (error instanceof Error && error.message.includes('exceeds the maximum input size')) {
      throw error;
    }
    throw new Error(`Failed to fetch "${url}": ${(error as Error).message}`, { cause: error });
  };

  try {
    let response: Response;
    try {
      response = await fetch(url, { signal: controller.signal });
    } catch (error) {
      rethrowMapped(error);
      throw error; // unreachable — rethrowMapped always throws
    }
    if (!response.ok) {
      controller.abort(); // don't leave the error-response body downloading
      throw new Error(`Failed to fetch "${url}": HTTP ${response.status} ${response.statusText}`);
    }

    const declaredLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(declaredLength) && declaredLength > maxInputBytes) {
      controller.abort();
      throw new Error(
        `Remote input "${url}" declares ${declaredLength} bytes, which exceeds the maximum input size of ${maxInputBytes} bytes`,
      );
    }

    if (!response.body) {
      return Buffer.alloc(0);
    }

    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    try {
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        totalBytes += chunk.byteLength;
        if (totalBytes > maxInputBytes) {
          controller.abort();
          throw new Error(
            `Remote input "${url}" exceeds the maximum input size of ${maxInputBytes} bytes (aborted after ${totalBytes} bytes)`,
          );
        }
        chunks.push(chunk);
      }
    } catch (error) {
      rethrowMapped(error);
    }
    return Buffer.concat(chunks);
  } finally {
    clearTimeout(timer);
  }
}
