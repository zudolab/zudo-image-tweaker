import { randomUUID } from 'node:crypto';
import { rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

/** File path or in-memory buffer accepted as the compositor's source image. */
export type OgpInput = string | Buffer;

export interface OgpBaseOptions {
  /** Output canvas width. Default 1200. */
  width?: number;
  /** Output canvas height. Default 630. */
  height?: number;
  /** JPEG quality (1-100). Default 85. */
  quality?: number;
  /** Progressive JPEG encoding. Default true. */
  progressive?: boolean;
  /** When set, also writes the result to this path; the result then carries `path`. */
  outPath?: string;
}

export interface OgpImageOptions extends OgpBaseOptions {
  /** Size of the centered square card. Default 600. */
  foregroundSize?: number;
  /** Corner radius applied to the card via an SVG mask. 0 (default) skips masking. */
  cornerRadius?: number;
  /** Gaussian blur sigma for the background. Default 45. */
  blurSigma?: number;
  /** Background desaturation, 0-1. Default 0.1. */
  desaturate?: number;
  /** Top gradient darkness, 0-1. Default 0.3. */
  topGradientOpacity?: number;
  /** Bottom gradient darkness, 0-1. Default 0.2. */
  bottomGradientOpacity?: number;
  /** Fraction of canvas height covered by the top gradient. Default 0.25. */
  gradientTopHeight?: number;
  /** Fraction of canvas height covered by the bottom gradient. Default 0.25. */
  gradientBottomHeight?: number;
  /** Drop shadow opacity, 0-1. Default 0.25. */
  shadowOpacity?: number;
  /** Drop shadow blur radius. Default 24. */
  shadowBlur?: number;
  /** Vertical drop shadow offset. Default 8. */
  shadowOffsetY?: number;
}

export type OgpFromLandscapeOptions = OgpBaseOptions;

export interface SmartOgpOptions extends OgpImageOptions {
  /** Aspect ratio (width / height) at or above which the landscape branch is used. Default 1.5. */
  landscapeThreshold?: number;
}

export interface OgpResult {
  buffer: Buffer;
  width: number;
  height: number;
  format: 'jpeg';
  /** Present only when `outPath` was passed. */
  path?: string;
}

export interface SmartOgpResult extends OgpResult {
  /** Which dispatch branch produced this result. */
  method: 'landscape' | 'composite';
}

const DEFAULT_WIDTH = 1200;
const DEFAULT_HEIGHT = 630;
const DEFAULT_FOREGROUND_SIZE = 600;
const DEFAULT_CORNER_RADIUS = 0;
const DEFAULT_BLUR_SIGMA = 45;
const DEFAULT_DESATURATE = 0.1;
const DEFAULT_TOP_GRADIENT_OPACITY = 0.3;
const DEFAULT_BOTTOM_GRADIENT_OPACITY = 0.2;
const DEFAULT_GRADIENT_TOP_HEIGHT = 0.25;
const DEFAULT_GRADIENT_BOTTOM_HEIGHT = 0.25;
const DEFAULT_SHADOW_OPACITY = 0.25;
const DEFAULT_SHADOW_BLUR = 24;
const DEFAULT_SHADOW_OFFSET_Y = 8;
const DEFAULT_QUALITY = 85;
const DEFAULT_PROGRESSIVE = true;
const DEFAULT_LANDSCAPE_THRESHOLD = 1.5;

interface GradientParams {
  topGradientOpacity: number;
  bottomGradientOpacity: number;
  gradientTopHeight: number;
  gradientBottomHeight: number;
}

async function createGradientOverlay(
  width: number,
  height: number,
  params: GradientParams,
): Promise<Buffer> {
  const { topGradientOpacity, bottomGradientOpacity, gradientTopHeight, gradientBottomHeight } =
    params;
  const topGradientEnd = Math.round(height * gradientTopHeight);
  const bottomGradientStart = Math.round(height * (1 - gradientBottomHeight));

  const svg = `
    <svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="topGradient" x1="0%" y1="0%" x2="0%" y2="100%">
          <stop offset="0%" style="stop-color:black;stop-opacity:${topGradientOpacity}" />
          <stop offset="100%" style="stop-color:black;stop-opacity:0" />
        </linearGradient>
        <linearGradient id="bottomGradient" x1="0%" y1="0%" x2="0%" y2="100%">
          <stop offset="0%" style="stop-color:black;stop-opacity:0" />
          <stop offset="100%" style="stop-color:black;stop-opacity:${bottomGradientOpacity}" />
        </linearGradient>
      </defs>
      <rect x="0" y="0" width="${width}" height="${topGradientEnd}" fill="url(#topGradient)" />
      <rect x="0" y="${bottomGradientStart}" width="${width}" height="${height - bottomGradientStart}" fill="url(#bottomGradient)" />
    </svg>
  `;

  return sharp(Buffer.from(svg)).png().toBuffer();
}

interface ShadowParams {
  shadowBlur: number;
  shadowOpacity: number;
  cornerRadius: number;
  shadowOffsetY: number;
}

async function createDropShadow(
  width: number,
  height: number,
  cardSize: number,
  params: ShadowParams,
): Promise<Buffer> {
  const { shadowBlur, shadowOpacity, cornerRadius, shadowOffsetY } = params;
  const cardX = Math.round((width - cardSize) / 2);
  const cardY = Math.round((height - cardSize) / 2) + shadowOffsetY;

  const svg = `
    <svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <filter id="blur" x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur in="SourceGraphic" stdDeviation="${shadowBlur}" />
        </filter>
      </defs>
      <rect
        x="${cardX}"
        y="${cardY}"
        width="${cardSize}"
        height="${cardSize}"
        rx="${cornerRadius}"
        ry="${cornerRadius}"
        fill="black"
        opacity="${shadowOpacity}"
        filter="url(#blur)"
      />
    </svg>
  `;

  return sharp(Buffer.from(svg)).png().toBuffer();
}

async function createRoundedMask(size: number, radius: number): Promise<Buffer> {
  const svg = `
    <svg width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg">
      <rect x="0" y="0" width="${size}" height="${size}" rx="${radius}" ry="${radius}" fill="white" />
    </svg>
  `;

  return sharp(Buffer.from(svg)).png().toBuffer();
}

async function finalizeResult(
  buffer: Buffer,
  fallbackWidth: number,
  fallbackHeight: number,
  outPath: string | undefined,
): Promise<OgpResult> {
  const metadata = await sharp(buffer).metadata();
  const result: OgpResult = {
    buffer,
    width: metadata.width ?? fallbackWidth,
    height: metadata.height ?? fallbackHeight,
    format: 'jpeg',
  };

  if (outPath) {
    // Atomic write: stage in a sibling temp file, then rename(2) over the
    // target so a crash mid-write never leaves a truncated OGP image at the
    // final path (which the variants engine's cache would treat as a hit).
    const tmpPath = path.join(
      path.dirname(outPath),
      `.${path.basename(outPath)}.${randomUUID()}.tmp`,
    );
    try {
      await writeFile(tmpPath, buffer);
      await rename(tmpPath, outPath);
    } catch (error) {
      await rm(tmpPath, { force: true });
      throw error;
    }
    result.path = outPath;
  }

  return result;
}

/**
 * Composite a blurred, desaturated cover-crop background with gradient
 * overlays, a drop shadow, and a centered square card (optionally
 * rounded-corner masked). Best suited to square/portrait sources.
 */
export async function generateOgpImage(
  input: OgpInput,
  opts: OgpImageOptions = {},
): Promise<OgpResult> {
  const width = opts.width ?? DEFAULT_WIDTH;
  const height = opts.height ?? DEFAULT_HEIGHT;
  // Cap the default so the card never exceeds a caller-shrunk canvas — sharp
  // rejects a composite layer larger than its base image.
  const foregroundSize = opts.foregroundSize ?? Math.min(DEFAULT_FOREGROUND_SIZE, width, height);
  const canvasLimit = Math.min(width, height);
  if (foregroundSize > canvasLimit) {
    throw new Error(
      `foregroundSize (${foregroundSize}) exceeds the canvas limit of ${canvasLimit}px ` +
        `(the smaller of width=${width} and height=${height}); the composite card ` +
        'cannot be larger than the canvas it is centered on.',
    );
  }
  const cornerRadius = opts.cornerRadius ?? DEFAULT_CORNER_RADIUS;
  const blurSigma = opts.blurSigma ?? DEFAULT_BLUR_SIGMA;
  const desaturate = opts.desaturate ?? DEFAULT_DESATURATE;
  const quality = opts.quality ?? DEFAULT_QUALITY;
  const progressive = opts.progressive ?? DEFAULT_PROGRESSIVE;
  const gradientParams: GradientParams = {
    topGradientOpacity: opts.topGradientOpacity ?? DEFAULT_TOP_GRADIENT_OPACITY,
    bottomGradientOpacity: opts.bottomGradientOpacity ?? DEFAULT_BOTTOM_GRADIENT_OPACITY,
    gradientTopHeight: opts.gradientTopHeight ?? DEFAULT_GRADIENT_TOP_HEIGHT,
    gradientBottomHeight: opts.gradientBottomHeight ?? DEFAULT_GRADIENT_BOTTOM_HEIGHT,
  };
  const shadowParams: ShadowParams = {
    shadowBlur: opts.shadowBlur ?? DEFAULT_SHADOW_BLUR,
    shadowOpacity: opts.shadowOpacity ?? DEFAULT_SHADOW_OPACITY,
    cornerRadius,
    shadowOffsetY: opts.shadowOffsetY ?? DEFAULT_SHADOW_OFFSET_Y,
  };

  // Colour management (issue #71): both `sharp(input)` decodes below rely
  // on sharp 0.35.3's default behaviour of honouring the source's embedded
  // ICC profile — pixels are genuinely converted to sRGB and the profile is
  // dropped, so a Display-P3 photo composites and renders correctly as an
  // untagged sRGB JPEG (verified pixel-level on a P3 fixture). Do NOT add
  // `keepIccProfile()` to any stage here: on the final `.composite()` stage
  // it re-tags the already-sRGB-converted card pixels with the source
  // profile, which mis-renders (also verified).

  // 1. Blurred, desaturated cover-crop background.
  const background = await sharp(input)
    .rotate() // Auto-rotate based on EXIF orientation.
    .resize(width, height, { fit: 'cover', position: 'center' })
    .blur(blurSigma)
    .modulate({ saturation: 1 - desaturate })
    .jpeg({ quality: 100 })
    .toBuffer();

  // 2. Top/bottom gradient overlay and drop shadow, both full-canvas SVG layers.
  const [gradientOverlay, shadowBuffer] = await Promise.all([
    createGradientOverlay(width, height, gradientParams),
    createDropShadow(width, height, foregroundSize, shadowParams),
  ]);

  // 3. Centered square foreground card, cover-cropped to `foregroundSize`,
  // optionally rounded-corner masked.
  const foregroundBuffer = await sharp(input)
    .rotate() // Auto-rotate based on EXIF orientation.
    .resize(foregroundSize, foregroundSize, { fit: 'cover', position: 'center' })
    .png()
    .toBuffer();

  const foreground =
    cornerRadius > 0
      ? await sharp(foregroundBuffer)
          .composite([
            { input: await createRoundedMask(foregroundSize, cornerRadius), blend: 'dest-in' },
          ])
          .png()
          .toBuffer()
      : foregroundBuffer;

  // 4. Composite background + gradient + shadow + foreground card.
  const foregroundLeft = Math.round((width - foregroundSize) / 2);
  const foregroundTop = Math.round((height - foregroundSize) / 2);

  const buffer = await sharp(background)
    .composite([
      { input: gradientOverlay, blend: 'over' },
      { input: shadowBuffer, blend: 'over' },
      { input: foreground, left: foregroundLeft, top: foregroundTop },
    ])
    .jpeg({ quality, progressive, mozjpeg: true })
    .toBuffer();

  return finalizeResult(buffer, width, height, opts.outPath);
}

/**
 * Simple cover-crop to the target canvas, no compositing. Best suited to
 * already-landscape sources where a blurred-background card would waste
 * detail.
 */
export async function generateOgpFromLandscape(
  input: OgpInput,
  opts: OgpFromLandscapeOptions = {},
): Promise<OgpResult> {
  const width = opts.width ?? DEFAULT_WIDTH;
  const height = opts.height ?? DEFAULT_HEIGHT;
  const quality = opts.quality ?? DEFAULT_QUALITY;
  const progressive = opts.progressive ?? DEFAULT_PROGRESSIVE;

  // Colour management (issue #71): like generateOgpImage, this relies on
  // sharp's default input-profile handling — a Display-P3 source is
  // genuinely converted to sRGB and emitted untagged, which renders
  // correctly everywhere (verified pixel-level on a P3 fixture). Both OGP
  // branches deliberately emit plain sRGB: social-card scrapers are the
  // consumer, and untagged sRGB is the most robust encoding for them.
  const buffer = await sharp(input)
    .rotate() // Auto-rotate based on EXIF orientation.
    .resize(width, height, { fit: 'cover', position: 'center' })
    .jpeg({ quality, progressive, mozjpeg: true })
    .toBuffer();

  return finalizeResult(buffer, width, height, opts.outPath);
}

/**
 * Dispatches to {@link generateOgpFromLandscape} or {@link generateOgpImage}
 * based on the source's aspect ratio.
 */
export async function generateSmartOgp(
  input: OgpInput,
  opts: SmartOgpOptions = {},
): Promise<SmartOgpResult> {
  const { landscapeThreshold = DEFAULT_LANDSCAPE_THRESHOLD, ...rest } = opts;

  const metadata = await sharp(input).metadata();
  // EXIF orientations 5-8 rotate the displayed image 90deg from the stored
  // pixel matrix; dispatch on the displayed (auto-oriented) dimensions.
  const dispatchWidth = metadata.autoOrient?.width ?? metadata.width ?? 1;
  const dispatchHeight = metadata.autoOrient?.height ?? metadata.height ?? 1;
  const aspectRatio = dispatchWidth / dispatchHeight;

  if (aspectRatio >= landscapeThreshold) {
    const result = await generateOgpFromLandscape(input, rest);
    return { ...result, method: 'landscape' };
  }

  const result = await generateOgpImage(input, rest);
  return { ...result, method: 'composite' };
}
