// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import {
  MISSING_EXIFR_MESSAGE,
  MISSING_HEIC2ANY_MESSAGE,
  prepareImageForUpload,
} from './prepare-upload';

// Simulate the optional peers being absent: a throwing mock factory makes the
// pipeline's `await import(...)` reject exactly as a missing module would. Both
// are mocked absent in one file — the HEIC path fails at heic2any before it
// ever reaches exifr, and the JPEG path never touches heic2any, so the two
// tests don't interfere.
vi.mock('exifr', () => {
  throw new Error("Cannot find package 'exifr'");
});
vi.mock('heic2any', () => {
  throw new Error("Cannot find package 'heic2any'");
});

function makeJpegFile(): File {
  return new File([new Uint8Array([0xff, 0xd8, 0xff, 0xe0])], 'photo.jpg', { type: 'image/jpeg' });
}

function makeHeicFile(): File {
  return new File([new Uint8Array([0, 1, 2, 3])], 'IMG_1234.heic', { type: 'image/heic' });
}

describe('missing optional peer dependencies', () => {
  it('throws an actionable "install exifr" error when exifr is not installed', async () => {
    await expect(prepareImageForUpload(makeJpegFile())).rejects.toThrow(MISSING_EXIFR_MESSAGE);
  });

  it('throws an actionable "install heic2any" error for a HEIC file when heic2any is not installed', async () => {
    await expect(prepareImageForUpload(makeHeicFile())).rejects.toThrow(MISSING_HEIC2ANY_MESSAGE);
  });
});
