#!/usr/bin/env bash
set -euo pipefail

# Before-push comprehensive check script for zudo-image-tweaker.
# Mirrors the steps run in .github/workflows/ci.yml so failures are caught
# locally before pushing.

START_TIME=$(date +%s)
FAILURES=()

step() {
  echo ""
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "▶ $1"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
}

pass() {
  echo "✅ $1"
}

fail() {
  echo "❌ $1"
  FAILURES+=("$1")
}

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

# Machine-wide queue for heavy steps, shared by every agent session on this machine
# (owner's ~/.claude or ~/.codex). Absent on CI and on other machines → runs directly.
heavy() {
  local g="${HEAVY_GUARD:-}"
  [ -n "$g" ] || for c in "$HOME/.claude/scripts/heavy-guard.sh" "$HOME/.codex/scripts/heavy-guard.sh"; do
    [ -x "$c" ] && { g="$c"; break; }
  done
  if [ -n "$g" ] && [ -z "${CI:-}" ]; then "$g" -- "$@"; else "$@"; fi
}

# ── Step 1: Build ────────────────────────────────
step "Step 1/4: Build (pnpm -r build)"
if (cd "$ROOT_DIR" && heavy pnpm build); then
  pass "Build passed"
else
  fail "Build"
fi

# ── Step 2: Tests ────────────────────────────────
step "Step 2/4: Tests (pnpm -r test)"
if (cd "$ROOT_DIR" && heavy pnpm test); then
  pass "All tests passed"
else
  fail "Tests"
fi

# ── Step 3: Typecheck ────────────────────────────
step "Step 3/4: Typecheck (pnpm -r typecheck)"
if (cd "$ROOT_DIR" && pnpm typecheck); then
  pass "Typecheck passed"
else
  fail "Typecheck"
fi

# ── Step 4: Check pack ───────────────────────────
step "Step 4/4: Check pack (scripts/check-pack.sh)"
if (cd "$ROOT_DIR" && heavy bash scripts/check-pack.sh); then
  pass "Check pack passed"
else
  fail "Check pack"
fi

# ── Summary ──────────────────────────────────────
END_TIME=$(date +%s)
DURATION=$((END_TIME - START_TIME))

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  SUMMARY (${DURATION}s)"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

if [ ${#FAILURES[@]} -eq 0 ]; then
  echo "✅ All checks passed! Safe to push."
  exit 0
else
  echo "❌ ${#FAILURES[@]} check(s) failed:"
  for f in "${FAILURES[@]}"; do
    echo "   - $f"
  done
  exit 1
fi
