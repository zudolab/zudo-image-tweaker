import path from 'node:path';
import { pathToFileURL } from 'node:url';
import sharp from 'sharp';
import type { Color as SharpColor, OverlayOptions, Sharp } from 'sharp';
import { generateShadowLayers } from './shadow.js';
import type { GenerateShadowLayersOptions, ShadowLayer } from './shadow.js';

export { generateShadowLayers };
export type {
  ShadowMode,
  ShadowBlend,
  ShadowLayer,
  ShadowTuning,
  BottomShadowTuning,
  ProjectedShadowTuning,
  VignetteTuning,
  GenerateShadowLayersOptions,
} from './shadow.js';

const CANVAS_SIZE = 1600;
const CONTAINER_SIZE = 1440; // 90% of canvas, matching the source default
const JPEG_QUALITY = 90;
const TRANSPARENT = { r: 0, g: 0, b: 0, alpha: 0 } as const;

// npm package name of the optional peer; also used to build the install-command message.
const IMGLY_PACKAGE = '@imgly/background-removal-node';

export type ImageInput = string | Buffer;

export interface OptionalPeerMissingError extends Error {
  code: 'ERR_OPTIONAL_PEER_MISSING';
}

export interface AlphaTrimOptions {
  threshold?: number;
}

export interface FlatColorBackground {
  color: SharpColor;
}

export type ProductPhotoBackground = ImageInput | FlatColorBackground;

export interface ComposeProductPhotoOptions {
  background: ProductPhotoBackground;
  size?: number;
  fit?: number;
  quality?: number;
  shadow?: boolean | GenerateShadowLayersOptions;
}

export interface ComposeProductPhotoResult {
  buffer: Buffer;
  width: number;
  height: number;
  format: 'jpeg';
}

/**
 * Remove the background from a product image, returning an RGBA PNG buffer.
 *
 * Dynamic-imports the optional peer dependency `@imgly/background-removal-node`
 * (an ONNX-based ML model, ~80MB download on first use) so consumers who
 * never call this function never pay that cost. Accepts a file path,
 * a Buffer, or a URL. Throws an error with `code: 'ERR_OPTIONAL_PEER_MISSING'`
 * when the optional peer isn't installed.
 */
export async function removeBackground(input: ImageInput | URL): Promise<Buffer> {
  const imgly = await loadImgly();
  const source = toImageSource(input);
  const resultBlob = await imgly.removeBackground(source);
  const arrayBuffer = await resultBlob.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

async function loadImgly(): Promise<typeof import('@imgly/background-removal-node')> {
  try {
    return await import('@imgly/background-removal-node');
  } catch (err) {
    if (!isModuleNotFoundError(err)) throw err;
    const message =
      `Optional peer dependency "${IMGLY_PACKAGE}" is not installed. ` +
      `Install it with: npm install ${IMGLY_PACKAGE} (or pnpm add / yarn add ${IMGLY_PACKAGE}).`;
    const peerError = new Error(message) as OptionalPeerMissingError;
    peerError.code = 'ERR_OPTIONAL_PEER_MISSING';
    throw peerError;
  }
}

const NOT_FOUND_SPECIFIER_PATTERN = /cannot find (?:package|module)\s+['"]([^'"]+)['"]/i;

function isModuleNotFoundError(err: unknown): boolean {
  // Walk the Error#cause chain: bundlers/loaders/test-mocking tools commonly
  // wrap a module-resolution failure rather than propagate it as-is.
  //
  // Extract the exact specifier Node names as missing and compare it to the
  // peer's own package name — a substring/includes check would also match a
  // missing *transitive* dependency of the peer (e.g. one of its own native
  // bindings, whose "imported from" clause still mentions the peer's path),
  // misreporting that distinct, actionable installation failure as "the peer
  // itself isn't installed".
  let current: unknown = err;
  for (let depth = 0; depth < 5 && current instanceof Error; depth++) {
    const match = current.message.match(NOT_FOUND_SPECIFIER_PATTERN);
    if (match?.[1] === IMGLY_PACKAGE) return true;
    current = current.cause;
  }
  return false;
}

function toImageSource(input: ImageInput | URL): Buffer | URL | string {
  if (Buffer.isBuffer(input)) return input;
  if (input instanceof URL) return input;
  return pathToFileURL(path.resolve(input)).href;
}

/**
 * Trim fully-transparent padding from an image with an alpha channel,
 * tightly cropping to the opaque/semi-opaque content.
 */
export async function alphaTrim(input: ImageInput, options: AlphaTrimOptions = {}): Promise<Buffer> {
  const { threshold = 10 } = options;
  return sharp(input).trim({ background: TRANSPARENT, threshold }).png().toBuffer();
}

/**
 * Compose a subject (typically background-removed and trimmed via
 * `removeBackground`/`alphaTrim`) onto a background canvas, fitting it
 * within a centered container and optionally adding synthesized shadows.
 */
export async function composeProductPhoto(
  subject: ImageInput,
  options: ComposeProductPhotoOptions,
): Promise<ComposeProductPhotoResult> {
  const { background, size = CANVAS_SIZE, quality = JPEG_QUALITY, shadow = false } = options;
  // Default fit scales with a custom `size` (still 90%, matching the source default of
  // 1440/1600) rather than staying pinned to 1440 — otherwise a smaller custom `size`
  // with no explicit `fit` produces a container larger than the canvas.
  const fit = options.fit ?? Math.round(size * (CONTAINER_SIZE / CANVAS_SIZE));

  if (background === undefined || background === null) {
    throw new Error(
      'composeProductPhoto requires a `background`: an image path/Buffer, or a flat `{ color }` fill.',
    );
  }

  const containerOffset = Math.round((size - fit) / 2);

  // Resize product to fit within the container while maintaining aspect ratio
  const resizedSubject = await sharp(subject)
    .resize(fit, fit, { fit: 'contain', background: TRANSPARENT })
    .png()
    .toBuffer();

  const backgroundCanvas = createBackgroundCanvas(background, size);

  let compositeInputs: OverlayOptions[];

  if (shadow) {
    // Create a full-canvas transparent PNG with the product centered
    const fullCanvasSubject = await sharp({
      create: { width: size, height: size, channels: 4, background: TRANSPARENT },
    })
      .composite([{ input: resizedSubject, left: containerOffset, top: containerOffset }])
      .png()
      .toBuffer();

    const shadowOptions = shadow === true ? {} : shadow;
    const shadowLayers = await generateShadowLayers(fullCanvasSubject, shadowOptions);

    // Composite order: background -> shadows/vignette -> product
    compositeInputs = [...shadowLayers.map(shadowToOverlay), { input: fullCanvasSubject, left: 0, top: 0 }];
  } else {
    compositeInputs = [{ input: resizedSubject, left: containerOffset, top: containerOffset }];
  }

  const { data, info } = await backgroundCanvas
    .composite(compositeInputs)
    .jpeg({ quality })
    .toBuffer({ resolveWithObject: true });

  return { buffer: data, width: info.width, height: info.height, format: 'jpeg' };
}

function shadowToOverlay(layer: ShadowLayer): OverlayOptions {
  return { input: layer.buffer, left: layer.offset.x, top: layer.offset.y, blend: layer.blend };
}

function isFlatColorBackground(background: ProductPhotoBackground): background is FlatColorBackground {
  return typeof background === 'object' && !Buffer.isBuffer(background) && 'color' in background;
}

function createBackgroundCanvas(background: ProductPhotoBackground, size: number): Sharp {
  if (isFlatColorBackground(background)) {
    return sharp({
      create: { width: size, height: size, channels: 3, background: background.color },
    });
  }
  return sharp(background).resize(size, size, { fit: 'cover' });
}
