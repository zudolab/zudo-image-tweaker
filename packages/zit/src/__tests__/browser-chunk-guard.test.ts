import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { findChunkViolations } from './chunk-guard-lib';

// The /browser subpath is a client-safe guarantee: it must never pull in
// `sharp` (native, server-only) or any Node builtin, whether that import
// lives directly in dist/browser/index.js or in a shared chunk it imports
// from (vite's lib build hoists code shared across entry points into
// separate dist/<hash>.js chunks). This walks the real reachable module
// graph rather than scanning one file's text, so a forbidden import in a
// shared chunk can't slip past (issue #38). Requires `pnpm build` to have
// run first — see ci.yml, which always builds before testing.
const browserEntry = fileURLToPath(new URL('../../dist/browser/index.js', import.meta.url));

describe('browser chunk guard', () => {
  it('no chunk reachable from the built /browser entry imports a Node-only specifier', () => {
    const violations = findChunkViolations(browserEntry);
    expect(violations).toEqual([]);
  });
});

describe('browser chunk guard — self-test (proves the walker actually catches a violation)', () => {
  let tempDir: string;

  afterEach(() => {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  });

  it('flags a Node builtin imported by a shared chunk two hops from the entry', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'chunk-guard-fixture-'));
    // entry -> ./shared.js -> ./leaf.js, which imports node:fs. This mirrors
    // the real shape a vite-hoisted shared chunk would have.
    writeFileSync(join(tempDir, 'entry.js'), `import { x } from "./shared.js";\nexport { x };\n`);
    writeFileSync(join(tempDir, 'shared.js'), `import { y } from "./leaf.js";\nexport const x = y;\n`);
    writeFileSync(join(tempDir, 'leaf.js'), `import { readFileSync } from "node:fs";\nexport const y = readFileSync;\n`);

    const violations = findChunkViolations(join(tempDir, 'entry.js'));

    expect(violations).toEqual([{ file: join(tempDir, 'leaf.js'), specifier: 'node:fs' }]);
  });

  it('flags a bare `sharp` import as well as `node:` specifiers', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'chunk-guard-fixture-'));
    writeFileSync(join(tempDir, 'entry.js'), `import sharp from "sharp";\nexport default sharp;\n`);

    const violations = findChunkViolations(join(tempDir, 'entry.js'));

    expect(violations).toEqual([{ file: join(tempDir, 'entry.js'), specifier: 'sharp' }]);
  });

  it('does not flag clean relative imports or unrelated bare specifiers', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'chunk-guard-fixture-'));
    writeFileSync(join(tempDir, 'entry.js'), `import { helper } from "./helper.js";\nexport { helper };\n`);
    writeFileSync(join(tempDir, 'helper.js'), `export const helper = () => 'blurhash-ish-but-fine';\n`);

    expect(findChunkViolations(join(tempDir, 'entry.js'))).toEqual([]);
  });

  it('throws a clear error when a reachable chunk file is missing (build not run)', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'chunk-guard-fixture-'));
    expect(() => findChunkViolations(join(tempDir, 'does-not-exist.js'))).toThrow(/run `pnpm build`/);
  });
});
