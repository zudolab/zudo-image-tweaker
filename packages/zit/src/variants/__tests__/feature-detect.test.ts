import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the single external-process seam so detection can be exercised for
// every binary-present / binary-absent combination without touching PATH.
vi.mock('../run.js', () => ({
  run: vi.fn(),
  isMissingBinaryError: (error: unknown) =>
    (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT',
}));

import { hasFfmpeg, hasFileBinary, hasMagick, resetFeatureDetectionCache } from '../feature-detect.js';
import { run } from '../run.js';

const mockRun = vi.mocked(run);

function enoent(): NodeJS.ErrnoException {
  return Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' });
}

beforeEach(() => {
  resetFeatureDetectionCache();
  mockRun.mockReset();
});

describe('feature detection', () => {
  it('reports a binary as present when its version probe succeeds', async () => {
    mockRun.mockResolvedValue({ stdout: 'Version: ImageMagick 7', stderr: '' });
    expect(await hasMagick()).toBe(true);
    // Detection must always pass an argument array, never a shell string.
    expect(mockRun).toHaveBeenCalledWith('magick', ['-version']);
  });

  it('reports a binary as absent on ENOENT', async () => {
    mockRun.mockRejectedValue(enoent());
    expect(await hasFfmpeg()).toBe(false);
    expect(mockRun).toHaveBeenCalledWith('ffmpeg', ['-version']);
  });

  it('treats a non-ENOENT failure as present (the binary exists, it just exited non-zero)', async () => {
    mockRun.mockRejectedValue(Object.assign(new Error('exit 1'), { code: 1 }));
    expect(await hasFileBinary()).toBe(true);
    expect(mockRun).toHaveBeenCalledWith('file', ['--version']);
  });

  it('memoises the result — a second query does not re-probe', async () => {
    mockRun.mockResolvedValue({ stdout: '', stderr: '' });
    expect(await hasMagick()).toBe(true);
    expect(await hasMagick()).toBe(true);
    expect(mockRun).toHaveBeenCalledTimes(1);
  });

  it('handles the plain-Linux combination: file + ffmpeg present, magick absent', async () => {
    mockRun.mockImplementation(async (command: string) => {
      if (command === 'magick') throw enoent();
      return { stdout: '', stderr: '' };
    });
    expect(await hasMagick()).toBe(false);
    expect(await hasFfmpeg()).toBe(true);
    expect(await hasFileBinary()).toBe(true);
  });
});
