#!/usr/bin/env bash
set -euo pipefail

# check-pack.sh — verify the actual npm ARTIFACT, not just the source tree.
#
# `pnpm test`/`pnpm build` prove the source compiles and behaves correctly,
# but they never exercise `package.json`'s `files`/`exports` map — a wrong
# entry there (e.g. dist/ omitted from `files`, a stale `exports` path) only
# breaks for a real `npm install` of the published tarball. This script packs
# the current tree, installs the tarball into a scratch project exactly like
# a consumer would, and asserts:
#
#   1. The root import (`@takazudo/zudo-image-tweaker`) resolves.
#   2. EVERY subpath export declared in package.json `exports` resolves.
#   3. The installed package.json version matches the source package.json.
#
# This package has no `bin` — it is a library, not a CLI — so there is no
# `--version`/CLI smoke test here (contrast with CLI-shaped sibling projects).
#
# Resolution-only, by design: this script only proves each subpath
# *resolves* through the packed tarball's exports map from a real consumer
# install; it intentionally does not assert on any specific named export or
# runtime behavior — that's what each module's own test suite (`pnpm test`)
# covers. Keeping this gate resolution-only (rather than duplicating
# behavioral assertions here) keeps it cheap enough to run on every PR.
#
# Run locally from anywhere: `bash scripts/check-pack.sh` (paths below are
# resolved relative to this script's own location, not the caller's cwd).
# Wired into: ci.yml (PRs — cheap, catches files[]/exports regressions early)
# and release.yml (before the real `npm publish` — the real release gate).

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PKG_DIR="$REPO_ROOT/packages/zit"
cd "$PKG_DIR"

PKG_NAME=$(node -p "require('./package.json').name")
PKG_VERSION=$(node -p "require('./package.json').version")

WORK_DIR=$(mktemp -d)
cleanup() {
  rm -rf "$WORK_DIR"
}
trap cleanup EXIT

echo "==> Building package"
pnpm run build

echo "==> Packing tarball ($PKG_NAME@$PKG_VERSION)"
PACK_JSON=$(pnpm pack --pack-destination "$WORK_DIR" --json 2>/dev/null)
TARBALL=$(node -e "console.log(JSON.parse(process.argv[1]).filename)" "$PACK_JSON")

if [ ! -f "$TARBALL" ]; then
  echo "::error::pnpm pack did not produce a tarball at $TARBALL"
  exit 1
fi
echo "Tarball: $TARBALL"

INSTALL_DIR="$WORK_DIR/install-test"
mkdir -p "$INSTALL_DIR"

echo "==> Installing tarball into a scratch project"
(
  cd "$INSTALL_DIR"
  npm init -y >/dev/null
  npm i "$TARBALL" >/dev/null
)

echo "==> Checking: installed version matches package.json"
INSTALLED_VERSION=$(node -p "require('$INSTALL_DIR/node_modules/$PKG_NAME/package.json').version")
if [ "$INSTALLED_VERSION" != "$PKG_VERSION" ]; then
  echo "::error::version mismatch: package.json has $PKG_VERSION, installed tarball has $INSTALLED_VERSION"
  exit 1
fi
echo "OK: installed version is $INSTALLED_VERSION"

# Derive subpaths straight from package.json's `exports` map instead of a
# hand-maintained list, so an added/removed subpath is covered automatically
# and can never silently drift out of sync with what actually ships.
SUBPATHS=$(node -p "Object.keys(require('./package.json').exports).join('\n')")

echo "==> Checking: every exports subpath resolves"
while IFS= read -r SUBPATH; do
  [ -z "$SUBPATH" ] && continue

  if [ "$SUBPATH" = "." ]; then
    SPECIFIER="$PKG_NAME"
  else
    SPECIFIER="$PKG_NAME${SUBPATH#.}"
  fi

  if [ "$SUBPATH" = "./package.json" ]; then
    # Not a JS module — verify it resolves to a real file and that its
    # version matches, catching an accidental override of this subpath.
    (
      cd "$INSTALL_DIR"
      RESOLVED_VERSION=$(node -p "require('$SPECIFIER').version")
      if [ "$RESOLVED_VERSION" != "$PKG_VERSION" ]; then
        echo "::error::$SPECIFIER resolved but version ($RESOLVED_VERSION) != $PKG_VERSION"
        exit 1
      fi
    )
    echo "OK: $SPECIFIER resolves (version $PKG_VERSION)"
    continue
  fi

  (
    cd "$INSTALL_DIR"
    node -e "
      const specifier = process.argv[1];
      import(specifier).then(() => {
        // Resolution-only: modules are stubs until the engine wave lands
        // (issue #14), so no named export is asserted here yet.
      }).catch((err) => {
        console.error('::error::failed to resolve', specifier);
        console.error(err);
        process.exit(1);
      });
    " "$SPECIFIER"
  )
  echo "OK: $SPECIFIER resolves"
done <<< "$SUBPATHS"

echo ""
echo "check-pack: all checks passed for $PKG_NAME@$PKG_VERSION"
