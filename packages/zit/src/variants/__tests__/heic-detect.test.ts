import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../run.js', () => ({
  run: vi.fn(),
  isMissingBinaryError: (error: unknown) =>
    (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT',
}));

import { resetFeatureDetectionCache } from '../feature-detect.js';
import { isHeicSource, isNonImageFile } from '../heic.js';
import { run } from '../run.js';

const mockRun = vi.mocked(run);

function enoent(): NodeJS.ErrnoException {
  return Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' });
}

/** `file --version` succeeds; `file <path>` returns the supplied description. */
function fileSays(description: string) {
  mockRun.mockImplementation(async (_command: string, args: string[]) => {
    if (args.includes('--version')) return { stdout: 'file-5.x', stderr: '' };
    return { stdout: description, stderr: '' };
  });
}

beforeEach(() => {
  resetFeatureDetectionCache();
  mockRun.mockReset();
});

describe('isHeicSource', () => {
  it('trusts the .heic / .heif extension without invoking `file`', async () => {
    expect(await isHeicSource('/x/a.heic')).toBe(true);
    expect(await isHeicSource('/x/a.HEIF')).toBe(true);
    expect(mockRun).not.toHaveBeenCalled();
  });

  it('sniffs a HEIF payload wearing a .jpg extension', async () => {
    fileSays('/x/a.jpg: ISO Media, HEIF Image');
    expect(await isHeicSource('/x/a.jpg')).toBe(true);
    expect(mockRun).toHaveBeenCalledWith('file', ['/x/a.jpg']);
  });

  it('leaves a genuine JPEG alone', async () => {
    fileSays('/x/a.jpg: JPEG image data, JFIF standard');
    expect(await isHeicSource('/x/a.jpg')).toBe(false);
  });

  it('never treats a non-JPEG, non-HEIC extension as HEIC', async () => {
    fileSays('anything');
    expect(await isHeicSource('/x/a.png')).toBe(false);
  });

  it('falls back to extension-only when `file` is unavailable', async () => {
    mockRun.mockRejectedValue(enoent());
    expect(await isHeicSource('/x/a.jpg')).toBe(false);
    expect(await isHeicSource('/x/a.heic')).toBe(true);
  });
});

describe('isNonImageFile', () => {
  it('flags an HTML error page saved as an image', async () => {
    fileSays('/x/a.jpg: HTML document, ASCII text');
    expect(await isNonImageFile('/x/a.jpg')).toBe(true);
  });

  it('flags a plain-text file', async () => {
    fileSays('/x/a.png: ASCII text');
    expect(await isNonImageFile('/x/a.png')).toBe(true);
  });

  it('passes a real image through', async () => {
    fileSays('/x/a.jpg: JPEG image data');
    expect(await isNonImageFile('/x/a.jpg')).toBe(false);
  });

  it('cannot determine anything when `file` is unavailable (returns false)', async () => {
    mockRun.mockRejectedValue(enoent());
    expect(await isNonImageFile('/x/a.jpg')).toBe(false);
  });
});
