/**
 * Real-fixture rotation regression test for the engine's HEIC dispatch.
 *
 * Historically this kind of test asserted on live `sharp().metadata().orientation`
 * output and console-logged its way to a pass/fail — non-deterministic and a
 * documented CI blocker. This version pins every assertion to values already
 * established as golden for this exact fixture in `/heif`'s own test suite
 * (see `heif/__tests__/heif.test.ts`): the decoded JPEG is 4284x5712. No
 * wall-clock or platform-dependent behavior — the HEIC decode here always
 * goes through the pure-JS/WASM `convertHeifToJpegNode` fallback (no `sips`
 * on this platform), so the result is identical on every CI runner.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { processOne } from '../engine.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROTATION_FIXTURE = path.join(__dirname, '..', '..', 'heif', '__tests__', 'fixtures', 'test-image-with-rotation.heic');

// Golden dimensions for this fixture, established in heif/__tests__/heif.test.ts.
const EXPECTED_WIDTH = 4284;
const EXPECTED_HEIGHT = 5712;

describe('rotation regression (real HEIC fixture, engine-level)', () => {
  // A full 5712px WASM HEIC decode plus two variant encodes runs close to
  // vitest's 5s default under full-suite parallel load — not a hang guard
  // worth flaking over.
  it('converts, orients, and emits variants at the fixture-derived portrait dimensions', { timeout: 30_000 }, async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'zit-rotation-'));
    try {
      const inputPath = path.join(dir, 'rotated.heic');
      await fs.copyFile(ROTATION_FIXTURE, inputPath);
      const outputDir = path.join(dir, 'out');

      const result = await processOne(
        { inputPath },
        { outputDir, widths: [600, 900] },
      );

      expect(result.status).toBe('processed');
      expect(result.metadata).toMatchObject({
        width: EXPECTED_WIDTH,
        height: EXPECTED_HEIGHT,
        originalFormat: 'heic',
        hasVariants: true,
      });
      // Portrait source: aspect ratio (height/width * 100) is well over 100.
      expect(result.metadata?.aspectRatio).toBeCloseTo((EXPECTED_HEIGHT / EXPECTED_WIDTH) * 100, 2);

      // The .rotate() fix under test: every emitted variant must preserve the
      // portrait orientation (height > width), never swap to landscape.
      expect(result.variants).toHaveLength(2);
      for (const variant of result.variants) {
        const meta = await sharp(await fs.readFile(variant.path)).metadata();
        expect(meta.width).toBe(variant.width);
        expect(meta.height).toBeGreaterThan(meta.width!);
        // Fixture-derived, deterministic: exact expected height for each configured width.
        const expectedHeight = Math.round((variant.width * EXPECTED_HEIGHT) / EXPECTED_WIDTH);
        expect(meta.height).toBe(expectedHeight);
      }
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
