import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// This dev machine has no `sips` (macOS-only), so the feature-detect
// branches (available vs ENOENT) are exercised via a mock of
// node:child_process rather than a real binary. execFile is mocked at the
// module level with vi.hoisted so the mock exists before the static
// `import { execFile } from 'node:child_process'` in the shared run seam
// resolves it — that seam backs both /calibrate and the /heif module it
// now delegates HEIC decoding to.
const { execFileMock } = vi.hoisted(() => ({ execFileMock: vi.fn() }));

vi.mock('node:child_process', () => ({
  execFile: execFileMock,
}));

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TMAP_FIXTURE = path.join(
  __dirname,
  '..',
  '..',
  'heif',
  '__tests__',
  'fixtures',
  'tmap-gainmap.heic',
);

function mockSipsMissing() {
  execFileMock.mockImplementation(
    (_file: string, _args: string[], _options: unknown, callback: (err: unknown) => void) => {
      const err = new Error('spawn sips ENOENT') as NodeJS.ErrnoException;
      err.code = 'ENOENT';
      callback(err);
    },
  );
}

describe('HEIC/HEIF decode delegation to /heif', () => {
  beforeEach(() => {
    execFileMock.mockReset();
    vi.resetModules();
  });

  it('falls back to the Node/WASM decoder when sips is unavailable (ENOENT)', async () => {
    mockSipsMissing();

    const { sampleBackgroundColor } = await import('../index.js');

    // Used to throw a capability-loss error here (issue #102). `sips` is still
    // attempted first — the fallback is what changed, not the ordering.
    const color = await sampleBackgroundColor(TMAP_FIXTURE);

    for (const channel of [color.r, color.g, color.b]) {
      expect(channel).toBeGreaterThanOrEqual(0);
      expect(channel).toBeLessThanOrEqual(255);
    }
    expect(execFileMock).toHaveBeenCalledWith(
      'sips',
      expect.arrayContaining(['-s', 'format', 'jpeg', '--out']),
      expect.objectContaining({ timeout: expect.any(Number) }),
      expect.any(Function),
    );
  });

  it('falls back when sips is present but fails on the input (gain-map case)', async () => {
    execFileMock.mockImplementation(
      (_file: string, _args: string[], _options: unknown, callback: (err: unknown) => void) => {
        callback(new Error('sips: too many auxiliary image references'));
      },
    );

    const { sampleBackgroundColor } = await import('../index.js');

    // The exact failure this module used to rethrow with pre-convert guidance:
    // a real gain-map HEIC that the system libheif behind sips rejects.
    await expect(sampleBackgroundColor(TMAP_FIXTURE)).resolves.toEqual(
      expect.objectContaining({ r: expect.any(Number) }),
    );
  });

  it('routes .heif input through the same delegation as .heic', async () => {
    mockSipsMissing();

    const { normalizeBackgroundColor } = await import('../index.js');

    // Extension-keyed, so a .heif path must reach /heif too. The fixture is a
    // HEIC byte-wise; only the extension check is under test here.
    const heifNamed = path.join(__dirname, 'tmp-extension-probe.heif');
    const { readFileSync, rmSync } = await import('node:fs');
    writeFileSync(heifNamed, readFileSync(TMAP_FIXTURE));
    try {
      const { buffer } = await normalizeBackgroundColor(heifNamed, {
        target: { r: 100, g: 100, b: 100 },
      });
      expect(buffer.length).toBeGreaterThan(0);
    } finally {
      rmSync(heifNamed, { force: true });
    }
  });

  it('converts a HEIC input via sips exactly once per normalizeBackgroundColor call (issue #50)', async () => {
    const sharp = (await import('sharp')).default;
    const fixtureJpeg = await sharp({
      create: { width: 200, height: 200, channels: 3, background: { r: 150, g: 100, b: 60 } },
    })
      .jpeg({ quality: 100 })
      .toBuffer();

    execFileMock.mockImplementation(
      (
        _file: string,
        args: string[],
        _options: unknown,
        callback: (err: unknown, result?: { stdout: string; stderr: string }) => void,
      ) => {
        const outIndex = args.indexOf('--out');
        writeFileSync(args[outIndex + 1], fixtureJpeg);
        // The shared `run` seam (variants/run.ts) destructures { stdout,
        // stderr } from the promisified result, so a bare callback(null) —
        // which the previous hand-rolled execFileAsync ignored — must now
        // hand back a result object.
        callback(null, { stdout: '', stderr: '' });
      },
    );

    const { normalizeBackgroundColor } = await import('../index.js');

    // A real path, not a synthetic one: /heif size-guards its input with a
    // stat before any conversion, so a nonexistent path would fail there
    // rather than reaching the sips call this test is counting.
    const result = await normalizeBackgroundColor(TMAP_FIXTURE, {
      target: { r: 150, g: 100, b: 60 },
    });

    expect(result.buffer.length).toBeGreaterThan(0);
    // Previously the HEIC->JPEG sips conversion ran twice per call — once
    // inside sampleBackgroundColor, once inside normalizeBackgroundColor's
    // own decode — this asserts the single-conversion fix (issue #50).
    expect(execFileMock).toHaveBeenCalledTimes(1);
  });

  it('leaves non-HEIC input untouched by the sips path entirely', async () => {
    const { sampleBackgroundColor } = await import('../index.js');
    const sharp = (await import('sharp')).default;

    const raw = Buffer.alloc(60 * 60 * 3, 128);
    const png = await sharp(raw, { raw: { width: 60, height: 60, channels: 3 } }).png().toBuffer();

    await expect(sampleBackgroundColor(png)).resolves.toEqual({ r: 128, g: 128, b: 128 });
    expect(execFileMock).not.toHaveBeenCalled();
  });
});
