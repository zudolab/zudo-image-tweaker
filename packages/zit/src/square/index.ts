import sharp, { type Sharp, type Color } from 'sharp';

const DEFAULT_BACKGROUND: Color = { r: 255, g: 255, b: 255, alpha: 1 };

export interface SquareResult {
  buffer: Buffer;
  width: number;
  height: number;
}

export type SquareAnchor = 'top' | 'center' | 'bottom';

export interface CropToSquareOptions {
  /**
   * Which part of the image to keep.
   * For PORTRAIT images (h > w): top=keep top rows, bottom=keep bottom rows.
   * For LANDSCAPE images (w > h): top=keep left columns, bottom=keep right columns
   * (the anchor names refer to the crop axis edge, not an absolute screen position).
   */
  anchor?: SquareAnchor;
}

export interface PadToSquareOptions {
  background?: Color;
}

export interface PadToSquareCenteredOptions {
  background?: Color;
}

export interface InsetOnSquareOptions {
  /** Fractional border per edge (0 <= margin < 0.5). Default 0.10. */
  margin?: number;
  background?: Color;
}

export interface TrimPadSquareOptions {
  /** Fractional border on the content's longer axis (0 <= margin < 0.5). Default 0.10. */
  margin?: number;
  /** 0..255; pixels with all of R,G,B >= this are treated as background. Default 245. */
  threshold?: number;
  background?: Color;
}

// ---------------------------------------------------------------------------
// Core transforms
// ---------------------------------------------------------------------------

/**
 * Load a source image with EXIF orientation BAKED IN, returning a sharp
 * instance whose pixel dimensions already reflect the display orientation.
 *
 * Web/product JPEGs can carry an EXIF orientation flag (e.g. a portrait photo
 * physically stored as landscape + "rotate 90°"). `sharp.metadata()` reports
 * the *stored* dimensions, so reading w/h and then `extract()`-ing would crop
 * on the wrong axis and emit a sideways image. We `.rotate()` (auto-orient
 * from EXIF) into a buffer first, then re-open it — every downstream
 * metadata/extract/extend call then sees correctly-oriented pixels.
 *
 * The intermediate buffer is materialized as PNG (lossless), not the source
 * format — every downstream transform re-encodes on output, so round-tripping
 * a lossy format (JPEG/WebP/AVIF) here would double the generation loss.
 */
async function loadOriented(
  input: Buffer,
): Promise<{ img: Sharp; width: number; height: number }> {
  const orientedBuffer = await sharp(input).rotate().png().toBuffer();
  const img = sharp(orientedBuffer);
  const meta = await img.metadata();
  if (!meta.width || !meta.height) {
    throw new Error('Could not read dimensions from input image');
  }
  return { img, width: meta.width, height: meta.height };
}

/**
 * Crop an image to a square using sharp extract.
 *
 * @returns output dimensions (always square)
 */
export async function cropToSquare(
  input: Buffer,
  opts: CropToSquareOptions = {},
): Promise<SquareResult> {
  const anchor = opts.anchor ?? 'center';
  if (!['top', 'center', 'bottom'].includes(anchor)) {
    throw new Error(`Invalid anchor "${anchor}". Must be top | center | bottom.`);
  }

  const { img, width, height } = await loadOriented(input);

  const side = Math.min(width, height);

  let left = 0;
  let top = 0;

  if (width >= height) {
    // landscape or square — crop horizontally, anchor applies to horizontal axis
    // For crop-to-square we interpret anchor as the vertical position when portrait,
    // and horizontal position when landscape.
    const excess = width - side;
    if (anchor === 'top') {
      left = 0;
    } else if (anchor === 'center') {
      left = Math.floor(excess / 2);
    } else {
      // bottom → right side in landscape context
      left = excess;
    }
  } else {
    // portrait — crop vertically
    const excess = height - side;
    if (anchor === 'top') {
      top = 0;
    } else if (anchor === 'center') {
      top = Math.floor(excess / 2);
    } else {
      // bottom
      top = excess;
    }
  }

  const buffer = await img.extract({ left, top, width: side, height: side }).toBuffer();

  return { buffer, width: side, height: side };
}

/**
 * Extend canvas to square adding background color ONLY on the narrow axis:
 *   portrait  (h > w): pad LEFT  by (h−w) — content becomes right-aligned
 *   landscape (w > h): pad TOP   by (w−h) — content becomes bottom-aligned
 *   square    (h = w): no-op
 *
 * Right and bottom are NEVER extended.
 *
 * @returns output dimensions (always square)
 */
export async function padToSquare(
  input: Buffer,
  opts: PadToSquareOptions = {},
): Promise<SquareResult> {
  const background = opts.background ?? DEFAULT_BACKGROUND;
  const { img, width, height } = await loadOriented(input);

  if (width === height) {
    // Square → no-op; just re-encode through sharp (normalises format)
    const buffer = await img.toBuffer();
    return { buffer, width, height };
  }

  let extendOpts;
  if (height > width) {
    // Portrait (h > w): pad LEFT only so width becomes h → square h×h.
    // Padding appears on the left; original content is right-aligned.
    const pad = height - width;
    extendOpts = { top: 0, bottom: 0, left: pad, right: 0, background };
  } else {
    // Landscape (w > h): pad TOP only so height becomes w → square w×w.
    // Padding appears at the top; original content is bottom-aligned.
    const pad = width - height;
    extendOpts = { top: pad, bottom: 0, left: 0, right: 0, background };
  }

  // Ensure an alpha channel exists so a translucent/transparent `background`
  // (alpha < 1) is actually honored — extend() silently flattens it to opaque
  // on an image with no alpha channel.
  const buffer = await img.ensureAlpha().extend(extendOpts).toBuffer();

  const side = Math.max(width, height);
  return { buffer, width: side, height: side };
}

/**
 * Extend canvas to square adding background color SYMMETRICALLY on BOTH sides
 * of the narrow axis, keeping the original content CENTERED (no crop):
 *   portrait  (h > w): pad LEFT and RIGHT by (h−w)/2 each — content stays horizontally centered
 *   landscape (w > h): pad TOP and BOTTOM by (w−h)/2 each — content stays vertically centered
 *   square    (h = w): no-op
 *
 * When the difference is odd, the extra single pixel is added to the
 * right (portrait) / bottom (landscape) so the output stays square.
 *
 * @returns output dimensions (always square)
 */
export async function padToSquareCentered(
  input: Buffer,
  opts: PadToSquareCenteredOptions = {},
): Promise<SquareResult> {
  const background = opts.background ?? DEFAULT_BACKGROUND;
  const { img, width, height } = await loadOriented(input);

  if (width === height) {
    // Square → no-op; just re-encode through sharp (normalises format)
    const buffer = await img.toBuffer();
    return { buffer, width, height };
  }

  let extendOpts;
  if (height > width) {
    // Portrait (h > w): pad LEFT + RIGHT so width becomes h → square h×h.
    const pad = height - width;
    const before = Math.floor(pad / 2);
    const after = pad - before;
    extendOpts = { top: 0, bottom: 0, left: before, right: after, background };
  } else {
    // Landscape (w > h): pad TOP + BOTTOM so height becomes w → square w×w.
    const pad = width - height;
    const before = Math.floor(pad / 2);
    const after = pad - before;
    extendOpts = { top: before, bottom: after, left: 0, right: 0, background };
  }

  // See padToSquare: ensureAlpha() so a translucent `background` is honored.
  const buffer = await img.ensureAlpha().extend(extendOpts).toBuffer();

  const side = Math.max(width, height);
  return { buffer, width: side, height: side };
}

/**
 * Shrink a SQUARE image's content and center it on a background-color square canvas
 * of the SAME side length, leaving a `margin*N` border on every edge:
 *   content scales to round(N·(1−2·margin)), centered on an N×N canvas.
 *   margin 0.10 (default) → content ~80%, with a 10% border all around.
 *
 * Intended for square inputs. For a non-square input the SHORTER side is treated
 * as N, the content is scaled to fit inside the inset box preserving aspect
 * ratio, and centered on the N×N canvas.
 *
 * NOTE: insets the WHOLE input, so any pre-existing border STACKS on top of the
 * new one (a 10% inset of an image already framed at 10% yields ~18%). Use
 * trimPadSquare instead when an EXACT margin is required regardless of input.
 *
 * @returns output dimensions (always square N×N)
 */
export async function insetOnSquare(
  input: Buffer,
  opts: InsetOnSquareOptions = {},
): Promise<SquareResult> {
  const margin = opts.margin ?? 0.1;
  const background = opts.background ?? DEFAULT_BACKGROUND;
  if (!(margin >= 0 && margin < 0.5)) {
    throw new Error(`Invalid margin "${margin}". Must be 0 ≤ margin < 0.5.`);
  }

  const { img, width, height } = await loadOriented(input);

  // Output side: treat the shorter side as N.
  const side = Math.min(width, height);
  // Clamp to at least 1px — a valid margin can still round the inner box to 0
  // for very small inputs (e.g. a 1px side with margin 0.3), and sharp rejects
  // resize(0, 0).
  const inner = Math.max(1, Math.round(side * (1 - 2 * margin)));

  // Scale the source content down to the inner box (preserving aspect ratio),
  // then composite it centered onto a background N×N canvas.
  // For non-square inputs the resize result may be smaller on one axis — read
  // the actual resized dimensions so the composite is centered on BOTH axes.
  const { data: scaledData, info: scaledInfo } = await img
    .resize(inner, inner, { fit: 'inside' })
    .toBuffer({ resolveWithObject: true });
  const left = Math.round((side - scaledInfo.width) / 2);
  const top = Math.round((side - scaledInfo.height) / 2);

  // A fresh `create` pipeline has no source format to infer on `.toBuffer()`
  // (it would otherwise emit raw pixel bytes), so encode explicitly.
  const buffer = await sharp({
    create: { width: side, height: side, channels: 4, background },
  })
    .composite([{ input: scaledData, top, left }])
    .png()
    .toBuffer();

  return { buffer, width: side, height: side };
}

/**
 * Compute the bounding box of the non-background region in a raw RGBA buffer.
 * A pixel is "background" when ALL of R,G,B are >= `threshold`.
 */
function contentBBox(
  data: Buffer,
  width: number,
  height: number,
  channels: number,
  threshold: number,
): { minX: number; minY: number; maxX: number; maxY: number } | null {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * channels;
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      if (!(r >= threshold && g >= threshold && b >= threshold)) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;
  return { minX, minY, maxX, maxY };
}

/**
 * Trim the near-background border down to the content bounding box, then pad
 * a SQUARE canvas leaving an EXACT `margin` fraction on the content's LONGER
 * axis.
 *
 * This differs from insetOnSquare in one decisive way: the existing border is
 * REMOVED first, so a pre-framed image does not stack margins. A portrait subject
 * ends up with `margin` border top + bottom (the binding axis) and larger symmetric
 * left/right margins; landscape is the reverse. The trimmed content is composited
 * 1:1 (never resampled) onto the square, so no detail is lost.
 *
 * Background detection: a pixel counts as background when all of R,G,B are >=
 * `threshold`. Tune `threshold` down if subtle shadows must be kept as content.
 *
 * @returns square output dimensions
 */
export async function trimPadSquare(
  input: Buffer,
  opts: TrimPadSquareOptions = {},
): Promise<SquareResult> {
  const margin = opts.margin ?? 0.1;
  const threshold = opts.threshold ?? 245;
  const background = opts.background ?? DEFAULT_BACKGROUND;
  if (!(margin >= 0 && margin < 0.5)) {
    throw new Error(`Invalid margin "${margin}". Must be 0 ≤ margin < 0.5.`);
  }
  // Guard the threshold (a negative value flags every pixel as background → blank
  // square; too-large/NaN disables trimming). Match the margin fail-fast.
  if (!Number.isInteger(threshold) || threshold < 0 || threshold > 255) {
    throw new Error(`Invalid threshold "${threshold}". Must be an integer 0 ≤ threshold ≤ 255.`);
  }

  const { img, width, height } = await loadOriented(input);

  // Read raw pixels (on a clone so `img` stays a pristine pipeline) and locate
  // the content bounding box. Flatten onto `background` FIRST: a transparent
  // border otherwise carries whatever RGB its (irrelevant) hidden pixels
  // happen to hold — often far from "near-white" — so it gets misread as
  // content instead of background. Flattening makes a transparent pixel
  // read exactly as the intended pad color, matching how the final square
  // canvas actually renders it. The extracted content itself (below) is
  // still pulled from the un-flattened `img`, so real alpha is preserved.
  const { data, info } = await img
    .clone()
    .ensureAlpha()
    .flatten({ background })
    .raw()
    .toBuffer({ resolveWithObject: true });
  const bbox = contentBBox(data, info.width, info.height, info.channels, threshold);

  // All-background input → emit a background-color square of the larger original side.
  // A fresh `create` pipeline has no source format to infer on `.toBuffer()`
  // (it would otherwise emit raw pixel bytes), so encode explicitly.
  if (!bbox) {
    const side0 = Math.max(width, height);
    const buffer = await sharp({
      create: { width: side0, height: side0, channels: 4, background },
    })
      .png()
      .toBuffer();
    return { buffer, width: side0, height: side0 };
  }

  const cW = bbox.maxX - bbox.minX + 1;
  const cH = bbox.maxY - bbox.minY + 1;
  const longSide = Math.max(cW, cH);
  const side = Math.round(longSide / (1 - 2 * margin));

  // Extract the trimmed content (1:1, no resampling) and center on the square.
  const content = await img
    .extract({ left: bbox.minX, top: bbox.minY, width: cW, height: cH })
    .toBuffer();
  const left = Math.round((side - cW) / 2);
  const top = Math.round((side - cH) / 2);

  const buffer = await sharp({ create: { width: side, height: side, channels: 4, background } })
    .composite([{ input: content, top, left }])
    .png()
    .toBuffer();

  return { buffer, width: side, height: side };
}
