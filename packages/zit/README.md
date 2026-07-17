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

| Subpath | Description | Docs |
|---|---|---|
| `@takazudo/zudo-image-tweaker/variants` | Multi-width WebP variant engine (content-hash cache, repair, tag dispatch). | [variants](https://zudo-image-tweaker.takazudomodular.com/docs/reference/variants/) |
| `@takazudo/zudo-image-tweaker/heif` | HEIC/HEIF → JPEG conversion with ICC profile preservation. | [heif](https://zudo-image-tweaker.takazudomodular.com/docs/reference/heif/) |
| `@takazudo/zudo-image-tweaker/ogp` | Social-card (Open Graph / Twitter card) image compositor. | [ogp](https://zudo-image-tweaker.takazudomodular.com/docs/reference/ogp/) |
| `@takazudo/zudo-image-tweaker/budget` | Byte-budget encode ladder. | [budget](https://zudo-image-tweaker.takazudomodular.com/docs/reference/budget/) |
| `@takazudo/zudo-image-tweaker/square` | Five-mode square-crop toolbox. | [square](https://zudo-image-tweaker.takazudomodular.com/docs/reference/square/) |
| `@takazudo/zudo-image-tweaker/product-photo` | ML background removal + procedural shadows for product photography. | [product-photo](https://zudo-image-tweaker.takazudomodular.com/docs/reference/product-photo/) |
| `@takazudo/zudo-image-tweaker/calibrate` | Background color normalization. | [calibrate](https://zudo-image-tweaker.takazudomodular.com/docs/reference/calibrate/) |
| `@takazudo/zudo-image-tweaker/composite` | Overlay batch compositing. | [composite](https://zudo-image-tweaker.takazudomodular.com/docs/reference/composite/) |
| `@takazudo/zudo-image-tweaker/blurhash` | BlurHash placeholder generation. | [blurhash](https://zudo-image-tweaker.takazudomodular.com/docs/reference/blurhash/) |
| `@takazudo/zudo-image-tweaker/exif` | EXIF metadata extraction. | [exif](https://zudo-image-tweaker.takazudomodular.com/docs/reference/exif/) |
| `@takazudo/zudo-image-tweaker/browser` | Client-side upload preparation pipeline. | [browser](https://zudo-image-tweaker.takazudomodular.com/docs/reference/browser/) |

Each link above goes to that module's reference page on the
[docs site](https://zudo-image-tweaker.takazudomodular.com/docs/reference/).

## Optional peer dependencies

`@imgly/background-removal-node`, `exifr`, and `heic2any` are optional peer
dependencies, dynamically imported only by the modules that need them
(`product-photo` uses `@imgly/background-removal-node`; `browser` uses both
`exifr` and `heic2any`). Install them only if you use those modules. `/exif`
has no optional peer dependency — it parses the raw EXIF buffer directly.
`/heif`'s HEIC decoder (`heic-decode`) is a regular dependency and is always
installed.

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
