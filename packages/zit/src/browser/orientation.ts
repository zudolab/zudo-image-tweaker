/**
 * Derive width/height, aspect ratio, and orientation classification from a
 * decoded image's dimensions.
 *
 * Pure utility — kept framework-agnostic so it can be unit-tested without
 * touching the DOM or the Canvas API.
 */

export type Orientation = 'landscape' | 'portrait' | 'square';

export interface Dimensions {
  w: number;
  h: number;
}

export interface DerivedGeometry {
  dimensions: Dimensions;
  aspectRatio: number;
  orientation: Orientation;
}

export function deriveOrientation(w: number, h: number): Orientation {
  if (w === h) return 'square';
  return w > h ? 'landscape' : 'portrait';
}

/**
 * Round to 4 decimal places. Returns `0` when `h` is 0 (or either input is
 * non-finite) to avoid surfacing `Infinity`/`NaN` downstream; callers should
 * treat a 0 aspect ratio as "unknown".
 */
export function roundAspectRatio(w: number, h: number): number {
  if (!Number.isFinite(w) || !Number.isFinite(h) || h === 0) return 0;
  return Math.round((w / h) * 10000) / 10000;
}

export function deriveGeometry(w: number, h: number): DerivedGeometry {
  return {
    dimensions: { w, h },
    aspectRatio: roundAspectRatio(w, h),
    orientation: deriveOrientation(w, h),
  };
}
