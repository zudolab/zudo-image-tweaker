/**
 * Background-color calibration: sample the background color from an
 * image's four corners, derive a target color by averaging that sample
 * across a set of reference images, and normalize a new image's
 * background toward that target.
 *
 * Correction is selective: each pixel is blended toward its target-scaled
 * value by a weight built from a saturation-gate ramp times a circular
 * hue-distance falloff around the *sampled* background hue (not the
 * target hue), so neutrals, grays, and dark pixels are left untouched
 * while only background-colored pixels move. When the sampled background
 * is itself achromatic (its saturation falls below `saturationGate.from`)
 * there is no coherent hue to match against, so every pixel gets zero
 * weight rather than being compared to a meaningless hue reading of 0.
 *
 * EXIF orientation is applied before any pixel is read or written (via
 * sharp's `.rotate()` with no arguments) — camera photos with a
 * non-default orientation tag are sampled and corrected in their
 * upright, displayed orientation, not their as-stored one.
 *
 * HEIC/HEIF decoding is feature-detected via macOS `sips` (invoked with
 * `execFile` argument arrays, never a shell string) because this module
 * carries no Node-native HEIC decoder. `sampleBackgroundColor` and
 * `normalizeBackgroundColor` throw a descriptive error for `.heic`/`.heif`
 * input on any platform where `sips` is unavailable (Linux, Windows) —
 * pre-convert such inputs to JPEG/PNG (e.g. via the sibling `/heif`
 * module, which does carry a Node-native fallback) before calling into
 * this module. Buffer input bypasses HEIC handling entirely; only a
 * string path is checked for a `.heic`/`.heif` extension. A `sips` failure
 * for any reason other than being absent (e.g. an HDR "gain map" HEIC
 * whose auxiliary-image references exceed the system libheif's limit —
 * see `/heif`'s module doc for the full explanation) is rethrown wrapped
 * with the same pre-convert-via-`/heif` guidance (issue #34).
 *
 * ICC profile (issue #35): `normalizeBackgroundColor` samples and corrects
 * pixels via a raw decode, which yields the source's literal device-space
 * sample values without any colour-space conversion (verified empirically:
 * a Display-P3-tagged source's raw pixels are numerically unchanged from
 * its stored bytes). All arithmetic — sampling, target-ratio scaling,
 * hue/saturation gating — therefore stays self-consistent in that same
 * device space throughout. To avoid re-interpreting those device-space
 * values as sRGB (which would shift the rendered colour for any
 * wide-gamut source), the source's ICC profile, if present, is re-attached
 * byte-identically to the output via `sharp#withIccProfile` pointed at a
 * temp file holding the extracted profile bytes — this only tags the
 * output, it does not run a colour transform, because the pipeline is
 * built from a raw pixel buffer with no profile of its own to transform
 * from (see the `withIccProfile` call site below for the same reasoning
 * `/heif` documents for its APP2 splice). EXIF and all other metadata are
 * always dropped: the raw-buffer re-encode carries no EXIF forward and
 * this module never re-attaches any (unlike ICC, which is deliberately
 * restored) — there is no `stripMetadata`-style opt-out.
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import sharp from 'sharp';

const execFileAsync = promisify(execFile);

const DEFAULT_PATCH_SIZE = 50;
const PATCH_MARGIN = 5;
const DEFAULT_HUE_RADIUS_DEG = 60;
const DEFAULT_SATURATION_GATE: SaturationGate = { from: 0.08, to: 0.25 };
const DEFAULT_CHANNEL_CLAMP: [number, number] = [0.5, 2.0];
// Pixels whose brightest channel is below this are treated as too dark to
// carry reliable hue information and are always left untouched.
const DARK_PIXEL_FLOOR = 30;

export interface RgbColor {
  r: number;
  g: number;
  b: number;
}

export interface SaturationGate {
  /** Saturation (0-1) below which a pixel is treated as neutral. */
  from: number;
  /** Saturation (0-1) at and above which a pixel gets full correction weight. */
  to: number;
}

export interface SampleBackgroundColorOptions {
  /** Size (px) of each square corner patch sampled. @default 50 */
  patchSize?: number;
}

export interface NormalizeBackgroundColorOptions {
  /** Color to move the sampled background toward. */
  target: RgbColor;
  /** Size (px) of each corner patch used to sample the current background. @default 50 */
  patchSize?: number;
  /** Hue-distance falloff radius, in degrees, around the sampled background hue. @default 60 */
  hueRadiusDeg?: number;
  /** Saturation ramp gating which pixels are eligible for correction. @default { from: 0.08, to: 0.25 } */
  saturationGate?: SaturationGate;
  /** Per-channel scale-factor clamp [min, max] applied to target/current ratios. @default [0.5, 2.0] */
  channelClamp?: [number, number];
  /** Output encoding. Inferred from `input`'s extension when it's a path (default jpeg); defaults to jpeg for Buffer input. */
  format?: 'jpeg' | 'png' | 'webp' | 'tiff';
}

export interface NormalizeBackgroundColorResult {
  buffer: Buffer;
  applied: {
    scaleR: number;
    scaleG: number;
    scaleB: number;
  };
}

function isHeicPath(input: string): boolean {
  return /\.hei[cf]$/i.test(input);
}

/**
 * Convert a HEIC/HEIF file to a temporary JPEG via macOS `sips`, feature-
 * detected through `execFile`'s ENOENT (never a shell string). Returns
 * null when `sips` isn't present so the caller can surface a clear
 * capability-loss error; any other `sips` failure (e.g. a genuinely
 * corrupt file) is rethrown unchanged.
 */
async function tryHeicToTempJpeg(heicPath: string): Promise<string | null> {
  const tempPath = path.join(
    os.tmpdir(),
    `zit-calibrate-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.jpg`,
  );
  try {
    // Argument order matches the sibling /heif module (see heif/index.ts):
    // all `-s` options first, then the input file, then `--out` last — the
    // order documented in `man sips` (`sips [options] file... --out outfile`).
    await execFileAsync('sips', [
      '-s',
      'format',
      'jpeg',
      '-s',
      'formatOptions',
      '95',
      heicPath,
      '--out',
      tempPath,
    ]);
  } catch (error) {
    // A non-zero `sips` exit can still leave a partial `tempPath` on disk
    // (e.g. the gain-map failure documented below) — force-remove it here,
    // mirroring the sibling /heif module's tryConvertWithSips, so a
    // failed conversion never leaks a temp JPEG (issue #34).
    await fs.rm(tempPath, { force: true });
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw new Error(
      `HEIC/HEIF conversion via 'sips' failed for '${heicPath}': ${(error as Error).message}. ` +
        "This can happen with HDR \"gain map\" HEIC files, which the system libheif that " +
        '`sips` relies on may reject via a strict auxiliary-image-reference limit. ' +
        "Pre-convert '" +
        heicPath +
        "' via the sibling /heif module (whose Node fallback does not carry that limit) " +
        'before calling this function.',
      { cause: error },
    );
  }
  return tempPath;
}

interface DecodeSource {
  sharpInput: string | Buffer;
  cleanup: () => Promise<void>;
}

/**
 * Resolve an `input` into something sharp can decode directly. HEIC/HEIF
 * string paths are routed through `sips` first; every other input (any
 * Buffer, or a non-HEIC path) passes through unchanged.
 */
async function resolveDecodeSource(input: string | Buffer): Promise<DecodeSource> {
  if (typeof input === 'string' && isHeicPath(input)) {
    const tempPath = await tryHeicToTempJpeg(input);
    if (!tempPath) {
      throw new Error(
        `HEIC/HEIF decoding requires macOS 'sips', which is unavailable on this platform. ` +
          `Pre-convert '${input}' to JPEG/PNG (e.g. via the sibling /heif module) before ` +
          'calling this function.',
      );
    }
    return { sharpInput: tempPath, cleanup: () => fs.rm(tempPath, { force: true }) };
  }
  return { sharpInput: input, cleanup: async () => {} };
}

/**
 * Width/height as they'll appear once EXIF orientation is auto-applied via
 * `.rotate()`. `sharp(...).metadata()` reports the as-stored dimensions
 * (pre-rotation), so orientation values 5-8 (which involve a 90deg turn)
 * need their width/height swapped to match what corner-patch extraction
 * will actually see once `.rotate()` runs.
 */
async function orientedDimensions(
  sharpInput: string | Buffer,
): Promise<{ width: number; height: number }> {
  const { width = 0, height = 0, orientation } = await sharp(sharpInput).metadata();
  const swapped = orientation !== undefined && orientation >= 5 && orientation <= 8;
  return swapped ? { width: height, height: width } : { width, height };
}

function averageRgbOfPatch(buffer: Buffer): RgbColor {
  let r = 0;
  let g = 0;
  let b = 0;
  const pixelCount = buffer.length / 3;
  for (let i = 0; i < buffer.length; i += 3) {
    r += buffer[i];
    g += buffer[i + 1];
    b += buffer[i + 2];
  }
  return {
    r: Math.round(r / pixelCount),
    g: Math.round(g / pixelCount),
    b: Math.round(b / pixelCount),
  };
}

function averageRgbColors(colors: RgbColor[]): RgbColor {
  const len = colors.length;
  return {
    r: Math.round(colors.reduce((sum, c) => sum + c.r, 0) / len),
    g: Math.round(colors.reduce((sum, c) => sum + c.g, 0) / len),
    b: Math.round(colors.reduce((sum, c) => sum + c.b, 0) / len),
  };
}

/**
 * Sample the background color of an image by averaging four square
 * patches, one from each corner (with a small margin so patches don't
 * touch the exact edge).
 */
export async function sampleBackgroundColor(
  input: string | Buffer,
  opts: SampleBackgroundColorOptions = {},
): Promise<RgbColor> {
  const patchSize = opts.patchSize ?? DEFAULT_PATCH_SIZE;
  const minDimension = patchSize + PATCH_MARGIN * 2;

  const { sharpInput, cleanup } = await resolveDecodeSource(input);
  try {
    const { width, height } = await orientedDimensions(sharpInput);
    if (!width || !height || width < minDimension || height < minDimension) {
      throw new Error(
        `Image too small (${width ?? 0}x${height ?? 0}). Minimum ${minDimension}x${minDimension} required.`,
      );
    }

    const corners = [
      { left: PATCH_MARGIN, top: PATCH_MARGIN },
      { left: width - patchSize - PATCH_MARGIN, top: PATCH_MARGIN },
      { left: PATCH_MARGIN, top: height - patchSize - PATCH_MARGIN },
      { left: width - patchSize - PATCH_MARGIN, top: height - patchSize - PATCH_MARGIN },
    ];

    const samples: RgbColor[] = [];
    for (const corner of corners) {
      const { data } = await sharp(sharpInput)
        .rotate()
        .extract({ left: corner.left, top: corner.top, width: patchSize, height: patchSize })
        .removeAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      samples.push(averageRgbOfPatch(data));
    }

    return averageRgbColors(samples);
  } finally {
    await cleanup();
  }
}

/**
 * Derive a target background color by sampling each reference image's
 * background (see {@link sampleBackgroundColor}) and averaging the
 * results.
 */
export async function calibrateTargetFromSamples(
  inputs: Array<string | Buffer>,
  opts: SampleBackgroundColorOptions = {},
): Promise<RgbColor> {
  if (inputs.length === 0) {
    throw new Error('calibrateTargetFromSamples requires at least one reference image.');
  }
  const samples = await Promise.all(inputs.map((input) => sampleBackgroundColor(input, opts)));
  return averageRgbColors(samples);
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function clamp255(value: number): number {
  return value < 0 ? 0 : value > 255 ? 255 : Math.round(value);
}

function hueOf(r: number, g: number, b: number): number {
  const mx = Math.max(r, g, b);
  const mn = Math.min(r, g, b);
  const d = mx - mn;
  if (d === 0) return 0;
  let h: number;
  if (mx === r) h = ((g - b) / d) % 6;
  else if (mx === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  h *= 60;
  if (h < 0) h += 360;
  return h;
}

function saturationOf(r: number, g: number, b: number): number {
  const maxC = Math.max(r, g, b);
  const minC = Math.min(r, g, b);
  return maxC === 0 ? 0 : (maxC - minC) / maxC;
}

/**
 * Weight (0-1) for how much a pixel should move toward its target-scaled
 * value: a saturation-gate ramp (0 below `saturationGate.from`, 1 at and
 * above `saturationGate.to`) times a circular hue-distance falloff around
 * `refHue` (full weight at 0deg away, fading to 0 at `hueRadiusDeg`).
 * Very dark pixels (max channel below {@link DARK_PIXEL_FLOOR}) always get
 * zero weight — they carry no reliable hue information. Likewise, when the
 * reference itself is achromatic (`refSat` below `saturationGate.from`),
 * every pixel gets zero weight: an achromatic reference has no meaningful
 * hue to match against, and without this gate `hueOf` would report a
 * degenerate hue of 0 (red) for it, causing unrelated saturated red
 * content elsewhere in the image to be "corrected" instead.
 */
function computeCorrectionWeight(
  r: number,
  g: number,
  b: number,
  refHue: number,
  refSat: number,
  hueRadiusDeg: number,
  saturationGate: SaturationGate,
): number {
  const maxC = Math.max(r, g, b);

  if (maxC < DARK_PIXEL_FLOOR) return 0;
  if (refSat < saturationGate.from) return 0;

  const sat = saturationOf(r, g, b);
  if (sat < saturationGate.from) return 0;

  const pixelHue = hueOf(r, g, b);
  let hueDiff = Math.abs(pixelHue - refHue);
  if (hueDiff > 180) hueDiff = 360 - hueDiff;

  const hueWeight = hueDiff < hueRadiusDeg ? 1 - hueDiff / hueRadiusDeg : 0;

  const gateSpan = saturationGate.to - saturationGate.from;
  const satWeight =
    gateSpan > 0
      ? clampNumber((sat - saturationGate.from) / gateSpan, 0, 1)
      : sat >= saturationGate.from
        ? 1
        : 0;

  return satWeight * hueWeight;
}

function inferFormat(input: string | Buffer): 'jpeg' | 'png' | 'webp' | 'tiff' {
  if (typeof input !== 'string') return 'jpeg';
  const ext = path.extname(input).toLowerCase();
  if (ext === '.png') return 'png';
  if (ext === '.webp') return 'webp';
  if (ext === '.tiff' || ext === '.tif') return 'tiff';
  return 'jpeg';
}

type SharpPipeline = ReturnType<typeof sharp>;

function applyFormat(pipeline: SharpPipeline, format: 'jpeg' | 'png' | 'webp' | 'tiff'): SharpPipeline {
  switch (format) {
    case 'png':
      return pipeline.png();
    case 'webp':
      return pipeline.webp({ quality: 95 });
    case 'tiff':
      return pipeline.tiff({ quality: 95 });
    default:
      return pipeline.jpeg({ quality: 95 });
  }
}

/**
 * Average the RGB of a square patch cut directly out of an already-decoded
 * raw pixel buffer (row-major, `channels`-interleaved). Used to sample the
 * background from the single full-image decode `normalizeBackgroundColor`
 * already performs, instead of re-decoding four corner extracts (issue #50).
 */
function averageRgbOfRawPatch(
  pixels: Buffer,
  imageWidth: number,
  channels: number,
  left: number,
  top: number,
  size: number,
): RgbColor {
  let r = 0;
  let g = 0;
  let b = 0;
  for (let y = 0; y < size; y++) {
    let rowStart = ((top + y) * imageWidth + left) * channels;
    for (let x = 0; x < size; x++) {
      r += pixels[rowStart];
      g += pixels[rowStart + 1];
      b += pixels[rowStart + 2];
      rowStart += channels;
    }
  }
  const pixelCount = size * size;
  return {
    r: Math.round(r / pixelCount),
    g: Math.round(g / pixelCount),
    b: Math.round(b / pixelCount),
  };
}

/**
 * Sample the background color of an already-decoded raw pixel buffer by
 * averaging its four corner patches — the same four-corner strategy as
 * {@link sampleBackgroundColor}, applied in-memory rather than via a fresh
 * decode.
 */
function sampleBackgroundFromRawBuffer(
  pixels: Buffer,
  imageWidth: number,
  imageHeight: number,
  channels: number,
  patchSize: number,
): RgbColor {
  const corners = [
    { left: PATCH_MARGIN, top: PATCH_MARGIN },
    { left: imageWidth - patchSize - PATCH_MARGIN, top: PATCH_MARGIN },
    { left: PATCH_MARGIN, top: imageHeight - patchSize - PATCH_MARGIN },
    { left: imageWidth - patchSize - PATCH_MARGIN, top: imageHeight - patchSize - PATCH_MARGIN },
  ];
  return averageRgbColors(
    corners.map((corner) => averageRgbOfRawPatch(pixels, imageWidth, channels, corner.left, corner.top, patchSize)),
  );
}

/**
 * Normalize an image's background color toward `opts.target`. The image is
 * converted (if HEIC/HEIF) and decoded to raw pixels exactly once; the
 * current background is sampled directly from that raw buffer (see
 * {@link sampleBackgroundFromRawBuffer}) rather than via a second decode.
 * Each channel's target/current ratio becomes that channel's scale factor,
 * clamped to `opts.channelClamp`. Per pixel, the scaled value is blended
 * in proportional to {@link computeCorrectionWeight}, so only pixels close
 * in hue to the *sampled* background — and saturated enough to carry that
 * hue reliably — move; neutrals and dark pixels are returned unchanged.
 *
 * ICC: the source's ICC profile, if present, is re-attached byte-identically
 * to the output (see the module doc comment for why re-attaching rather
 * than transforming is correct here). EXIF and all other metadata are
 * always dropped — see the module doc comment's "EXIF" note.
 */
export async function normalizeBackgroundColor(
  input: string | Buffer,
  opts: NormalizeBackgroundColorOptions,
): Promise<NormalizeBackgroundColorResult> {
  const {
    target,
    patchSize = DEFAULT_PATCH_SIZE,
    hueRadiusDeg = DEFAULT_HUE_RADIUS_DEG,
    saturationGate = DEFAULT_SATURATION_GATE,
    channelClamp = DEFAULT_CHANNEL_CLAMP,
    format,
  } = opts;
  const minDimension = patchSize + PATCH_MARGIN * 2;

  const { sharpInput, cleanup } = await resolveDecodeSource(input);
  let iccTempPath: string | null = null;
  try {
    const { hasAlpha, icc } = await sharp(sharpInput).metadata();
    const alphaAwarePipeline = sharp(sharpInput).rotate();
    const { data, info } = await (hasAlpha
      ? alphaAwarePipeline.ensureAlpha()
      : alphaAwarePipeline.removeAlpha()
    )
      .raw()
      .toBuffer({ resolveWithObject: true });

    const channels = info.channels;
    const pixels = Buffer.from(data);

    if (
      !info.width ||
      !info.height ||
      info.width < minDimension ||
      info.height < minDimension
    ) {
      throw new Error(
        `Image too small (${info.width ?? 0}x${info.height ?? 0}). Minimum ${minDimension}x${minDimension} required.`,
      );
    }

    const currentBg = sampleBackgroundFromRawBuffer(pixels, info.width, info.height, channels, patchSize);

    const [clampMin, clampMax] = channelClamp;
    const safeScale = (targetChannel: number, currentChannel: number) =>
      currentChannel === 0 ? 1 : clampNumber(targetChannel / currentChannel, clampMin, clampMax);

    const scaleR = safeScale(target.r, currentBg.r);
    const scaleG = safeScale(target.g, currentBg.g);
    const scaleB = safeScale(target.b, currentBg.b);

    const refHue = hueOf(currentBg.r, currentBg.g, currentBg.b);
    const refSat = saturationOf(currentBg.r, currentBg.g, currentBg.b);

    for (let i = 0; i < pixels.length; i += channels) {
      const r = pixels[i];
      const g = pixels[i + 1];
      const b = pixels[i + 2];

      const weight = computeCorrectionWeight(r, g, b, refHue, refSat, hueRadiusDeg, saturationGate);

      if (weight > 0.01) {
        pixels[i] = clamp255(r + weight * (r * scaleR - r));
        pixels[i + 1] = clamp255(g + weight * (g * scaleG - g));
        pixels[i + 2] = clamp255(b + weight * (b * scaleB - b));
      }
      // Alpha (pixels[i + 3], when channels === 4) is never touched — only
      // color channels are corrected, transparency passes through as-is.
    }

    let pipeline: SharpPipeline = sharp(pixels, { raw: { width: info.width, height: info.height, channels } });
    if (icc) {
      // withIccProfile only accepts a filesystem path (or a built-in name),
      // so the extracted profile bytes are spilled to a temp file. Since
      // `pipeline` was built from a raw buffer with no profile of its own,
      // this only tags the output — it does not run a colour transform
      // (verified empirically; see the module doc comment).
      iccTempPath = path.join(
        os.tmpdir(),
        `zit-calibrate-icc-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.icc`,
      );
      await fs.writeFile(iccTempPath, icc);
      pipeline = pipeline.withIccProfile(iccTempPath);
    }
    pipeline = applyFormat(pipeline, format ?? inferFormat(input));

    const buffer = await pipeline.toBuffer();
    return { buffer, applied: { scaleR, scaleG, scaleB } };
  } finally {
    if (iccTempPath) await fs.rm(iccTempPath, { force: true });
    await cleanup();
  }
}
