import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

// See tsconfig.server.json / src/browser/tsconfig.json header comments for
// why this is a supplementary check rather than a change to the frozen
// "typecheck"/"build" npm scripts (issue #68).
const packageRoot = fileURLToPath(new URL('../..', import.meta.url));

interface TscResult {
  code: number;
  output: string;
}

function runTsc(configPath: string): TscResult {
  try {
    const output = execFileSync('pnpm', ['exec', 'tsc', '-p', configPath, '--noEmit'], {
      cwd: packageRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, output };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? 1, output: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

describe('DOM/server typecheck boundary (issue #68)', () => {
  it('server code (tsconfig.server.json, no DOM lib) typechecks clean', () => {
    const result = runTsc('tsconfig.server.json');
    expect(result.code, result.output).toBe(0);
  }, 30_000);

  it('browser code (src/browser/tsconfig.json, DOM lib) typechecks clean on its own', () => {
    const result = runTsc('src/browser/tsconfig.json');
    expect(result.code, result.output).toBe(0);
  }, 30_000);
});

describe('DOM/server boundary — self-test (proves the gate fails on a real DOM leak)', () => {
  let tempDir: string;

  afterEach(() => {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  });

  it('a server-shaped file referencing a DOM-only global fails typecheck without the DOM lib', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'dom-boundary-fixture-'));
    writeFileSync(join(tempDir, 'leaks-dom.ts'), `export const el = document.createElement('div');\n`);
    writeFileSync(
      join(tempDir, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: { target: 'ES2022', lib: ['ES2022'], strict: true, noEmit: true, types: [] },
        include: ['leaks-dom.ts'],
      }),
    );

    const result = runTsc(join(tempDir, 'tsconfig.json'));

    expect(result.code).not.toBe(0);
    expect(result.output).toMatch(/document/);
  }, 30_000);

  it('the same file typechecks fine once the DOM lib is present (sanity check on the fixture itself)', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'dom-boundary-fixture-'));
    writeFileSync(join(tempDir, 'leaks-dom.ts'), `export const el = document.createElement('div');\n`);
    writeFileSync(
      join(tempDir, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: { target: 'ES2022', lib: ['ES2022', 'DOM'], strict: true, noEmit: true, types: [] },
        include: ['leaks-dom.ts'],
      }),
    );

    const result = runTsc(join(tempDir, 'tsconfig.json'));

    expect(result.code, result.output).toBe(0);
  }, 30_000);
});
