/**
 * Exec hardening for the `sips` call site in calibrate/index.ts (issue #88
 * / sources #66, #67): the input path is resolved before it reaches `sips`'
 * argv, and a hung `sips` process is killed after a bounded timeout. Unlike
 * /heif this module has no Node-native HEIC fallback, so a timeout surfaces
 * as the same descriptive error a non-timeout sips failure already does
 * (see resolveDecodeSource's throw in index.ts).
 *
 * A fake `sips` shell script is placed first on PATH, matching the pattern
 * in ../../heif/__tests__/sips-failure-cleanup.test.ts.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { sampleBackgroundColor } from '../index.js';

let fakeBinDir: string;
let originalPath: string | undefined;
let originalCwd: string;

async function installFakeSips(script: string): Promise<void> {
  const scriptPath = path.join(fakeBinDir, 'sips');
  await fs.writeFile(scriptPath, script);
  await fs.chmod(scriptPath, 0o755);
}

beforeEach(async () => {
  fakeBinDir = await fs.mkdtemp(path.join(os.tmpdir(), 'zit-fake-sips-calibrate-hardening-'));
  originalPath = process.env.PATH;
  process.env.PATH = `${fakeBinDir}${path.delimiter}${originalPath ?? ''}`;
  originalCwd = process.cwd();
});

afterEach(async () => {
  process.env.PATH = originalPath;
  process.chdir(originalCwd);
  await fs.rm(fakeBinDir, { recursive: true, force: true });
});

describe('calibrate sips path resolution (issue #66)', () => {
  test('a leading-dash relative input path is resolved before reaching sips argv', async () => {
    const argvPath = path.join(fakeBinDir, 'argv.txt');
    await installFakeSips(`#!/bin/sh
echo "$@" > "${argvPath}"
exit 1
`);
    process.chdir(fakeBinDir);
    const relativeDashName = '-photo.heic';
    await fs.writeFile(path.join(fakeBinDir, relativeDashName), 'not a real heic');

    await expect(sampleBackgroundColor(relativeDashName)).rejects.toThrow();

    const argv = await fs.readFile(argvPath, 'utf8');
    const tokens = argv.trim().split(' ');
    const inputToken = tokens.find((t) => t.includes('photo.heic'));
    expect(inputToken).toBeDefined();
    expect(inputToken!.startsWith('-')).toBe(false);
    expect(path.isAbsolute(inputToken!)).toBe(true);
  });
});

describe('calibrate sips subprocess timeout (issue #67)', () => {
  test('a hung sips process is killed after sipsTimeoutMs and surfaces as an error, not a hang', async () => {
    await installFakeSips(`#!/bin/sh
sleep 5
`);
    const inputPath = path.join(fakeBinDir, 'photo.heic');
    await fs.writeFile(inputPath, 'not a real heic');

    const start = Date.now();
    await expect(
      sampleBackgroundColor(inputPath, { sipsTimeoutMs: 200 }),
    ).rejects.toThrow();
    const elapsedMs = Date.now() - start;

    expect(elapsedMs).toBeLessThan(4_000);
  }, 10_000);
});
