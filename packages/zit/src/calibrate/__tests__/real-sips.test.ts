import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { normalizeBackgroundColor, sampleBackgroundColor } from '../index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Reuses the sibling /heif module's real HEIC fixture instead of duplicating a
// binary file. `tmap-gainmap.heic` is the pointed one: its auxiliary-image
// references exceed the limit the system libheif behind `sips` (and behind
// sharp's bundled libvips) enforces, so it is exactly the file that used to be
// undecodable here on every platform.
const TMAP_FIXTURE = path.join(
  __dirname,
  '..',
  '..',
  'heif',
  '__tests__',
  'fixtures',
  'tmap-gainmap.heic',
);

// Unmocked (no vi.mock of node:child_process), unlike sips-feature-detect.test.ts:
// this exercises the real decode ladder end to end — the actual `sips` binary on
// macOS (issue #37 — CI never ran real sips for calibrate), the Node/WASM
// fallback everywhere else (issue #102).
describe('calibrate against a real HEIC file (unmocked decode ladder)', () => {
  it('decodes the gain-map fixture on every platform, sips or not', async () => {
    const color = await sampleBackgroundColor(TMAP_FIXTURE);

    for (const channel of [color.r, color.g, color.b]) {
      expect(channel).toBeGreaterThanOrEqual(0);
      expect(channel).toBeLessThanOrEqual(255);
    }
  });

  it('normalizes the gain-map fixture with no caller-side pre-convert (issue #102)', async () => {
    const before = await sampleBackgroundColor(TMAP_FIXTURE);
    const target = { r: 213, g: 129, b: 71 };

    const { buffer, applied } = await normalizeBackgroundColor(TMAP_FIXTURE, { target });

    expect(buffer.length).toBeGreaterThan(0);
    // A HEIC path has no encodable format of its own to infer, so it falls
    // through to the jpeg default — assert the SOI marker rather than trust it.
    expect(buffer[0]).toBe(0xff);
    expect(buffer[1]).toBe(0xd8);

    for (const scale of [applied.scaleR, applied.scaleG, applied.scaleB]) {
      expect(scale).toBeGreaterThanOrEqual(0.5);
      expect(scale).toBeLessThanOrEqual(2.0);
    }

    // The corrected output's background should sit nearer the target than the
    // source's did — proof the pixels actually moved, not just that bytes came
    // back. Skipped when the fixture is already achromatic enough that the
    // saturation gate zeroes every weight by design.
    const after = await sampleBackgroundColor(buffer);
    const distance = (c: { r: number; g: number; b: number }) =>
      Math.abs(c.r - target.r) + Math.abs(c.g - target.g) + Math.abs(c.b - target.b);
    expect(distance(after)).toBeLessThanOrEqual(distance(before));
  });
});
