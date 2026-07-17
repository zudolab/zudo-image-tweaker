import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// The /browser subpath is a client-safe guarantee: it must never pull in
// `sharp` (native, server-only) or any `node:` builtin, or bundlers targeting
// the browser will fail to resolve it. This inspects the actual built
// output rather than the source, so it also catches transitive imports
// introduced by a future change. Requires `pnpm build` to have run first —
// see ci.yml, which always builds before testing.
const browserChunkPath = fileURLToPath(new URL('../../dist/browser/index.js', import.meta.url));

const FORBIDDEN_SPECIFIER_PATTERNS = [
  /\bfrom\s+["']sharp["']/,
  /\bimport\(\s*["']sharp["']\s*\)/,
  /\brequire\(\s*["']sharp["']\s*\)/,
  /["']node:[^"']+["']/,
];

describe('browser chunk guard', () => {
  it('the built /browser chunk imports neither sharp nor any node: builtin', () => {
    if (!existsSync(browserChunkPath)) {
      throw new Error(
        `Expected a built chunk at ${browserChunkPath} — run \`pnpm build\` before \`pnpm test\` (CI always builds first).`,
      );
    }
    const source = readFileSync(browserChunkPath, 'utf8');

    for (const pattern of FORBIDDEN_SPECIFIER_PATTERNS) {
      expect(source).not.toMatch(pattern);
    }
  });
});
