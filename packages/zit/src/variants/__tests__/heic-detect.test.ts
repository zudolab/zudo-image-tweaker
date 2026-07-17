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

/** `file --version` succeeds; `file -b --mime-type <path>` returns the supplied MIME type. */
function fileSays(mimeType: string) {
  mockRun.mockImplementation(async (_command: string, args: string[]) => {
    if (args.includes('--version')) return { stdout: 'file-5.x', stderr: '' };
    return { stdout: mimeType, stderr: '' };
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
    fileSays('image/heif');
    expect(await isHeicSource('/x/a.jpg')).toBe(true);
    expect(mockRun).toHaveBeenCalledWith('file', ['-b', '--mime-type', '/x/a.jpg']);
  });

  it('sniffs a HEIC payload wearing a .jpg extension', async () => {
    fileSays('image/heic');
    expect(await isHeicSource('/x/a.jpg')).toBe(true);
  });

  it('sniffs a HEIF sequence (burst/live-photo) payload wearing a .jpg extension', async () => {
    fileSays('image/heif-sequence');
    expect(await isHeicSource('/x/a.jpg')).toBe(true);
  });

  it('sniffs a HEIC sequence (burst/live-photo) payload wearing a .jpg extension', async () => {
    fileSays('image/heic-sequence');
    expect(await isHeicSource('/x/a.jpg')).toBe(true);
  });

  it('leaves a genuine JPEG alone', async () => {
    fileSays('image/jpeg');
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

  it('processes a genuine JPEG under a directory named HEIC-converted/ correctly', async () => {
    fileSays('image/jpeg');
    expect(await isHeicSource('/photos/HEIC-converted/a.jpg')).toBe(false);
  });

  it('still detects a real HEIF payload under a directory named HEIC-converted/', async () => {
    fileSays('image/heif');
    expect(await isHeicSource('/photos/HEIC-converted/a.jpg')).toBe(true);
  });
});

describe('isNonImageFile', () => {
  it('flags an HTML error page saved as an image', async () => {
    fileSays('text/html');
    expect(await isNonImageFile('/x/a.jpg')).toBe(true);
  });

  it('flags a plain-text file', async () => {
    fileSays('text/plain');
    expect(await isNonImageFile('/x/a.png')).toBe(true);
  });

  it('flags an XML response saved as an image', async () => {
    fileSays('text/xml');
    expect(await isNonImageFile('/x/a.jpg')).toBe(true);
  });

  it('flags a CSV response saved as an image', async () => {
    fileSays('text/csv');
    expect(await isNonImageFile('/x/a.jpg')).toBe(true);
  });

  it('passes a real image through', async () => {
    fileSays('image/jpeg');
    expect(await isNonImageFile('/x/a.jpg')).toBe(false);
  });

  it('cannot determine anything when `file` is unavailable (returns false)', async () => {
    mockRun.mockRejectedValue(enoent());
    expect(await isNonImageFile('/x/a.jpg')).toBe(false);
  });

  it('passes a genuine image through even under a directory named HTML-exports/', async () => {
    fileSays('image/jpeg');
    expect(await isNonImageFile('/photos/HTML-exports/a.jpg')).toBe(false);
  });

  it('still flags a real HTML document under a directory named HTML-exports/', async () => {
    fileSays('text/html');
    expect(await isNonImageFile('/photos/HTML-exports/a.jpg')).toBe(true);
  });
});
