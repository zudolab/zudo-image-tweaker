/**
 * Support library for `browser-chunk-guard.test.ts` (issue #38).
 *
 * The original guard only scanned `dist/browser/index.js`'s own text. That
 * misses two real leak vectors:
 *   - a shared Rollup chunk the browser entry imports from (vite's lib build
 *     hoists code duplicated across multiple entry points into a separate
 *     `dist/<hash>.js` chunk) — a forbidden import landing there instead of
 *     in `dist/browser/index.js` itself would slip past a single-file scan.
 *   - any specifier the original regex didn't happen to list.
 *
 * This walks the real module graph reachable from the browser entry (static
 * `import`/`export ... from`, dynamic `import()`, and `require()`) and checks
 * every specifier found in every reachable file — not just the entry file's
 * own text — against a forbidden list.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

/** Node-only bare specifiers a client-safe bundle must never import. */
export const FORBIDDEN_BARE_SPECIFIERS = [
  'sharp',
  'heic-decode',
  '@imgly/background-removal-node',
  'fs',
  'path',
  'child_process',
  'os',
  'crypto',
  'stream',
  'zlib',
  'util',
  'events',
  'buffer',
  'assert',
  'worker_threads',
];

const SPECIFIER_PATTERN = /(?:\bfrom\s+|\brequire\(\s*|\bimport\(\s*)["']([^"']+)["']/g;

/** Extract every module specifier a chunk's source imports/requires. */
export function extractSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  for (const match of source.matchAll(SPECIFIER_PATTERN)) {
    specifiers.push(match[1]);
  }
  return specifiers;
}

/** Whether a single specifier violates the client-safe boundary. */
export function isForbiddenSpecifier(specifier: string): boolean {
  if (specifier.startsWith('node:')) return true;
  return FORBIDDEN_BARE_SPECIFIERS.includes(specifier);
}

export interface ChunkViolation {
  file: string;
  specifier: string;
}

/**
 * Walk the module graph reachable from `entryFile` (following relative
 * `from`/`import()`/`require()` specifiers only — bare specifiers are leaves,
 * checked but not recursed into) and report every forbidden specifier found
 * in any reachable chunk.
 */
export function findChunkViolations(entryFile: string): ChunkViolation[] {
  const violations: ChunkViolation[] = [];
  const visited = new Set<string>();
  const queue = [resolve(entryFile)];

  while (queue.length > 0) {
    const file = queue.shift()!;
    if (visited.has(file)) continue;
    visited.add(file);

    if (!existsSync(file)) {
      throw new Error(`Expected a built chunk at ${file} — run \`pnpm build\` before \`pnpm test\`.`);
    }
    const source = readFileSync(file, 'utf8');

    for (const specifier of extractSpecifiers(source)) {
      if (isForbiddenSpecifier(specifier)) {
        violations.push({ file, specifier });
        continue;
      }
      if (specifier.startsWith('.')) {
        queue.push(resolve(dirname(file), specifier));
      }
    }
  }

  return violations;
}
