export * from './variants/index.js';
export * from './heif/index.js';
export * from './ogp/index.js';
export * from './budget/index.js';
export * from './square/index.js';
export * from './product-photo/index.js';
export * from './calibrate/index.js';
export * from './composite/index.js';
export * from './blurhash/index.js';
export * from './exif/index.js';
export * from './browser/index.js';

// Three names are exported by more than one module and so are ambiguous in
// this flat root barrel: `ImageInput` (composite and product-photo) and
// `Orientation` / `deriveOrientation` (exif and browser). Each remains
// fully reachable via its own subpath export (e.g. `.../product-photo`,
// `.../browser`); these explicit re-exports just pick which one the flat
// barrel surfaces so the barrel type-checks.
//
// - `ImageInput`: composite's version (sharp's `SharpInput`, which includes
//   `string | Buffer` plus typed arrays/`ArrayBuffer`) is a strict superset
//   of product-photo's (`string | Buffer`), so re-exporting composite's is
//   non-narrowing for any product-photo caller going through the root.
// - `Orientation` / `deriveOrientation`: exif's and browser's versions are
//   structurally identical (`'landscape' | 'portrait' | 'square'`, derived
//   the same way from width/height); exif's additionally validates and
//   throws on non-finite/non-positive dimensions. It's re-exported here
//   since the root entry is the server entry (browser is a dedicated
//   client-safe subpath with its own stricter chunk-isolation guarantees).
//
// Reviewed and confirmed during the integration pass (issue #17).
export type { ImageInput } from './composite/index.js';
export type { Orientation } from './exif/index.js';
export { deriveOrientation } from './exif/index.js';
