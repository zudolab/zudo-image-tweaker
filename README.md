# zudo-image-tweaker

A monorepo containing the `@takazudo/zudo-image-tweaker` npm package — a
sharp-based image-tweaking toolkit with eleven focused subpath modules:
`/variants`, `/heif`, `/ogp`, `/budget`, `/square`, `/product-photo`,
`/calibrate`, `/composite`, `/blurhash`, `/exif`, and `/browser`.

## Packages

| Package | Description |
|---|---|
| [`@takazudo/zudo-image-tweaker`](./packages/zit/) | The published npm package. See its [README](./packages/zit/README.md) for full usage docs. |

## Development

```sh
pnpm install          # install all workspace dependencies

pnpm build            # build all packages (outputs to packages/zit/dist/)
pnpm typecheck        # type-check all packages
pnpm test             # run all tests

# Scoped commands (faster during development)
pnpm -F @takazudo/zudo-image-tweaker build
pnpm -F @takazudo/zudo-image-tweaker typecheck
pnpm -F @takazudo/zudo-image-tweaker test
pnpm -F @takazudo/zudo-image-tweaker test:watch
```

## Documentation site

The docs site lives in `doc/` and is a standalone project (not part of this
pnpm workspace):

```sh
pnpm -C doc install
pnpm -C doc dev
```

## Release

Releases are managed with the `/l-make-release` Claude Code skill, which handles
version bumping, changelog prepending, CI gating, package validation, tag
pushing, and GitHub Release creation in a single guided flow.

The publish step is triggered automatically by `.github/workflows/release.yml`
when a `v*` tag is pushed — there is no manual `npm publish`. The version
source-of-truth is `packages/zit/package.json`.

See `packages/zit/CHANGELOG.md` for release history.

## License

MIT — see [LICENSE](./LICENSE).
