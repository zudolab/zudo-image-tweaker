/**
 * Regression test for issue #23, fix 7 (heif/index.ts:152): when `sips`
 * creates a partial output file and then exits non-zero, that partial file
 * must be removed before falling back to the Node decoder — otherwise
 * repeated fallbacks accumulate temp JPEGs in the OS temp dir.
 *
 * `sips` is macOS-only, so a fake `sips` shell script is placed first on
 * PATH: it writes the `--out` file (mimicking sips's partial output) and
 * exits 1. The real HEIC fixture then decodes via the Node fallback, and the
 * assertion is that no `heif-sips-*` temp file survives the call.
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import sharp from 'sharp';
import { convertHeifToJpeg } from '../index.js';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// A fake `sips` that reproduces the failure mode: create the requested
// output (partial), then exit non-zero.
const FAKE_SIPS = `#!/bin/sh
out=""
prev=""
for a in "$@"; do
  if [ "$prev" = "--out" ]; then out="$a"; fi
  prev="$a"
done
: > "$out"
exit 1
`;

let fakeBinDir: string;
let originalPath: string | undefined;

async function tempSipsArtifacts(): Promise<string[]> {
  const names = await fs.readdir(os.tmpdir());
  return names.filter((n) => n.startsWith('heif-sips-')).sort();
}

beforeEach(async () => {
  fakeBinDir = await fs.mkdtemp(path.join(os.tmpdir(), 'zit-fake-sips-'));
  const scriptPath = path.join(fakeBinDir, 'sips');
  await fs.writeFile(scriptPath, FAKE_SIPS);
  await fs.chmod(scriptPath, 0o755);
  originalPath = process.env.PATH;
  process.env.PATH = `${fakeBinDir}${path.delimiter}${originalPath ?? ''}`;
});

afterEach(async () => {
  process.env.PATH = originalPath;
  await fs.rm(fakeBinDir, { recursive: true, force: true });
});

describe('HEIC sips failure cleanup', () => {
  test('the fake sips is actually invoked and exits non-zero (guards the test premise)', async () => {
    // If this ever passes, PATH injection isn't reaching our fake and the
    // real assertion below would be vacuous.
    await expect(execFileAsync('sips', ['--out', path.join(fakeBinDir, 'probe.jpg')])).rejects.toMatchObject(
      { code: 1 },
    );
  });

  test('removes the partial sips output before falling back to the Node decoder', async () => {
    const fixture = path.join(__dirname, 'fixtures', 'tmap-gainmap.heic');
    const before = await tempSipsArtifacts();

    const result = await convertHeifToJpeg(fixture);

    // The Node fallback produced a valid JPEG despite the sips failure.
    const metadata = await sharp(result.buffer).metadata();
    expect(metadata.width).toBe(3024);
    expect(metadata.height).toBe(3024);

    // No partial `heif-sips-*` temp file was left behind by the failed sips.
    expect(await tempSipsArtifacts()).toEqual(before);
  });
});
