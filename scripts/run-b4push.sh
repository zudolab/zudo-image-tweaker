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

# ── Step 1: Build ────────────────────────────────
step "Step 1/3: Build (pnpm -r build)"
if (cd "$ROOT_DIR" && pnpm build); then
  pass "Build passed"
else
  fail "Build"
fi

# ── Step 2: Tests ────────────────────────────────
step "Step 2/3: Tests (pnpm -r test)"
if (cd "$ROOT_DIR" && pnpm test); then
  pass "All tests passed"
else
  fail "Tests"
fi

# ── Step 3: Typecheck ────────────────────────────
step "Step 3/3: Typecheck (pnpm -r typecheck)"
if (cd "$ROOT_DIR" && pnpm typecheck); then
  pass "Typecheck passed"
else
  fail "Typecheck"
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
