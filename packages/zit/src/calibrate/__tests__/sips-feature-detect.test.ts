import { writeFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// This dev machine has no `sips` (macOS-only), so the feature-detect
// branches (available vs ENOENT) are exercised via a mock of
// node:child_process rather than a real binary. execFile is mocked at the
// module level with vi.hoisted so the mock exists before ../index.js's
// static `import { execFile } from 'node:child_process'` resolves it.
const { execFileMock } = vi.hoisted(() => ({ execFileMock: vi.fn() }));

vi.mock('node:child_process', () => ({
  execFile: execFileMock,
}));

describe('HEIC/HEIF sips feature detection', () => {
  beforeEach(() => {
    execFileMock.mockReset();
    vi.resetModules();
  });

  it('throws a descriptive, documented capability-loss error when sips is unavailable (ENOENT)', async () => {
    execFileMock.mockImplementation(
      (_file: string, _args: string[], _options: unknown, callback: (err: unknown) => void) => {
        const err = new Error('spawn sips ENOENT') as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        callback(err);
      },
    );

    const { sampleBackgroundColor } = await import('../index.js');

    await expect(sampleBackgroundColor('/fake/path/photo.heic')).rejects.toThrow(
      /sips.*unavailable on this platform/i,
    );

    expect(execFileMock).toHaveBeenCalledWith(
      'sips',
      [
        '-s',
        'format',
        'jpeg',
        '-s',
        'formatOptions',
        '95',
        '/fake/path/photo.heic',
        '--out',
        expect.any(String),
      ],
      expect.objectContaining({ timeout: expect.any(Number) }),
      expect.any(Function),
    );
  });

  it('wraps a non-ENOENT sips failure with actionable gain-map/pre-convert guidance (issue #34)', async () => {
    execFileMock.mockImplementation(
      (_file: string, _args: string[], _options: unknown, callback: (err: unknown) => void) => {
        callback(new Error('sips: corrupt file'));
      },
    );

    const { sampleBackgroundColor } = await import('../index.js');

    // The original sips message is preserved inside the wrapped error...
    await expect(sampleBackgroundColor('/fake/path/photo.heic')).rejects.toThrow(/corrupt file/);
    // ...alongside guidance mentioning the macOS gain-map limitation and the
    // /heif pre-conversion route, so callers can diagnose either failure mode.
    await expect(sampleBackgroundColor('/fake/path/photo.heic')).rejects.toThrow(/gain map/i);
    await expect(sampleBackgroundColor('/fake/path/photo.heic')).rejects.toThrow(/\/heif/);
  });

  it('cleans up the partial temp JPEG when sips fails after writing one (issue #34)', async () => {
    let writtenTempPath: string | undefined;
    execFileMock.mockImplementation(
      (_file: string, args: string[], _options: unknown, callback: (err: unknown) => void) => {
        const outIndex = args.indexOf('--out');
        writtenTempPath = args[outIndex + 1];
        // Mirrors a real partial-output sips failure (e.g. the documented
        // gain-map auxiliary-image-reference limit): sips writes a partial
        // file to `--out` before exiting non-zero.
        writeFileSync(writtenTempPath, 'partial');
        callback(new Error('sips: too many auxiliary image references'));
      },
    );

    const { sampleBackgroundColor } = await import('../index.js');

    await expect(sampleBackgroundColor('/fake/path/photo.heic')).rejects.toThrow();
    expect(writtenTempPath).toBeDefined();
    await expect(fs.stat(writtenTempPath!)).rejects.toThrow(/ENOENT/);
  });

  it('routes .heif input through the same sips feature-detect path as .heic', async () => {
    execFileMock.mockImplementation(
      (_file: string, _args: string[], _options: unknown, callback: (err: unknown) => void) => {
        const err = new Error('spawn sips ENOENT') as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        callback(err);
      },
    );

    const { normalizeBackgroundColor } = await import('../index.js');

    await expect(
      normalizeBackgroundColor('/fake/path/photo.heif', { target: { r: 100, g: 100, b: 100 } }),
    ).rejects.toThrow(/sips.*unavailable on this platform/i);
  });

  it('converts a HEIC input via sips exactly once per normalizeBackgroundColor call (issue #50)', async () => {
    const sharp = (await import('sharp')).default;
    const fixtureJpeg = await sharp({ create: { width: 200, height: 200, channels: 3, background: { r: 150, g: 100, b: 60 } } })
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

    const result = await normalizeBackgroundColor('/fake/path/photo.heic', {
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
