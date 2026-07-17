import { describe, expect, it } from 'vitest';
import { needsOrientationBake } from './exif-orientation';

describe('needsOrientationBake', () => {
  it('returns false when the tag is missing', () => {
    expect(needsOrientationBake(undefined)).toBe(false);
  });

  it('returns false for orientation 1 (already upright)', () => {
    expect(needsOrientationBake(1)).toBe(false);
  });

  it.each([2, 3, 4, 5, 6, 7, 8])('returns true for orientation %d', (value) => {
    expect(needsOrientationBake(value)).toBe(true);
  });

  it('returns false for out-of-range values', () => {
    expect(needsOrientationBake(0)).toBe(false);
    expect(needsOrientationBake(9)).toBe(false);
    expect(needsOrientationBake(-1)).toBe(false);
  });
});
