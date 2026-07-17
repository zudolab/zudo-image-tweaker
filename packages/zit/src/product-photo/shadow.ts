import sharp from 'sharp';

const TRANSPARENT = { r: 0, g: 0, b: 0, alpha: 0 } as const;

export type ShadowMode = 'grounded' | 'floating';
export type ShadowBlend = 'multiply' | 'over';

export interface ShadowLayer {
  buffer: Buffer;
  blend: ShadowBlend;
  offset: { x: number; y: number };
}

export interface ShadowTuning {
  blur: number;
  /** Valid range 0..1. Out-of-range values are clamped (prevents 8-bit raw-buffer wraparound). */
  opacity: number;
  offsetX: number;
  offsetY: number;
}

export interface BottomShadowTuning extends ShadowTuning {
  fadeStartRatio: number;
}

export interface ProjectedShadowTuning extends ShadowTuning {
  squash: number;
}

export interface VignetteTuning {
  lightX: number;
  lightY: number;
  /** Valid range 0..1. Out-of-range values are clamped (prevents 8-bit raw-buffer wraparound). */
  strength: number;
  spread: number;
}

export interface GenerateShadowLayersOptions {
  mode?: ShadowMode;
  vignette?: Partial<VignetteTuning>;
  contactShadow?: Partial<ShadowTuning>;
  bottomShadows?: Array<Partial<BottomShadowTuning> | undefined>;
  projectedShadow?: Partial<ProjectedShadowTuning>;
}

interface BBox {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

// Tuned constants ported as-is from the source shadow synthesis engine.
// Light direction is fixed upper-left for both modes.
const VIGNETTE_DEFAULT: VignetteTuning = { lightX: 0.3, lightY: 0.25, strength: 0.12, spread: 1.3 };

const GROUNDED_BOTTOM_SHADOWS: BottomShadowTuning[] = [
  { blur: 100, opacity: 0.25, offsetX: 10, offsetY: 8, fadeStartRatio: -0.1 },
  { blur: 40, opacity: 0.35, offsetX: 8, offsetY: 6, fadeStartRatio: 0.0 },
];
const GROUNDED_CONTACT_SHADOW: ShadowTuning = { blur: 8, opacity: 0.55, offsetX: 4, offsetY: 3 };

const FLOATING_PROJECTED_SHADOW: ProjectedShadowTuning = {
  squash: 0.25,
  offsetX: 65,
  offsetY: 35,
  blur: 75,
  opacity: 0.45,
};
const FLOATING_BOTTOM_SHADOWS: BottomShadowTuning[] = [
  { blur: 120, opacity: 0.3, offsetX: 62, offsetY: 55, fadeStartRatio: -0.1 },
  { blur: 52, opacity: 0.45, offsetX: 58, offsetY: 50, fadeStartRatio: 0.0 },
];
const FLOATING_CONTACT_SHADOW: ShadowTuning = { blur: 12, opacity: 0.5, offsetX: 55, offsetY: 45 };

/**
 * Generate shadow/vignette layers for a product image that already has
 * transparent background and sits at its final position on a
 * canvas-sized (fully transparent elsewhere) RGBA image.
 *
 * Returns layers in back-to-front composite order. Each layer is already
 * sized to match `alphaImage` and pre-positioned, so `offset` is always
 * `{ x: 0, y: 0 }` — callers composite with `left/top: offset.x/y` and the
 * given `blend` mode.
 */
export async function generateShadowLayers(
  alphaImage: string | Buffer,
  options: GenerateShadowLayersOptions = {},
): Promise<ShadowLayer[]> {
  const { mode = 'grounded', vignette, contactShadow, bottomShadows, projectedShadow } = options;

  const { width, height } = await sharp(alphaImage).metadata();
  if (!width || !height) {
    throw new Error('generateShadowLayers: could not read alphaImage dimensions.');
  }

  // toColourspace('b-w') pins the pipeline to single-band greyscale — without it, this
  // sharp/libvips version silently upconverts single-channel raw buffers to 3-band sRGB
  // on any .raw()/.png() output, corrupting every byte offset used below.
  const alphaRaw = await sharp(alphaImage).extractChannel(3).toColourspace('b-w').raw().toBuffer();
  const bbox = findBbox(alphaRaw, width, height);

  const vignetteTuning: VignetteTuning = { ...VIGNETTE_DEFAULT, ...vignette };
  const vignetteLayer = createVignette(width, height, vignetteTuning);

  if (mode === 'floating') {
    const projectedTuning: ProjectedShadowTuning = { ...FLOATING_PROJECTED_SHADOW, ...projectedShadow };
    const [bottomA, bottomB] = mergeBottomShadows(FLOATING_BOTTOM_SHADOWS, bottomShadows);
    const contactTuning: ShadowTuning = { ...FLOATING_CONTACT_SHADOW, ...contactShadow };

    return Promise.all([
      vignetteLayer,
      createProjectedShadow(alphaRaw, width, height, bbox, projectedTuning),
      createBottomOnlyShadow(alphaRaw, width, height, bbox, bottomA),
      createBottomOnlyShadow(alphaRaw, width, height, bbox, bottomB),
      createContactShadow(alphaRaw, width, height, contactTuning),
    ]);
  }

  const [bottomA, bottomB] = mergeBottomShadows(GROUNDED_BOTTOM_SHADOWS, bottomShadows);
  const contactTuning: ShadowTuning = { ...GROUNDED_CONTACT_SHADOW, ...contactShadow };

  return Promise.all([
    vignetteLayer,
    createBottomOnlyShadow(alphaRaw, width, height, bbox, bottomA),
    createBottomOnlyShadow(alphaRaw, width, height, bbox, bottomB),
    createContactShadow(alphaRaw, width, height, contactTuning),
  ]);
}

function mergeBottomShadows(
  defaults: BottomShadowTuning[],
  overrides: Array<Partial<BottomShadowTuning> | undefined> | undefined,
): BottomShadowTuning[] {
  return defaults.map((base, i) => ({ ...base, ...overrides?.[i] }));
}

/**
 * Clamp opacity/strength tuning inputs to [0, 1]. Downstream math multiplies
 * these directly into raw 8-bit buffer bytes (`buf[i] = value`), which is a
 * Node Buffer/Uint8Array write — an out-of-range value silently wraps modulo
 * 256 instead of throwing, producing inverted-brightness ring artifacts.
 */
function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/** Find the bounding box of non-zero pixels in a single-channel raw buffer. */
function findBbox(alphaRaw: Buffer, width: number, height: number): BBox | null {
  let top = height;
  let bottom = 0;
  let left = width;
  let right = 0;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (alphaRaw[y * width + x] > 0) {
        if (y < top) top = y;
        if (y > bottom) bottom = y;
        if (x < left) left = x;
        if (x > right) right = x;
      }
    }
  }

  if (top > bottom) return null; // empty
  return { top, bottom: bottom + 1, left, right: right + 1 };
}

/** Create a contact shadow layer: offset alpha, blur, scale opacity. */
async function createContactShadow(
  alphaRaw: Buffer,
  width: number,
  height: number,
  { blur, opacity, offsetX, offsetY }: ShadowTuning,
): Promise<ShadowLayer> {
  const offsetAlpha = offsetBuffer(alphaRaw, width, height, offsetX, offsetY);

  const blurredAlpha = await sharp(offsetAlpha, { raw: { width, height, channels: 1 } })
    .toColourspace('b-w')
    .blur(Math.max(blur, 0.3))
    .linear(clamp01(opacity), 0)
    .png()
    .toBuffer();

  return buildLayer(blurredAlpha, width, height);
}

/**
 * Create a projected shadow: squash alpha to fraction of height,
 * position at bottom of product, offset, blur.
 */
async function createProjectedShadow(
  alphaRaw: Buffer,
  width: number,
  height: number,
  bbox: BBox | null,
  { squash, offsetX, offsetY, blur, opacity }: ProjectedShadowTuning,
): Promise<ShadowLayer> {
  if (!bbox) return createEmptyLayer(width, height);

  const bw = bbox.right - bbox.left;
  const bh = bbox.bottom - bbox.top;

  // Crop the alpha to bounding box
  const cropped = Buffer.alloc(bw * bh);
  for (let y = 0; y < bh; y++) {
    for (let x = 0; x < bw; x++) {
      cropped[y * bw + x] = alphaRaw[(bbox.top + y) * width + (bbox.left + x)];
    }
  }

  // Squash vertically
  const newH = Math.max(1, Math.round(bh * squash));
  const squashedBuf = await sharp(cropped, { raw: { width: bw, height: bh, channels: 1 } })
    .toColourspace('b-w')
    .resize(bw, newH, { fit: 'fill' })
    .raw()
    .toBuffer();

  // Place squashed shadow on canvas at bottom of product bbox.
  // Per-pixel bounds check handles out-of-range pixels.
  const canvas = Buffer.alloc(width * height, 0);
  const px = bbox.left + offsetX;
  const py = bbox.bottom + offsetY;

  for (let y = 0; y < newH; y++) {
    const canvasY = py + y;
    if (canvasY < 0 || canvasY >= height) continue;
    for (let x = 0; x < bw; x++) {
      const canvasX = px + x;
      if (canvasX < 0 || canvasX >= width) continue;
      canvas[canvasY * width + canvasX] = squashedBuf[y * bw + x];
    }
  }

  const blurredAlpha = await sharp(canvas, { raw: { width, height, channels: 1 } })
    .toColourspace('b-w')
    .blur(Math.max(blur, 0.3))
    .linear(clamp01(opacity), 0)
    .png()
    .toBuffer();

  return buildLayer(blurredAlpha, width, height);
}

/**
 * Create a bottom-only shadow with gradient mask.
 * Shadow fades in from midpoint of product downward.
 */
async function createBottomOnlyShadow(
  alphaRaw: Buffer,
  width: number,
  height: number,
  bbox: BBox | null,
  { blur, opacity, offsetX, offsetY, fadeStartRatio }: BottomShadowTuning,
): Promise<ShadowLayer> {
  if (!bbox) return createEmptyLayer(width, height);

  const clampedOpacity = clamp01(opacity);
  const offsetAlpha = offsetBuffer(alphaRaw, width, height, offsetX, offsetY);

  const blurredBuf = await sharp(offsetAlpha, { raw: { width, height, channels: 1 } })
    .toColourspace('b-w')
    .blur(Math.max(blur, 0.3))
    .raw()
    .toBuffer();

  // Gradient mask: 0 above midpoint, fade to 1 below
  const midY = bbox.top + (bbox.bottom - bbox.top) * (0.5 + fadeStartRatio);
  const fadeZone = (bbox.bottom - midY) * 0.5;

  const result = Buffer.alloc(width * height, 0);
  for (let y = 0; y < height; y++) {
    let maskVal: number;
    if (y <= midY) {
      maskVal = 0;
    } else if (fadeZone > 0 && y <= midY + fadeZone) {
      maskVal = (y - midY) / fadeZone;
    } else {
      maskVal = 1;
    }
    const scaledMask = maskVal * clampedOpacity;
    for (let x = 0; x < width; x++) {
      result[y * width + x] = Math.round(blurredBuf[y * width + x] * scaledMask);
    }
  }

  const alphaPng = await sharp(result, { raw: { width, height, channels: 1 } })
    .toColourspace('b-w')
    .png()
    .toBuffer();

  return buildLayer(alphaPng, width, height);
}

/**
 * Create an asymmetric vignette layer.
 * Light source at (lightX, lightY) as fraction of canvas, darkens away from light.
 */
async function createVignette(
  width: number,
  height: number,
  { lightX, lightY, strength, spread }: VignetteTuning,
): Promise<ShadowLayer> {
  const clampedStrength = clamp01(strength);
  const buf = Buffer.alloc(width * height, 0);
  const cx = width * lightX;
  const cy = height * lightY;
  const halfCanvas = Math.min(width, height) / 2;
  const spreadSq = spread * spread;

  for (let y = 0; y < height; y++) {
    const dy = (y - cy) / halfCanvas;
    const dySq = dy * dy;
    for (let x = 0; x < width; x++) {
      const dx = (x - cx) / halfCanvas;
      const distSq = dx * dx + dySq;
      const darkness = Math.min(1, (distSq / spreadSq) ** 0.75) * clampedStrength * 255;
      buf[y * width + x] = Math.round(darkness);
    }
  }

  const alphaPng = await sharp(buf, { raw: { width, height, channels: 1 } })
    .toColourspace('b-w')
    .png()
    .toBuffer();

  return buildLayer(alphaPng, width, height);
}

/** Offset a single-channel raw buffer by (dx, dy) pixels into a same-sized buffer. */
function offsetBuffer(raw: Buffer, width: number, height: number, dx: number, dy: number): Buffer {
  const out = Buffer.alloc(width * height, 0);
  for (let y = 0; y < height; y++) {
    const dstY = y + dy;
    if (dstY < 0 || dstY >= height) continue;
    for (let x = 0; x < width; x++) {
      const dstX = x + dx;
      if (dstX < 0 || dstX >= width) continue;
      out[dstY * width + dstX] = raw[y * width + x];
    }
  }
  return out;
}

// Cached black canvas PNG per size, built once per dimension on first use.
const blackCanvasCache = new Map<string, Promise<Buffer>>();

function blackCanvasBuffer(width: number, height: number): Promise<Buffer> {
  const key = `${width}x${height}`;
  let cached = blackCanvasCache.get(key);
  if (!cached) {
    cached = sharp({ create: { width, height, channels: 3, background: { r: 0, g: 0, b: 0 } } })
      .png()
      .toBuffer();
    blackCanvasCache.set(key, cached);
  }
  return cached;
}

/** Build a black RGBA PNG shadow layer from a single-channel alpha PNG. */
async function buildLayer(alphaPng: Buffer, width: number, height: number): Promise<ShadowLayer> {
  const black = await blackCanvasBuffer(width, height);
  const buffer = await sharp(black).joinChannel(alphaPng).png().toBuffer();
  return { buffer, blend: 'multiply', offset: { x: 0, y: 0 } };
}

async function createEmptyLayer(width: number, height: number): Promise<ShadowLayer> {
  const buffer = await sharp({ create: { width, height, channels: 4, background: TRANSPARENT } })
    .png()
    .toBuffer();
  return { buffer, blend: 'multiply', offset: { x: 0, y: 0 } };
}
