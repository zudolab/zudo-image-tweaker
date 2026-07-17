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

**Runbook**: run `/l-make-release` (optionally with `patch` / `minor` / `next` /
`stable` / `major`). The skill drives version bumping, changelog prepending, CI
gating, package validation (`publint` + `scripts/check-pack.sh`), tag pushing,
and GitHub Release creation in a single guided flow — see
[`.claude/skills/l-make-release/SKILL.md`](.claude/skills/l-make-release/SKILL.md).

The publish step is triggered automatically by `.github/workflows/release.yml`
when a `v*` tag is pushed — there is no manual `npm publish`. The version
source-of-truth is `packages/zit/package.json`.

**First-release preflight**: once this repo is merged, manually dispatch
`release.yml` with `dry_run: true` once
(`gh workflow run release.yml -f dry_run=true`, or via the Actions tab) to
confirm the build and `check-pack.sh` gate pass end-to-end before the first
real tag push. `NPM_TOKEN` (the GitHub Actions repo secret used to publish)
must be a **granular access token** with "Bypass 2FA for noninteractive
automation" enabled — npm classic tokens (including the old "Automation" type)
were revoked registry-wide in Dec 2025 and can no longer be created. Granular
write tokens are capped at a 90-day expiration, so plan to rotate this secret
periodically.

See `packages/zit/CHANGELOG.md` for release history.

## License

MIT — see [LICENSE](./LICENSE).
