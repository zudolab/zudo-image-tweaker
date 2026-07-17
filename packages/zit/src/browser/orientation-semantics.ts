/**
 * Reference implementation of the 8 EXIF `Orientation` tag transforms (values
 * 1-8), expressed as pure grid permutations.
 *
 * This does NOT mirror any code path inside `bakeOrientation`
 * (`prepare-upload.ts`): that function deliberately delegates the actual
 * rotate/flip math to `createImageBitmap(..., { imageOrientation: 'from-image'
 * })` rather than hand-rolling the 8-case matrix itself (see its doc comment).
 * There is therefore no in-repo "pure orientation function" for production
 * code to share with this one.
 *
 * Its purpose is different: it's an independently-reasoned oracle for what
 * each orientation value is SUPPOSED to do to a grid of pixels, used to
 * compute expected outputs for both `orientation-semantics.test.ts` (below)
 * and the real-browser CDP smoke test in
 * `scripts/browser-orientation-smoke.mjs` (see issue #52) — so the smoke test
 * can assert Chrome's actual `imageOrientation: 'from-image'` behaviour
 * against a formally-derived expectation instead of a hand-wavy "looks right".
 *
 * Transform definitions (standard EXIF/TIFF orientation semantics, matching
 * the well-known PIL `ImageOps.exif_transpose` table):
 *   1 = normal (no-op)
 *   2 = mirror horizontal
 *   3 = rotate 180
 *   4 = mirror vertical
 *   5 = transpose (mirror across the top-left/bottom-right diagonal)
 *   6 = rotate 90 CW
 *   7 = transverse (mirror across the top-right/bottom-left diagonal)
 *   8 = rotate 90 CCW
 */

/** A grid of pixels/values, indexed `grid[row][col]`. */
export type Grid<T> = readonly T[][];

function cloneGrid<T>(grid: Grid<T>): T[][] {
  return grid.map((row) => [...row]);
}

function flipHorizontal<T>(grid: Grid<T>): T[][] {
  return grid.map((row) => [...row].reverse());
}

function flipVertical<T>(grid: Grid<T>): T[][] {
  return [...grid].reverse().map((row) => [...row]);
}

function rotate180<T>(grid: Grid<T>): T[][] {
  return flipHorizontal(flipVertical(grid));
}

/** Matrix transpose: swaps rows/cols, reflecting across the main diagonal. */
function transpose<T>(grid: Grid<T>): T[][] {
  const rows = grid.length;
  const cols = grid[0]?.length ?? 0;
  const result: T[][] = Array.from({ length: cols }, () => new Array(rows) as T[]);
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      result[x][y] = grid[y][x];
    }
  }
  return result;
}

/** Rotate 90° clockwise: transpose, then reverse each (new) row. */
function rotate90Cw<T>(grid: Grid<T>): T[][] {
  return transpose(grid).map((row) => row.reverse());
}

/** Rotate 90° counter-clockwise: transpose, then reverse the row order. */
function rotate90Ccw<T>(grid: Grid<T>): T[][] {
  return transpose(grid).reverse();
}

/** Transverse (anti-diagonal mirror): rotate 180° after transposing. */
function transverse<T>(grid: Grid<T>): T[][] {
  return rotate180(transpose(grid));
}

/**
 * Apply the display-transform implied by a raw EXIF `Orientation` value
 * (1-8) to a grid, returning the upright arrangement.
 */
export function applyExifOrientationToGrid<T>(grid: Grid<T>, orientation: number): T[][] {
  switch (orientation) {
    case 1:
      return cloneGrid(grid);
    case 2:
      return flipHorizontal(grid);
    case 3:
      return rotate180(grid);
    case 4:
      return flipVertical(grid);
    case 5:
      return transpose(grid);
    case 6:
      return rotate90Cw(grid);
    case 7:
      return transverse(grid);
    case 8:
      return rotate90Ccw(grid);
    default:
      throw new Error(`Invalid EXIF orientation value: ${orientation} (expected 1-8)`);
  }
}
