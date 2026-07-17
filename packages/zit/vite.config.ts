import { defineConfig } from 'vite';

/**
 * Vite config for `@takazudo/zudo-image-tweaker`.
 *
 * Lib bundle — one entry per subpath export declared in package.json
 * `exports` (root `.` plus the eleven module subpaths). Each entry key
 * mirrors its source path (`<module>/index`) so the emitted
 * `dist/<module>/index.js` lines up with the `dist/<module>/index.d.ts`
 * that `tsc -p tsconfig.build.json` emits separately (vite-plugin-dts is
 * intentionally avoided — explicit tsc gives single-source-of-truth
 * control over the .d.ts shape).
 *
 * `rollupOptions.external` marks every runtime/peer dependency plus all
 * Node built-ins as external — this package ships thin wrappers around
 * sharp/blurhash/etc. and never bundles them. Several deps (sharp,
 * heic-decode) are native and cannot be bundled at all.
 */
export default defineConfig({
  build: {
    lib: {
      entry: {
        index: 'src/index.ts',
        'variants/index': 'src/variants/index.ts',
        'heif/index': 'src/heif/index.ts',
        'ogp/index': 'src/ogp/index.ts',
        'budget/index': 'src/budget/index.ts',
        'square/index': 'src/square/index.ts',
        'product-photo/index': 'src/product-photo/index.ts',
        'calibrate/index': 'src/calibrate/index.ts',
        'composite/index': 'src/composite/index.ts',
        'blurhash/index': 'src/blurhash/index.ts',
        'exif/index': 'src/exif/index.ts',
        'browser/index': 'src/browser/index.ts',
      },
      formats: ['es'],
    },
    sourcemap: false,
    rollupOptions: {
      external: [
        'sharp',
        'blurhash',
        'xxhash-wasm',
        'heic-decode',
        '@imgly/background-removal-node',
        'exifr',
        'heic2any',
        /^node:/,
      ],
    },
  },
});
