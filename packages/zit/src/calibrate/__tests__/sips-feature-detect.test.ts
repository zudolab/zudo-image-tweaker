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
    execFileMock.mockImplementation((_file: string, _args: string[], callback: (err: unknown) => void) => {
      const err = new Error('spawn sips ENOENT') as NodeJS.ErrnoException;
      err.code = 'ENOENT';
      callback(err);
    });

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
        '/fake/path/photo.heic',
        '--out',
        expect.any(String),
        '-s',
        'formatOptions',
        '95',
      ],
      expect.any(Function),
    );
  });

  it('rethrows a non-ENOENT sips failure unchanged instead of masking it', async () => {
    execFileMock.mockImplementation((_file: string, _args: string[], callback: (err: unknown) => void) => {
      callback(new Error('sips: corrupt file'));
    });

    const { sampleBackgroundColor } = await import('../index.js');

    await expect(sampleBackgroundColor('/fake/path/photo.heic')).rejects.toThrow(/corrupt file/);
  });

  it('routes .heif input through the same sips feature-detect path as .heic', async () => {
    execFileMock.mockImplementation((_file: string, _args: string[], callback: (err: unknown) => void) => {
      const err = new Error('spawn sips ENOENT') as NodeJS.ErrnoException;
      err.code = 'ENOENT';
      callback(err);
    });

    const { normalizeBackgroundColor } = await import('../index.js');

    await expect(
      normalizeBackgroundColor('/fake/path/photo.heif', { target: { r: 100, g: 100, b: 100 } }),
    ).rejects.toThrow(/sips.*unavailable on this platform/i);
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
