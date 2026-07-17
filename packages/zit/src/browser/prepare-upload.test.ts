// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import heic2any from 'heic2any';
import * as exifr from 'exifr';
import {
  HEIC_DECODE_FAILED_MESSAGE,
  ORIENTATION_BAKE_FAILED_MESSAGE_PREFIX,
  prepareImageForUpload,
} from './prepare-upload';

// Mock the dynamic imports used inside prepareImageForUpload BEFORE any test
// runs it. Default behaviour is overridden per test via mockResolvedValue /
// mockRejectedValue.
vi.mock('heic2any', () => ({
  default: vi.fn(),
}));

vi.mock('exifr', () => ({
  parse: vi.fn(),
}));

const mockedHeic2any = vi.mocked(heic2any);
const mockedExifrParse = vi.mocked(exifr.parse);

function makeJpegFile(name = 'photo.jpg'): File {
  return new File([new Uint8Array([0xff, 0xd8, 0xff, 0xe0])], name, { type: 'image/jpeg' });
}

function makeHeicFile(name = 'IMG_1234.heic'): File {
  return new File([new Uint8Array([0, 1, 2, 3])], name, { type: 'image/heic' });
}

/**
 * Vitest's jsdom environment doesn't implement image decoding or Canvas —
 * both are stubbed per test the same way the source project's test suite
 * stubbed `Image`/`URL.createObjectURL`: swap the global for a fake that
 * drives the promise-based flow deterministically.
 */
class FailingImage {
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  naturalWidth = 0;
  naturalHeight = 0;
  set src(_v: string) {
    // Schedule onerror in a microtask so the consumer has a chance to wire
    // up its handlers first — mirrors real browser behaviour.
    Promise.resolve().then(() => this.onerror?.());
  }
}

class DecodingImage {
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  naturalWidth = 0;
  naturalHeight = 0;
  set src(_v: string) {
    Promise.resolve().then(() => {
      this.naturalWidth = 4000;
      this.naturalHeight = 3000;
      this.onload?.();
    });
  }
}

class FakeCanvasRenderingContext2D {
  drawImage = vi.fn();
}

class FakeCanvas {
  width = 0;
  height = 0;
  private ctx = new FakeCanvasRenderingContext2D();
  getContext(type: string) {
    return type === '2d' ? (this.ctx as unknown as CanvasRenderingContext2D) : null;
  }
  toBlob(callback: BlobCallback, type?: string, _quality?: number) {
    callback(new Blob([new Uint8Array([9, 9, 9])], { type: type ?? 'image/jpeg' }));
  }
}

class FakeImageBitmap {
  close = vi.fn();
  constructor(
    public width: number,
    public height: number,
  ) {}
}

function stubCanvas(fakeCanvas: FakeCanvas) {
  const originalCreateElement = document.createElement.bind(document);
  return vi.spyOn(document, 'createElement').mockImplementation((tag: string, options?: ElementCreationOptions) => {
    if (tag === 'canvas') return fakeCanvas as unknown as HTMLCanvasElement;
    return originalCreateElement(tag, options);
  });
}

describe('prepareImageForUpload', () => {
  const originalCreateObjectURL = URL.createObjectURL;
  const originalRevokeObjectURL = URL.revokeObjectURL;

  beforeEach(() => {
    mockedHeic2any.mockReset();
    mockedExifrParse.mockReset().mockResolvedValue({});
    URL.createObjectURL = vi.fn(() => 'blob:fake');
    URL.revokeObjectURL = vi.fn();
  });

  afterEach(() => {
    URL.createObjectURL = originalCreateObjectURL;
    URL.revokeObjectURL = originalRevokeObjectURL;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  describe('HEIC handling', () => {
    it('transcodes HEIC to JPEG and reports transcodedFromHeic: true', async () => {
      mockedHeic2any.mockResolvedValue(new Blob(['jpeg-bytes'], { type: 'image/jpeg' }));
      vi.stubGlobal('Image', DecodingImage);

      const file = makeHeicFile();
      const result = await prepareImageForUpload(file);

      expect(result.transcodedFromHeic).toBe(true);
      expect(result.file).toBeInstanceOf(Blob);
      expect(result.file).not.toBe(file);
      expect(mockedHeic2any).toHaveBeenCalledWith(
        expect.objectContaining({ blob: file, toType: 'image/jpeg', quality: 0.9 }),
      );
    });

    it('passes a custom heicQuality through to heic2any', async () => {
      mockedHeic2any.mockResolvedValue(new Blob(['jpeg-bytes'], { type: 'image/jpeg' }));
      vi.stubGlobal('Image', DecodingImage);

      await prepareImageForUpload(makeHeicFile(), { heicQuality: 0.5 });

      expect(mockedHeic2any).toHaveBeenCalledWith(expect.objectContaining({ quality: 0.5 }));
    });

    it('falls back to raw HEIC bytes when heic2any fails, and reports transcodedFromHeic: false', async () => {
      mockedHeic2any.mockRejectedValue(new Error('Could not parse HEIF file'));
      vi.stubGlobal('Image', DecodingImage);

      const file = makeHeicFile();
      const result = await prepareImageForUpload(file);

      expect(result.transcodedFromHeic).toBe(false);
      expect(result.file).toBe(file);
    });

    it('throws a clear user-facing error when HEIC transcode fails AND raw HEIC cannot be decoded', async () => {
      mockedHeic2any.mockRejectedValue(new Error('Could not parse HEIF file'));
      vi.stubGlobal('Image', FailingImage);

      await expect(prepareImageForUpload(makeHeicFile())).rejects.toThrow(HEIC_DECODE_FAILED_MESSAGE);
    });

    it('also throws when the file lacks a MIME but has a .HEIC extension (Safari quirk)', async () => {
      mockedHeic2any.mockRejectedValue(new Error('Could not parse HEIF file'));
      vi.stubGlobal('Image', FailingImage);

      // Some Safari versions hand File objects without a `type` set.
      const file = new File([new Uint8Array([0, 1, 2, 3])], 'IMG_1234.HEIC', { type: '' });

      await expect(prepareImageForUpload(file)).rejects.toThrow(HEIC_DECODE_FAILED_MESSAGE);
    });

    it('reads the capture date from the ORIGINAL HEIC bytes, not the transcoded JPEG (heic2any strips metadata)', async () => {
      const date = new Date('2024-05-01T12:00:00Z');
      const transcodedBlob = new Blob(['jpeg-bytes'], { type: 'image/jpeg' });
      mockedHeic2any.mockResolvedValue(transcodedBlob);
      mockedExifrParse.mockResolvedValue({ DateTimeOriginal: date });
      vi.stubGlobal('Image', DecodingImage);

      const file = makeHeicFile();
      const result = await prepareImageForUpload(file);

      expect(result.takenAt).toEqual(date);
      expect(mockedExifrParse).toHaveBeenCalledWith(file, expect.anything());
      expect(mockedExifrParse).not.toHaveBeenCalledWith(transcodedBlob, expect.anything());
    });

    it('does not request an orientation bake for a successfully-transcoded HEIC (heic2any already bakes it)', async () => {
      mockedHeic2any.mockResolvedValue(new Blob(['jpeg-bytes'], { type: 'image/jpeg' }));
      // Even if this were returned, a transcoded HEIC should never look at it.
      mockedExifrParse.mockResolvedValue({ Orientation: 6 });
      const createImageBitmapMock = vi.fn();
      vi.stubGlobal('createImageBitmap', createImageBitmapMock);
      vi.stubGlobal('Image', DecodingImage);

      await prepareImageForUpload(makeHeicFile());

      expect(createImageBitmapMock).not.toHaveBeenCalled();
    });
  });

  describe('non-HEIC dimension decode', () => {
    it('does NOT throw on a JPEG whose decode happens to fail — keeps the 0x0 placeholder', async () => {
      vi.stubGlobal('Image', FailingImage);

      const result = await prepareImageForUpload(makeJpegFile());

      expect(result.width).toBe(0);
      expect(result.height).toBe(0);
      expect(result.orientation).toBe('square');
    });

    it('returns measured dimensions and the original blob on the JPEG happy path', async () => {
      vi.stubGlobal('Image', DecodingImage);

      const file = makeJpegFile();
      const result = await prepareImageForUpload(file);

      expect(result.width).toBe(4000);
      expect(result.height).toBe(3000);
      expect(result.orientation).toBe('landscape');
      expect(result.file).toBe(file);
      expect(result.transcodedFromHeic).toBe(false);
    });
  });

  describe('EXIF date extraction', () => {
    it('extracts takenAt from DateTimeOriginal', async () => {
      const date = new Date('2024-05-01T12:00:00Z');
      mockedExifrParse.mockResolvedValue({ DateTimeOriginal: date });
      vi.stubGlobal('Image', DecodingImage);

      const result = await prepareImageForUpload(makeJpegFile());
      expect(result.takenAt).toEqual(date);
    });

    it('falls back to CreateDate then ModifyDate when DateTimeOriginal is absent', async () => {
      const date = new Date('2024-05-01T12:00:00Z');
      mockedExifrParse.mockResolvedValue({ CreateDate: date });
      vi.stubGlobal('Image', DecodingImage);

      const result = await prepareImageForUpload(makeJpegFile());
      expect(result.takenAt).toEqual(date);
    });

    it('returns null when EXIF has no date fields', async () => {
      mockedExifrParse.mockResolvedValue({});
      vi.stubGlobal('Image', DecodingImage);

      const result = await prepareImageForUpload(makeJpegFile());
      expect(result.takenAt).toBeNull();
    });

    it('returns null when exifr throws', async () => {
      mockedExifrParse.mockRejectedValue(new Error('corrupt EXIF'));
      vi.stubGlobal('Image', DecodingImage);

      const result = await prepareImageForUpload(makeJpegFile());
      expect(result.takenAt).toBeNull();
    });
  });

  describe('orientation baking (EXIF Orientation tag 2-8)', () => {
    it('bakes rotation via canvas and reports the upright (swapped) dimensions', async () => {
      mockedExifrParse.mockResolvedValue({ Orientation: 6 });
      const bitmap = new FakeImageBitmap(3000, 4000);
      const createImageBitmapMock = vi.fn().mockResolvedValue(bitmap);
      vi.stubGlobal('createImageBitmap', createImageBitmapMock);
      const fakeCanvas = new FakeCanvas();
      stubCanvas(fakeCanvas);

      const file = makeJpegFile();
      const result = await prepareImageForUpload(file);

      expect(createImageBitmapMock).toHaveBeenCalledWith(file, { imageOrientation: 'from-image' });
      expect(fakeCanvas.width).toBe(3000);
      expect(fakeCanvas.height).toBe(4000);
      expect(result.width).toBe(3000);
      expect(result.height).toBe(4000);
      expect(result.orientation).toBe('portrait');
      expect(result.file).not.toBe(file);
      expect(result.file).toBeInstanceOf(Blob);
      expect(bitmap.close).toHaveBeenCalled();
    });

    it('requests raw (untranslated) EXIF values, since exifr defaults to human-readable orientation strings', async () => {
      // exifr's default translateValues: true turns Orientation into a
      // string like "Rotate 90 CW" — the numeric check in readExif would
      // silently see `undefined` and never bake. Assert we opt out.
      mockedExifrParse.mockResolvedValue({ Orientation: 6 });
      vi.stubGlobal('createImageBitmap', vi.fn().mockResolvedValue(new FakeImageBitmap(3000, 4000)));
      stubCanvas(new FakeCanvas());

      await prepareImageForUpload(makeJpegFile());

      expect(mockedExifrParse).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ translateValues: false }));
    });

    it('throws when the required orientation bake fails, instead of silently shipping un-rotated 0x0 bytes', async () => {
      mockedExifrParse.mockResolvedValue({ Orientation: 6 });
      vi.stubGlobal('createImageBitmap', vi.fn().mockRejectedValue(new Error('decode failed')));

      await expect(prepareImageForUpload(makeJpegFile())).rejects.toThrow(
        `${ORIENTATION_BAKE_FAILED_MESSAGE_PREFIX}decode failed`,
      );
    });

    it('skips createImageBitmap/canvas entirely when orientation is already upright (1)', async () => {
      mockedExifrParse.mockResolvedValue({ Orientation: 1 });
      const createImageBitmapMock = vi.fn();
      vi.stubGlobal('createImageBitmap', createImageBitmapMock);
      vi.stubGlobal('Image', DecodingImage);

      const file = makeJpegFile();
      const result = await prepareImageForUpload(file);

      expect(createImageBitmapMock).not.toHaveBeenCalled();
      expect(result.width).toBe(4000);
      expect(result.height).toBe(3000);
      expect(result.file).toBe(file);
    });

    it('skips baking when the Orientation tag is absent', async () => {
      mockedExifrParse.mockResolvedValue({});
      const createImageBitmapMock = vi.fn();
      vi.stubGlobal('createImageBitmap', createImageBitmapMock);
      vi.stubGlobal('Image', DecodingImage);

      await prepareImageForUpload(makeJpegFile());

      expect(createImageBitmapMock).not.toHaveBeenCalled();
    });

    it('passes a custom bakeQuality through to canvas.toBlob', async () => {
      mockedExifrParse.mockResolvedValue({ Orientation: 6 });
      const bitmap = new FakeImageBitmap(200, 100);
      vi.stubGlobal('createImageBitmap', vi.fn().mockResolvedValue(bitmap));
      const fakeCanvas = new FakeCanvas();
      stubCanvas(fakeCanvas);
      const toBlobSpy = vi.spyOn(fakeCanvas, 'toBlob');

      await prepareImageForUpload(makeJpegFile(), { bakeQuality: 0.5 });

      expect(toBlobSpy).toHaveBeenCalledWith(expect.any(Function), 'image/jpeg', 0.5);
    });
  });
});
