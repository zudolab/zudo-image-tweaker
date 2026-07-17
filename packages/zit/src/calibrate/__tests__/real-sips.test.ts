import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { sampleBackgroundColor } from '../index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Reuses the sibling /heif module's real HEIC fixture instead of duplicating
// a binary file — both modules exercise the same sips feature-detect path
// (see index.ts's argument-order comment).
const TMAP_FIXTURE = path.join(__dirname, '..', '..', 'heif', '__tests__', 'fixtures', 'tmap-gainmap.heic');

// Unmocked (no vi.mock of node:child_process), unlike sips-feature-detect.test.ts:
// this exercises the *actual* sips binary on macOS (issue #37 — CI never ran real
// sips for calibrate) and the real ENOENT capability-loss path on non-macOS.
describe('sampleBackgroundColor against a real HEIC file (unmocked sips)', () => {
  it(
    process.platform === 'darwin'
      ? 'decodes the real fixture via the actual sips binary'
      : 'throws the documented capability-loss error when sips is unavailable (non-macOS)',
    async () => {
      if (process.platform === 'darwin') {
        const color = await sampleBackgroundColor(TMAP_FIXTURE);
        expect(color.r).toBeGreaterThanOrEqual(0);
        expect(color.r).toBeLessThanOrEqual(255);
        expect(color.g).toBeGreaterThanOrEqual(0);
        expect(color.g).toBeLessThanOrEqual(255);
        expect(color.b).toBeGreaterThanOrEqual(0);
        expect(color.b).toBeLessThanOrEqual(255);
      } else {
        await expect(sampleBackgroundColor(TMAP_FIXTURE)).rejects.toThrow(
          /sips.*unavailable on this platform/i,
        );
      }
    },
  );
});
