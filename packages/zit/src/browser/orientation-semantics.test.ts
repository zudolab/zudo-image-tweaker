import { describe, expect, it } from 'vitest';
import { applyExifOrientationToGrid } from './orientation-semantics';

// Asymmetric 3x2 grid (2 rows, 3 cols) — asymmetric on both axes so every
// orientation's output is independently checkable against a hand-derived
// expected layout (a 2x1 grid, as literally suggested by issue #52, is
// degenerate: with a single row, vertical flips are invisible and several
// orientations collapse to the same result).
const A = 'A', B = 'B', C = 'C', D = 'D', E = 'E', F = 'F';
const grid = [
  [A, B, C],
  [D, E, F],
];

describe('applyExifOrientationToGrid', () => {
  it('orientation 1 (normal) is a no-op', () => {
    expect(applyExifOrientationToGrid(grid, 1)).toEqual([
      [A, B, C],
      [D, E, F],
    ]);
  });

  it('orientation 2 (mirror horizontal)', () => {
    expect(applyExifOrientationToGrid(grid, 2)).toEqual([
      [C, B, A],
      [F, E, D],
    ]);
  });

  it('orientation 3 (rotate 180)', () => {
    expect(applyExifOrientationToGrid(grid, 3)).toEqual([
      [F, E, D],
      [C, B, A],
    ]);
  });

  it('orientation 4 (mirror vertical)', () => {
    expect(applyExifOrientationToGrid(grid, 4)).toEqual([
      [D, E, F],
      [A, B, C],
    ]);
  });

  it('orientation 5 (transpose, main diagonal) swaps dimensions', () => {
    expect(applyExifOrientationToGrid(grid, 5)).toEqual([
      [A, D],
      [B, E],
      [C, F],
    ]);
  });

  it('orientation 6 (rotate 90 CW) swaps dimensions', () => {
    expect(applyExifOrientationToGrid(grid, 6)).toEqual([
      [D, A],
      [E, B],
      [F, C],
    ]);
  });

  it('orientation 7 (transverse, anti-diagonal) swaps dimensions', () => {
    expect(applyExifOrientationToGrid(grid, 7)).toEqual([
      [F, C],
      [E, B],
      [D, A],
    ]);
  });

  it('orientation 8 (rotate 90 CCW) swaps dimensions', () => {
    expect(applyExifOrientationToGrid(grid, 8)).toEqual([
      [C, F],
      [B, E],
      [A, D],
    ]);
  });

  it('rejects an out-of-range orientation value', () => {
    expect(() => applyExifOrientationToGrid(grid, 0)).toThrow(/Invalid EXIF orientation/);
    expect(() => applyExifOrientationToGrid(grid, 9)).toThrow(/Invalid EXIF orientation/);
  });

  it('does not mutate the input grid', () => {
    const original = [
      [A, B],
      [C, D],
    ];
    const snapshot = original.map((row) => [...row]);
    applyExifOrientationToGrid(original, 6);
    expect(original).toEqual(snapshot);
  });
});
