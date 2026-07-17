# @takazudo/zudo-image-tweaker

A sharp-based image-tweaking toolkit, exposed as focused subpath modules so
consumers only pull in the code paths (and native/optional dependencies)
they actually use.

## Install

```sh
pnpm add @takazudo/zudo-image-tweaker
# npm install @takazudo/zudo-image-tweaker
# yarn add @takazudo/zudo-image-tweaker
```

## Modules

| Subpath | Description |
|---|---|
| `@takazudo/zudo-image-tweaker/variants` | Multi-width WebP variant engine (content-hash cache, repair, tag dispatch). |
| `@takazudo/zudo-image-tweaker/heif` | HEIC/HEIF → JPEG conversion with ICC profile preservation. |
| `@takazudo/zudo-image-tweaker/ogp` | Social-card (Open Graph / Twitter card) image compositor. |
| `@takazudo/zudo-image-tweaker/budget` | Byte-budget encode ladder. |
| `@takazudo/zudo-image-tweaker/square` | Five-mode square-crop toolbox. |
| `@takazudo/zudo-image-tweaker/product-photo` | ML background removal + procedural shadows for product photography. |
| `@takazudo/zudo-image-tweaker/calibrate` | Background color normalization. |
| `@takazudo/zudo-image-tweaker/composite` | Overlay batch compositing. |
| `@takazudo/zudo-image-tweaker/blurhash` | BlurHash placeholder generation. |
| `@takazudo/zudo-image-tweaker/exif` | EXIF metadata extraction. |
| `@takazudo/zudo-image-tweaker/browser` | Client-side upload preparation pipeline. |

Each module is documented in the [docs site](https://zudo-image-tweaker.takazudomodular.com/).

## Optional peer dependencies

`@imgly/background-removal-node`, `exifr`, and `heic2any` are optional peer
dependencies, dynamically imported only by the modules that need them
(`product-photo`, `exif`, and `browser` respectively). Install them only if
you use those modules. `/heif`'s HEIC decoder (`heic-decode`) is a regular
dependency and is always installed.

## Security notes

### `/heif`

`convertHeifToJpeg`'s Node/WASM fallback (`heic-decode` → bundled
`libheif-js` 1.19.8) predates the libheif 1.22.0 heap-overflow and
infinite-loop-DoS fixes. Only decode HEIC/HEIF files from sources you
trust. The `maxInputBytes` option (default 256 MiB) rejects oversized
inputs before they reach the decoder, but that's defense-in-depth, not a
substitute for trusting the source.

## License

MIT — see [LICENSE](./LICENSE).
