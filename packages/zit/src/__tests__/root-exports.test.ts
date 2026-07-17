/**
 * Pins the runtime export surface of the root barrel (`src/index.ts`) and
 * every subpath module it re-exports from.
 *
 * `src/index.ts` is a flat `export *` barrel over eleven subpath modules.
 * That makes it silent when two modules export the same name: per ES
 * module semantics, a name ambiguously provided by more than one `export *`
 * is dropped from the resulting namespace rather than raising an error (see
 * the collision notes at the bottom of `src/index.ts` for the two cases
 * this package hits: `ImageInput` and `Orientation`/`deriveOrientation`).
 * Without a test, a future module addition that happens to reuse an
 * existing export name would silently shrink the public API — no build
 * error, no type error, just a function that quietly stopped being
 * reachable from the root.
 *
 * IMPORTANT — if you intentionally add/rename/remove an export from the
 * root barrel or any subpath module below, update the matching expected
 * list in this file as a conscious part of that change. A failure here
 * means the public API surface changed; make sure that was on purpose.
 */
import { describe, expect, it } from 'vitest';
import * as root from '../index.js';
import * as variants from '../variants/index.js';
import * as heif from '../heif/index.js';
import * as ogp from '../ogp/index.js';
import * as budget from '../budget/index.js';
import * as square from '../square/index.js';
import * as productPhoto from '../product-photo/index.js';
import * as calibrate from '../calibrate/index.js';
import * as composite from '../composite/index.js';
import * as blurhash from '../blurhash/index.js';
import * as exif from '../exif/index.js';
import * as browser from '../browser/index.js';

function sortedKeys(mod: object): string[] {
  return Object.keys(mod).sort();
}

describe('root barrel export surface (src/index.ts)', () => {
  it('exposes exactly the expected flat set of names', () => {
    const expected = [
      'DEFAULT_CACHE_FILENAME',
      'DEFAULT_CONCURRENCY',
      'DEFAULT_FORMATS',
      'DEFAULT_MAX_CANVAS_AREA',
      'DEFAULT_OGP_FILENAME',
      'DEFAULT_QUALITY',
      'DEFAULT_WIDTHS',
      'HEIC_DECODE_FAILED_MESSAGE',
      'IMAGE_EXTENSION_REGEX',
      'MISSING_EXIFR_MESSAGE',
      'MISSING_HEIC2ANY_MESSAGE',
      'ORIENTATION_BAKE_FAILED_MESSAGE_PREFIX',
      'PHOTO_VARIANT_WIDTHS',
      'SUPPORTED_IMAGE_EXTENSIONS',
      'VariantProcessingError',
      'alphaTrim',
      'bakeOrientation',
      'batchBlurhashToDataUri',
      'blurhashToDataUri',
      'calibrateTargetFromSamples',
      'composeProductPhoto',
      'compositeBatch',
      'compositeOverlay',
      'convertHeifToJpeg',
      'convertHeifToJpegNode',
      'cropToSquare',
      'defaultTagParser',
      'deriveGeometry',
      'deriveOrientation',
      'encodeImageToBlurhash',
      'encodeUnderByteBudget',
      'extractExifFromHeif',
      'extractIccFromHeif',
      'generateOgpFromLandscape',
      'generateOgpImage',
      'generateShadowLayers',
      'generateSmartOgp',
      'insetOnSquare',
      'needsOrientationBake',
      'noTagParser',
      'normalizeBackgroundColor',
      'padToSquare',
      'padToSquareCentered',
      'parseExifDate',
      'photoVariantsPreset',
      'pickVariantWidths',
      'prepareImageForUpload',
      'processImages',
      'processOne',
      'removeBackground',
      'roundAspectRatio',
      'sampleBackgroundColor',
      'selectVariantWidths',
      'stripExif',
      'trimPadSquare',
    ].sort();

    expect(sortedKeys(root)).toEqual(expected);
  });

  it('resolves the ambiguous `deriveOrientation` name to exif\'s implementation', () => {
    // exif and browser each export a runtime `deriveOrientation`; the flat
    // `export *` barrel drops ambiguous names, so `src/index.ts` explicitly
    // re-exports exif's version (see the collision notes there). exif's
    // additionally validates and throws on non-finite/non-positive
    // dimensions, unlike browser's — that's the observable difference.
    expect(() => root.deriveOrientation(0, 100)).toThrow();
  });
});

describe('subpath module export surfaces', () => {
  it('./variants exposes exactly the expected names', () => {
    expect(sortedKeys(variants)).toEqual(
      [
        'DEFAULT_CACHE_FILENAME',
        'DEFAULT_CONCURRENCY',
        'DEFAULT_FORMATS',
        'DEFAULT_OGP_FILENAME',
        'DEFAULT_QUALITY',
        'DEFAULT_WIDTHS',
        'IMAGE_EXTENSION_REGEX',
        'PHOTO_VARIANT_WIDTHS',
        'SUPPORTED_IMAGE_EXTENSIONS',
        'VariantProcessingError',
        'defaultTagParser',
        'noTagParser',
        'photoVariantsPreset',
        'processImages',
        'processOne',
        'selectVariantWidths',
      ].sort(),
    );
  });

  it('./heif exposes exactly the expected names', () => {
    expect(sortedKeys(heif)).toEqual(
      ['convertHeifToJpeg', 'convertHeifToJpegNode', 'extractExifFromHeif', 'extractIccFromHeif'].sort(),
    );
  });

  it('./ogp exposes exactly the expected names', () => {
    expect(sortedKeys(ogp)).toEqual(
      ['generateOgpFromLandscape', 'generateOgpImage', 'generateSmartOgp'].sort(),
    );
  });

  it('./budget exposes exactly the expected names', () => {
    expect(sortedKeys(budget)).toEqual(['encodeUnderByteBudget']);
  });

  it('./square exposes exactly the expected names', () => {
    expect(sortedKeys(square)).toEqual(
      ['cropToSquare', 'insetOnSquare', 'padToSquare', 'padToSquareCentered', 'trimPadSquare'].sort(),
    );
  });

  it('./product-photo exposes exactly the expected names', () => {
    expect(sortedKeys(productPhoto)).toEqual(
      ['alphaTrim', 'composeProductPhoto', 'generateShadowLayers', 'removeBackground'].sort(),
    );
  });

  it('./calibrate exposes exactly the expected names', () => {
    expect(sortedKeys(calibrate)).toEqual(
      ['calibrateTargetFromSamples', 'normalizeBackgroundColor', 'sampleBackgroundColor'].sort(),
    );
  });

  it('./composite exposes exactly the expected names', () => {
    expect(sortedKeys(composite)).toEqual(['compositeBatch', 'compositeOverlay'].sort());
  });

  it('./blurhash exposes exactly the expected names', () => {
    expect(sortedKeys(blurhash)).toEqual(
      ['batchBlurhashToDataUri', 'blurhashToDataUri', 'encodeImageToBlurhash'].sort(),
    );
  });

  it('./exif exposes exactly the expected names', () => {
    expect(sortedKeys(exif)).toEqual(
      ['bakeOrientation', 'deriveOrientation', 'parseExifDate', 'pickVariantWidths', 'stripExif'].sort(),
    );
  });

  it('./browser exposes exactly the expected names', () => {
    expect(sortedKeys(browser)).toEqual(
      [
        'DEFAULT_MAX_CANVAS_AREA',
        'HEIC_DECODE_FAILED_MESSAGE',
        'MISSING_EXIFR_MESSAGE',
        'MISSING_HEIC2ANY_MESSAGE',
        'ORIENTATION_BAKE_FAILED_MESSAGE_PREFIX',
        'deriveGeometry',
        'deriveOrientation',
        'needsOrientationBake',
        'prepareImageForUpload',
        'roundAspectRatio',
      ].sort(),
    );
  });
});
