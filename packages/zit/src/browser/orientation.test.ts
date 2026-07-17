import { describe, expect, it } from 'vitest';
import { deriveGeometry, deriveOrientation, roundAspectRatio } from './orientation';

describe('deriveOrientation', () => {
  it('classifies landscape when w > h', () => {
    expect(deriveOrientation(4000, 3000)).toBe('landscape');
  });
  it('classifies portrait when w < h', () => {
    expect(deriveOrientation(3000, 4000)).toBe('portrait');
  });
  it('classifies square when w === h', () => {
    expect(deriveOrientation(2000, 2000)).toBe('square');
  });
});

describe('roundAspectRatio', () => {
  it('rounds to 4 decimal places', () => {
    // 4000/3000 = 1.33333... -> 1.3333
    expect(roundAspectRatio(4000, 3000)).toBe(1.3333);
  });
  it('returns 0 when h is 0 (guards against Infinity)', () => {
    expect(roundAspectRatio(1000, 0)).toBe(0);
  });
  it('returns 0 when inputs are non-finite', () => {
    expect(roundAspectRatio(NaN, 100)).toBe(0);
    expect(roundAspectRatio(100, Infinity)).toBe(0);
  });
  it('handles exact ratios without drift', () => {
    expect(roundAspectRatio(1600, 900)).toBeCloseTo(1.7778, 4);
  });
});

describe('deriveGeometry', () => {
  it('bundles dimensions, aspectRatio, and orientation', () => {
    expect(deriveGeometry(4000, 3000)).toEqual({
      dimensions: { w: 4000, h: 3000 },
      aspectRatio: 1.3333,
      orientation: 'landscape',
    });
  });
});
