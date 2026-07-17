import sharp from 'sharp';

export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * Build a canvasSize x canvasSize RGBA PNG buffer with a single opaque
 * rectangle on an otherwise fully transparent background — a synthetic
 * product silhouette for shadow-geometry tests. No ML involved.
 */
export async function createAlphaRectImage(canvasSize: number, rect: Rect | null): Promise<Buffer> {
  const channels = 4;
  const raw = Buffer.alloc(canvasSize * canvasSize * channels, 0);
  if (rect) {
    for (let y = rect.top; y < rect.top + rect.height; y++) {
      for (let x = rect.left; x < rect.left + rect.width; x++) {
        const i = (y * canvasSize + x) * channels;
        raw[i] = 200;
        raw[i + 1] = 200;
        raw[i + 2] = 200;
        raw[i + 3] = 255;
      }
    }
  }
  return sharp(raw, { raw: { width: canvasSize, height: canvasSize, channels } }).png().toBuffer();
}

export interface AlphaChannel {
  data: Buffer;
  width: number;
  height: number;
}

export async function readAlphaChannel(png: Buffer): Promise<AlphaChannel> {
  const { data, info } = await sharp(png)
    .ensureAlpha()
    .extractChannel(3)
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

export function alphaAt(alpha: AlphaChannel, x: number, y: number): number {
  return alpha.data[y * alpha.width + x];
}
