/**
 * Client-safe subpath: browser upload-preparation pipeline. Must never
 * import `sharp` or any `node:` builtin — see `browser-chunk-guard.test.ts`.
 */
export {
  prepareImageForUpload,
  HEIC_DECODE_FAILED_MESSAGE,
  ORIENTATION_BAKE_FAILED_MESSAGE_PREFIX,
  type PrepareImageForUploadOptions,
  type PreparedImage,
} from './prepare-upload.js';
export {
  deriveGeometry,
  deriveOrientation,
  roundAspectRatio,
  type Dimensions,
  type DerivedGeometry,
  type Orientation,
} from './orientation.js';
export { needsOrientationBake } from './exif-orientation.js';
