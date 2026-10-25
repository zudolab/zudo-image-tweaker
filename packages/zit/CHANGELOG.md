# Changelog

## 0.1.3

### Features

- b4push: queue heavy steps through the machine-wide heavy-guard (4b15f51)

### Fixed

- product-photo: pass Buffer input to imgly as a MIME-typed Blob, so `removeBackground()` no longer fails with "Unsupported format" ([#126](https://github.com/zudolab/zudo-image-tweaker/pull/126), closes [#123](https://github.com/zudolab/zudo-image-tweaker/issues/123)) (140168c)
- deps: resolve root-workspace pnpm audit advisories ([#116](https://github.com/zudolab/zudo-image-tweaker/issues/116)) (993351d)
- deps: limit audit overrides to their current major/minor lines (87c3255)

### Other Changes

- ci: bump actions/checkout v7.0.1, actions/setup-node v7.1.0, pnpm/action-setup v6.1.0 (8998428)
- docs(doc): re-scaffold the doc site onto create-zudo-doc 8.1.0 / zfb 5.1.2 (f92c5d6, 7fde2a5, ff0c72d)
- ci: gate the doc build, links, wind audit and dependency audit; doc jobs move to Node 24 (4651d4e)
- build(doc): clear the high doc audit advisories (wrangler 4.152.0, zod 4.6.7, undici override) (aa5f7cf)
- chore: follow-ups from the code review (8bdd50e)
- chore(ci): record the NPM_TOKEN rotation on 2026-10-26 (760b1d1)

## 0.1.2

### Fixed

- fix(calibrate): decode HEIC via /heif instead of hard-erroring off macOS (fec0285, [#103](https://github.com/zudolab/zudo-image-tweaker/pull/103))

## 0.1.1

### Other Changes

- build(deps): bump actions/checkout from 5.0.1 to 7.0.0 (0565791, [#97](https://github.com/zudolab/zudo-image-tweaker/pull/97))
- build(deps): bump actions/setup-node from 5.0.0 to 7.0.0 (a974793, [#96](https://github.com/zudolab/zudo-image-tweaker/pull/96))
- build(deps): bump pnpm/action-setup from 5.0.0 to 6.0.9 (f0318bd, [#95](https://github.com/zudolab/zudo-image-tweaker/pull/95))
