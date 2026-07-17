/**
 * Exec hardening for the `sips` call site in heif/index.ts (issue #88 /
 * sources #66, #67): the input path is resolved before it reaches `sips`'
 * argv, and a hung `sips` process is killed after a bounded timeout instead
 * of stalling the caller forever — falling back to the Node/WASM decoder
 * either way, per the module's existing sips-failure contract.
 *
 * A fake `sips` shell script is placed first on PATH, matching the pattern
 * in sips-failure-cleanup.test.ts.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import sharp from 'sharp';
import { convertHeifToJpeg } from '../index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.join(__dirname, 'fixtures', 'tmap-gainmap.heic');

let fakeBinDir: string;
let originalPath: string | undefined;
let originalCwd: string;

async function installFakeSips(script: string): Promise<void> {
  const scriptPath = path.join(fakeBinDir, 'sips');
  await fs.writeFile(scriptPath, script);
  await fs.chmod(scriptPath, 0o755);
}

beforeEach(async () => {
  fakeBinDir = await fs.mkdtemp(path.join(os.tmpdir(), 'zit-fake-sips-hardening-'));
  originalPath = process.env.PATH;
  process.env.PATH = `${fakeBinDir}${path.delimiter}${originalPath ?? ''}`;
  originalCwd = process.cwd();
});

afterEach(async () => {
  process.env.PATH = originalPath;
  process.chdir(originalCwd);
  await fs.rm(fakeBinDir, { recursive: true, force: true });
});

describe('heif sips path resolution (issue #66)', () => {
  test('a leading-dash relative input path is resolved before reaching sips argv', async () => {
    const argvPath = path.join(fakeBinDir, 'argv.txt');
    await installFakeSips(`#!/bin/sh
echo "$@" > "${argvPath}"
exit 1
`);
    // A relative, leading-dash-named copy of the real fixture, run from a
    // cwd the fake sips can't otherwise infer.
    process.chdir(fakeBinDir);
    const relativeDashName = '-gainmap.heic';
    await fs.copyFile(fixture, path.join(fakeBinDir, relativeDashName));

    const result = await convertHeifToJpeg(relativeDashName);
    // sips fails (exit 1) so this exercises the Node fallback; the point of
    // the test is what argv sips actually received.
    const metadata = await sharp(result.buffer).metadata();
    expect(metadata.width).toBe(3024);

    const argv = await fs.readFile(argvPath, 'utf8');
    const tokens = argv.trim().split(' ');
    const inputToken = tokens.find((t) => t.includes(relativeDashName.replace(/^-/, '')));
    expect(inputToken).toBeDefined();
    expect(inputToken!.startsWith('-')).toBe(false);
    expect(path.isAbsolute(inputToken!)).toBe(true);
  });
});

describe('heif sips subprocess timeout (issue #67)', () => {
  test('a hung sips process is killed after sipsTimeoutMs and falls back to the Node decoder', async () => {
    await installFakeSips(`#!/bin/sh
sleep 5
`);

    const start = Date.now();
    const result = await convertHeifToJpeg(fixture, { sipsTimeoutMs: 200 });
    const elapsedMs = Date.now() - start;

    // Falls through to the Node/WASM decoder rather than hanging for the
    // full 5s the fake sips would otherwise sleep.
    expect(result.converter).toBe('node');
    expect(elapsedMs).toBeLessThan(4_000);

    const metadata = await sharp(result.buffer).metadata();
    expect(metadata.width).toBe(3024);
  }, 10_000);
});
