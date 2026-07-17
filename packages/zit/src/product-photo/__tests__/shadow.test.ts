import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { generateShadowLayers } from '../shadow.js';
import { alphaAt, createAlphaRectImage, readAlphaChannel } from './helpers.js';

const CANVAS = 200;
const SQUARE = { left: 80, top: 80, width: 40, height: 40 };

describe('generateShadowLayers', () => {
  it('returns 4 layers for grounded mode and 5 for floating mode', async () => {
    const image = await createAlphaRectImage(CANVAS, SQUARE);
    const grounded = await generateShadowLayers(image, { mode: 'grounded' });
    const floating = await generateShadowLayers(image, { mode: 'floating' });
    expect(grounded).toHaveLength(4);
    expect(floating).toHaveLength(5);
  });

  it('defaults to grounded mode when mode is omitted', async () => {
    const image = await createAlphaRectImage(CANVAS, SQUARE);
    const layers = await generateShadowLayers(image);
    expect(layers).toHaveLength(4);
  });

  it('every layer matches the input canvas size, is pre-positioned, and blends by multiply', async () => {
    const image = await createAlphaRectImage(CANVAS, SQUARE);
    const layers = await generateShadowLayers(image, { mode: 'floating' });
    for (const layer of layers) {
      expect(layer.blend).toBe('multiply');
      expect(layer.offset).toEqual({ x: 0, y: 0 });
      const meta = await sharp(layer.buffer).metadata();
      expect(meta.width).toBe(CANVAS);
      expect(meta.height).toBe(CANVAS);
      expect(meta.channels).toBe(4);
    }
  });

  it('shifts the contact shadow by the configured offset', async () => {
    const image = await createAlphaRectImage(CANVAS, SQUARE);
    // Offset exceeds the square's own size (40px) so the shifted and original
    // footprints don't overlap — otherwise "originalCenter is now empty" isn't a valid check.
    const layers = await generateShadowLayers(image, {
      mode: 'grounded',
      contactShadow: { blur: 0.3, opacity: 1, offsetX: 60, offsetY: 60 },
    });
    const contact = layers[3]; // grounded order: [vignette, bottomA, bottomB, contact]
    const alpha = await readAlphaChannel(contact.buffer);

    const shiftedCenterX = SQUARE.left + SQUARE.width / 2 + 60;
    const shiftedCenterY = SQUARE.top + SQUARE.height / 2 + 60;
    expect(alphaAt(alpha, shiftedCenterX, shiftedCenterY)).toBeGreaterThan(200);

    const originalCenterX = SQUARE.left + SQUARE.width / 2;
    const originalCenterY = SQUARE.top + SQUARE.height / 2;
    expect(alphaAt(alpha, originalCenterX, originalCenterY)).toBeLessThan(50);
  });

  it('darkens the vignette more away from the upper-left light source', async () => {
    const image = await createAlphaRectImage(CANVAS, null);
    const [vignette] = await generateShadowLayers(image, { mode: 'grounded' });
    const alpha = await readAlphaChannel(vignette.buffer);

    const nearLight = alphaAt(alpha, Math.round(CANVAS * 0.3), Math.round(CANVAS * 0.25));
    const farFromLight = alphaAt(alpha, CANVAS - 1, CANVAS - 1);
    expect(farFromLight).toBeGreaterThan(nearLight);
  });

  it('fades the bottom-only shadow in below the midpoint of the bounding box', async () => {
    const image = await createAlphaRectImage(CANVAS, SQUARE);
    const layers = await generateShadowLayers(image, {
      mode: 'grounded',
      bottomShadows: [{ blur: 20, offsetX: 0, offsetY: 0, fadeStartRatio: 0, opacity: 1 }],
    });
    const bottomShadow = layers[1];
    const alpha = await readAlphaChannel(bottomShadow.buffer);

    const centerX = SQUARE.left + SQUARE.width / 2;
    const aboveMid = alphaAt(alpha, centerX, SQUARE.top + SQUARE.height / 2 - 5);
    const belowMid = alphaAt(alpha, centerX, SQUARE.top + SQUARE.height + 5);
    expect(aboveMid).toBe(0);
    expect(belowMid).toBeGreaterThan(0);
  });

  it('places the floating-mode projected shadow below the bounding box, squashed', async () => {
    const image = await createAlphaRectImage(CANVAS, SQUARE);
    const layers = await generateShadowLayers(image, {
      mode: 'floating',
      projectedShadow: { squash: 0.25, offsetX: 0, offsetY: 10, blur: 0.3, opacity: 1 },
    });
    const projected = layers[1]; // floating order: [vignette, projected, bottomA, bottomB, contact]
    const alpha = await readAlphaChannel(projected.buffer);

    const centerX = SQUARE.left + SQUARE.width / 2;
    const belowBbox = alphaAt(alpha, centerX, SQUARE.top + SQUARE.height + 15);
    const insideOriginalSquare = alphaAt(alpha, centerX, SQUARE.top + 5);
    expect(belowBbox).toBeGreaterThan(100);
    expect(insideOriginalSquare).toBe(0);
  });

  it('returns transparent placeholder layers for bbox-dependent shadows when the alpha image is empty', async () => {
    const image = await createAlphaRectImage(CANVAS, null);
    const layers = await generateShadowLayers(image, { mode: 'floating' });
    // floating order: [vignette, projected, bottomA, bottomB, contact]
    for (const layer of [layers[1], layers[2], layers[3]]) {
      const alpha = await readAlphaChannel(layer.buffer);
      expect(alpha.data.every((v) => v === 0)).toBe(true);
    }
  });

  it('merges bottomShadows overrides positionally, leaving unspecified entries at their default', async () => {
    const image = await createAlphaRectImage(CANVAS, SQUARE);
    const layers = await generateShadowLayers(image, {
      mode: 'grounded',
      bottomShadows: [{ opacity: 0 }],
    });
    const firstBottom = await readAlphaChannel(layers[1].buffer);
    const secondBottom = await readAlphaChannel(layers[2].buffer);

    expect(firstBottom.data.every((v) => v === 0)).toBe(true);
    expect(secondBottom.data.some((v) => v > 0)).toBe(true);
  });

  it('rejects when the alpha image has no readable dimensions', async () => {
    await expect(generateShadowLayers(Buffer.from('not an image'))).rejects.toThrow();
  });

  it('clamps out-of-range contact-shadow opacity instead of wrapping the raw buffer (issue #77)', async () => {
    const image = await createAlphaRectImage(CANVAS, SQUARE);
    // opacity=1 is the max valid value; opacity=8 exercises the pre-fix wrap
    // (8*255 mod 256 would flip a fully-covered pixel to a near-zero byte).
    const clampedRef = await generateShadowLayers(image, {
      mode: 'grounded',
      contactShadow: { blur: 0.3, opacity: 1, offsetX: 0, offsetY: 0 },
    });
    const overOpacity = await generateShadowLayers(image, {
      mode: 'grounded',
      contactShadow: { blur: 0.3, opacity: 8, offsetX: 0, offsetY: 0 },
    });

    const refAlpha = await readAlphaChannel(clampedRef[3].buffer);
    const overAlpha = await readAlphaChannel(overOpacity[3].buffer);
    const cx = SQUARE.left + SQUARE.width / 2;
    const cy = SQUARE.top + SQUARE.height / 2;

    // Clamped to opacity=1: fully covered center should be at (or very near) 255,
    // not a wrapped-low byte value.
    expect(alphaAt(overAlpha, cx, cy)).toBeGreaterThan(200);
    expect(alphaAt(overAlpha, cx, cy)).toBe(alphaAt(refAlpha, cx, cy));
  });

  it('clamps out-of-range bottom-shadow opacity instead of wrapping the raw buffer (issue #77)', async () => {
    const image = await createAlphaRectImage(CANVAS, SQUARE);
    const clampedRef = await generateShadowLayers(image, {
      mode: 'grounded',
      bottomShadows: [{ blur: 0.3, offsetX: 0, offsetY: 0, fadeStartRatio: 0, opacity: 1 }],
    });
    const overOpacity = await generateShadowLayers(image, {
      mode: 'grounded',
      bottomShadows: [{ blur: 0.3, offsetX: 0, offsetY: 0, fadeStartRatio: 0, opacity: 5 }],
    });

    const refAlpha = await readAlphaChannel(clampedRef[1].buffer);
    const overAlpha = await readAlphaChannel(overOpacity[1].buffer);
    const centerX = SQUARE.left + SQUARE.width / 2;
    const belowMidY = SQUARE.top + SQUARE.height + 5;

    expect(alphaAt(overAlpha, centerX, belowMidY)).toBe(alphaAt(refAlpha, centerX, belowMidY));
  });

  it('clamps out-of-range vignette strength instead of wrapping the raw buffer (issue #77)', async () => {
    const image = await createAlphaRectImage(CANVAS, null);
    const clampedRef = await generateShadowLayers(image, {
      mode: 'grounded',
      vignette: { strength: 1 },
    });
    const overStrength = await generateShadowLayers(image, {
      mode: 'grounded',
      vignette: { strength: 6 },
    });

    const refAlpha = await readAlphaChannel(clampedRef[0].buffer);
    const overAlpha = await readAlphaChannel(overStrength[0].buffer);

    // Farthest corner from the light source: darkness saturates at strength*255.
    // Pre-fix, strength=6 would compute darkness=1530, wrapping mod 256 to a
    // low byte instead of clamping to 255.
    expect(alphaAt(overAlpha, CANVAS - 1, CANVAS - 1)).toBe(
      alphaAt(refAlpha, CANVAS - 1, CANVAS - 1),
    );
    expect(alphaAt(overAlpha, CANVAS - 1, CANVAS - 1)).toBeGreaterThan(200);
  });
});
