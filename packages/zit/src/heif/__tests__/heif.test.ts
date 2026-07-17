import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import sharp from 'sharp';
import exifr from 'exifr';
import {
  convertHeifToJpeg,
  convertHeifToJpegNode,
  extractExifFromHeif,
  extractIccFromHeif,
} from '../index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(__dirname, 'fixtures');
const TMAP_FIXTURE = path.join(FIXTURES_DIR, 'tmap-gainmap.heic');
const ROTATION_FIXTURE = path.join(FIXTURES_DIR, 'test-image-with-rotation.heic');
const EXPECTED_ICC = fs.readFileSync(path.join(FIXTURES_DIR, 'tmap-gainmap-expected.icc'));

let tmpDir: string;

// Shared decode results: several tests below assert different things about
// converting the *same* (fixture, options) pair through `convertHeifToJpegNode`.
// Each of those fixtures is a real, multi-megapixel HEIC (the rotation
// fixture alone is ~24MP), so re-decoding it once per assertion group was
// pushing this file close to vitest's 5s default per-test timeout under
// full-suite parallel load. Decoding each shared pair once in `beforeAll`
// and asserting on the cached result removes that redundant cost; tests
// that exercise a genuinely different code path (buffer-vs-path handling
// through the `sips`-or-Node wrapper, a shadowed-`sips` failure fallback)
// still perform their own decode and get an explicit generous timeout
// instead, since that cost is real and not falsely shared away.
let tmapResult: Awaited<ReturnType<typeof convertHeifToJpegNode>>;
let rotationResult: Awaited<ReturnType<typeof convertHeifToJpegNode>>;
let tmapBufferResult: Awaited<ReturnType<typeof convertHeifToJpegNode>>;

beforeAll(async () => {
  tmpDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'heif-test-'));
  tmapResult = await convertHeifToJpegNode(TMAP_FIXTURE, { quality: 90 });
  rotationResult = await convertHeifToJpegNode(ROTATION_FIXTURE, { quality: 90 });
  const tmapBuffer = await fsPromises.readFile(TMAP_FIXTURE);
  tmapBufferResult = await convertHeifToJpegNode(tmapBuffer);
}, 30_000);

afterAll(async () => {
  if (tmpDir) {
    await fsPromises.rm(tmpDir, { recursive: true, force: true });
  }
});

describe('extractIccFromHeif (real fixtures)', () => {
  // The golden tmap-gainmap-expected.icc is this parser's oracle for the
  // tmap (HDR gain-map) fixture.
  test('extracts the tmap fixture primary item ICC profile byte-identical to the golden reference', () => {
    const buffer = fs.readFileSync(TMAP_FIXTURE);
    const icc = extractIccFromHeif(buffer);

    expect(icc).not.toBeNull();
    expect(icc).toBeInstanceOf(Buffer);
    expect(icc!.length).toBe(536);
    expect(icc!.toString('latin1', 36, 40)).toBe('acsp');
    expect(icc!.equals(EXPECTED_ICC)).toBe(true);
  });

  test('extracts an ICC profile from the rotation fixture', () => {
    const buffer = fs.readFileSync(ROTATION_FIXTURE);
    const icc = extractIccFromHeif(buffer);

    expect(icc).not.toBeNull();
    expect(icc!.length).toBeGreaterThan(0);
    expect(icc!.toString('latin1', 36, 40)).toBe('acsp');
  });
});

describe('convertHeifToJpegNode (real fixtures)', () => {
  test('converts the tmap fixture to a JPEG at the expected dimensions with the ICC embedded byte-identically', async () => {
    const result = tmapResult;

    expect(result.width).toBe(3024);
    expect(result.height).toBe(3024);
    expect(result.iccApplied).toBe(true);
    expect(result.converter).toBe('node');

    const metadata = await sharp(result.buffer).metadata();
    expect(metadata.icc).toBeDefined();
    expect(Buffer.from(metadata.icc!).equals(EXPECTED_ICC)).toBe(true);
  });

  // Tone-map guard: golden channel means observed at implementation time
  // (heic-decode 2.1.0 / libheif-js 1.19.8, the exact pinned dependency
  // version) against the encoded JPEG's raw sample values -- this module
  // embeds the ICC profile as metadata (see embedIccProfileInJpeg) rather
  // than colour-transforming through it, so these means reflect the
  // decoder's tone-map output unaltered. Guards against a future
  // libheif-js bump silently changing the HDR->SDR tone-map — an
  // un-tone-mapped HDR decode shifts luma dramatically, which this would
  // catch.
  test('renders the tmap fixture HDR gain-map with the expected SDR tone-map (channel means)', async () => {
    const result = tmapResult;
    const stats = await sharp(result.buffer).stats();
    const means = stats.channels.map((c) => c.mean);
    const golden = [135.41, 124.73, 103.68];
    means.forEach((mean, i) => {
      expect(mean).toBeGreaterThan(golden[i] - 3);
      expect(mean).toBeLessThan(golden[i] + 3);
    });
  });

  test('converts the rotation fixture to a JPEG at the expected dimensions', async () => {
    const result = rotationResult;

    expect(result.width).toBe(4284);
    expect(result.height).toBe(5712);
    expect(result.iccApplied).toBe(true);

    const metadata = await sharp(result.buffer).metadata();
    expect(metadata.format).toBe('jpeg');
    expect(metadata.width).toBe(4284);
    expect(metadata.height).toBe(5712);
  });

  test('accepts a Buffer input, not just a file path', () => {
    // Shares the decode with the "default 256 MiB bound" test below —
    // both call convertHeifToJpegNode with a Buffer and default options.
    expect(tmapBufferResult.width).toBe(3024);
    expect(tmapBufferResult.height).toBe(3024);
  });
});

describe('Node fallback retains source EXIF (#36)', () => {
  test('extractExifFromHeif pulls a TIFF-format EXIF block from an EXIF-bearing fixture', () => {
    const buffer = fs.readFileSync(TMAP_FIXTURE);
    const tiff = extractExifFromHeif(buffer);

    expect(tiff).not.toBeNull();
    expect(['II', 'MM']).toContain(tiff!.toString('latin1', 0, 2));
  });

  test('Node-fallback JPEG output carries the source EXIF tags', async () => {
    const source = await exifr.parse(TMAP_FIXTURE, ['Make', 'Model', 'DateTimeOriginal']);
    expect(source.Make).toBe('Apple'); // fixture sanity: the source really has EXIF

    const output = await exifr.parse(tmapResult.buffer, ['Make', 'Model', 'DateTimeOriginal']);

    expect(output.Make).toBe(source.Make);
    expect(output.Model).toBe(source.Model);
    expect(output.DateTimeOriginal).toEqual(source.DateTimeOriginal);
  });

  test('EXIF Orientation in the output is neutralised to 1 (decoder already applied irot/imir)', async () => {
    const result = rotationResult;

    // decoded pixels are already display-oriented (portrait)
    expect(result.width).toBe(4284);
    expect(result.height).toBe(5712);

    const metadata = await sharp(result.buffer).metadata();
    expect(metadata.exif).toBeDefined();
    expect(metadata.orientation ?? 1).toBe(1);
  });
});

describe('convertHeifToJpeg (wrapper, real fixture)', () => {
  // Each test in this describe block exercises the sips-or-Node wrapper
  // itself (a genuinely different code path from convertHeifToJpegNode
  // above) with a real fixture decode, so its cost isn't shareable via
  // beforeAll. An explicit generous timeout replaces vitest's 5s default,
  // which a full-megapixel decode can approach under full-suite parallel
  // load.
  test('succeeds end-to-end via the sips-or-Node wrapper', { timeout: 30_000 }, async () => {
    // On Linux (this test environment) `sips` doesn't exist, so this
    // exercises the sips-ENOENT -> Node fallback path. On macOS it would
    // exercise sips directly. Both are valid outcomes for this test.
    const result = await convertHeifToJpeg(TMAP_FIXTURE, { quality: 90 });

    expect(['sips', 'node']).toContain(result.converter);
    const metadata = await sharp(result.buffer).metadata();
    expect(metadata.width).toBe(3024);
    expect(metadata.height).toBe(3024);
  });

  test(
    'accepts a Buffer input directly (skips the sips path, which requires a file path)',
    { timeout: 30_000 },
    async () => {
      const inputBuffer = await fsPromises.readFile(ROTATION_FIXTURE);
      const result = await convertHeifToJpeg(inputBuffer, { quality: 90 });

      expect(result.width).toBe(4284);
      expect(result.height).toBe(5712);
    },
  );
});

describe('hardening: sips failure (not just ENOENT) falls back to Node', () => {
  // Simulates the documented case where `sips` is present but refuses a
  // valid HDR gain-map HEIC (the auxiliary-image-reference limit) by
  // shadowing `sips` on PATH with a script that always exits non-zero.
  // Before the fix, any non-ENOENT sips failure was rethrown, defeating
  // the fallback for exactly the files it exists to support.
  let fakeSipsDir: string;
  let originalPath: string | undefined;

  beforeAll(async () => {
    fakeSipsDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'fake-sips-'));
    const fakeSipsPath = path.join(fakeSipsDir, 'sips');
    await fsPromises.writeFile(
      fakeSipsPath,
      '#!/bin/sh\necho "too many auxiliary image references" >&2\nexit 1\n',
    );
    await fsPromises.chmod(fakeSipsPath, 0o755);
    originalPath = process.env.PATH;
    process.env.PATH = `${fakeSipsDir}:${originalPath ?? ''}`;
  });

  afterAll(async () => {
    process.env.PATH = originalPath;
    await fsPromises.rm(fakeSipsDir, { recursive: true, force: true });
  });

  test(
    'convertHeifToJpeg still succeeds via the Node fallback when sips fails non-ENOENT',
    { timeout: 30_000 },
    async () => {
      const result = await convertHeifToJpeg(TMAP_FIXTURE, { quality: 90 });

      expect(result.width).toBe(3024);
      expect(result.height).toBe(3024);
      expect(result.iccApplied).toBe(true);
      expect(result.converter).toBe('node');
    },
  );
});

describe('hardening: maxInputBytes', () => {
  test('convertHeifToJpeg rejects an input larger than maxInputBytes before decoding', async () => {
    const oversized = Buffer.alloc(1024);
    await expect(convertHeifToJpeg(oversized, { maxInputBytes: 100 })).rejects.toThrow(
      /maxInputBytes/,
    );
  });

  test('convertHeifToJpegNode rejects a file input larger than maxInputBytes before reading it', async () => {
    await expect(
      convertHeifToJpegNode(TMAP_FIXTURE, { maxInputBytes: 100 }),
    ).rejects.toThrow(/maxInputBytes/);
  });

  test('does not reject inputs within the default 256 MiB bound', () => {
    // Shares the decode with "accepts a Buffer input" above.
    expect(tmapBufferResult).toBeDefined();
  });
});

describe('hardening: malformed/truncated input', () => {
  test('convertHeifToJpegNode throws cleanly (not a hang) on a non-HEIC buffer', async () => {
    const garbage = Buffer.from('this is definitely not a heic file, just plain text bytes');
    await expect(convertHeifToJpegNode(garbage)).rejects.toThrow();
  });

  test('convertHeifToJpegNode throws cleanly (not a hang) on an empty buffer', async () => {
    await expect(convertHeifToJpegNode(Buffer.alloc(0))).rejects.toThrow();
  });

  test('convertHeifToJpegNode throws cleanly (not a hang) on a truncated real fixture', async () => {
    const full = await fsPromises.readFile(TMAP_FIXTURE);
    const truncated = full.subarray(0, 64);
    await expect(convertHeifToJpegNode(truncated)).rejects.toThrow();
  });
});

describe('extractIccFromHeif (synthetic box-parser edge cases)', () => {
  function box(type: string, body: Buffer): Buffer {
    const size = 8 + body.length;
    const buf = Buffer.alloc(size);
    buf.writeUInt32BE(size, 0);
    buf.write(type, 4, 'latin1');
    body.copy(buf, 8);
    return buf;
  }

  function fullBoxBody(version: number, flags: number, rest: Buffer): Buffer {
    const head = Buffer.alloc(4);
    head.writeUInt8(version, 0);
    head.writeUIntBE(flags, 1, 3);
    return Buffer.concat([head, rest]);
  }

  function buildPitm(itemId: number, version = 0): Buffer {
    let rest: Buffer;
    if (version === 0) {
      rest = Buffer.alloc(2);
      rest.writeUInt16BE(itemId, 0);
    } else {
      rest = Buffer.alloc(4);
      rest.writeUInt32BE(itemId, 0);
    }
    return box('pitm', fullBoxBody(version, 0, rest));
  }

  function buildColrNclx(): Buffer {
    return box('colr', Buffer.concat([Buffer.from('nclx', 'latin1'), Buffer.alloc(7)]));
  }

  function buildColrProf(iccData: Buffer): Buffer {
    return box('colr', Buffer.concat([Buffer.from('prof', 'latin1'), iccData]));
  }

  function buildIpco(children: Buffer[]): Buffer {
    return box('ipco', Buffer.concat(children));
  }

  // entries: [{ itemId, indices }]; version/flags control the ipma entry
  // layout: version < 1 -> 16-bit item id, version >= 1 -> 32-bit item id;
  // flags&1 -> 15-bit (2-byte) property index, else 7-bit (1-byte) index.
  function buildIpma(
    entries: { itemId: number; indices: number[] }[],
    version = 0,
    flags = 0,
  ): Buffer {
    const parts: Buffer[] = [];
    const head = Buffer.alloc(4);
    head.writeUInt32BE(entries.length, 0);
    parts.push(head);
    for (const entry of entries) {
      const idBuf = Buffer.alloc(version < 1 ? 2 : 4);
      if (version < 1) idBuf.writeUInt16BE(entry.itemId, 0);
      else idBuf.writeUInt32BE(entry.itemId, 0);
      const countBuf = Buffer.alloc(1);
      countBuf.writeUInt8(entry.indices.length, 0);
      parts.push(idBuf, countBuf);
      for (const idx of entry.indices) {
        if (flags & 1) {
          const idxBuf = Buffer.alloc(2);
          idxBuf.writeUInt16BE(idx & 0x7fff, 0);
          parts.push(idxBuf);
        } else {
          const idxBuf = Buffer.alloc(1);
          idxBuf.writeUInt8(idx & 0x7f, 0);
          parts.push(idxBuf);
        }
      }
    }
    return box('ipma', fullBoxBody(version, flags, Buffer.concat(parts)));
  }

  function buildIprp(ipco: Buffer, ipma: Buffer): Buffer {
    return box('iprp', Buffer.concat([ipco, ipma]));
  }

  function buildMeta(pitm: Buffer, iprp: Buffer): Buffer {
    const fullBoxHead = Buffer.alloc(4); // meta version+flags = 0
    return box('meta', Buffer.concat([fullBoxHead, pitm, iprp]));
  }

  // Builds a minimal well-formed meta box wrapping a single colr property
  // associated with the primary item.
  function buildHeicWithColr(
    colrBox: Buffer,
    { itemId = 1, ipmaVersion = 0, ipmaFlags = 0 } = {},
  ): Buffer {
    const pitm = buildPitm(itemId, 0);
    const ipco = buildIpco([colrBox]);
    const ipma = buildIpma([{ itemId, indices: [1] }], ipmaVersion, ipmaFlags);
    const iprp = buildIprp(ipco, ipma);
    return buildMeta(pitm, iprp);
  }

  test('returns null for an nclx-only colr property (no embedded profile)', () => {
    const buffer = buildHeicWithColr(buildColrNclx());
    expect(extractIccFromHeif(buffer)).toBeNull();
  });

  test('returns null (not a hang or an uncaught error) for a truncated buffer', () => {
    const full = buildHeicWithColr(buildColrProf(Buffer.from('fake-icc-data')));
    const truncated = full.subarray(0, full.length - 5);
    expect(() => extractIccFromHeif(truncated)).not.toThrow();
    expect(extractIccFromHeif(truncated)).toBeNull();
  });

  test('returns null (not a hang or an uncaught error) for a box whose size field lies', () => {
    const buffer = Buffer.from(buildHeicWithColr(buildColrProf(Buffer.from('fake-icc-data'))));
    buffer.writeUInt32BE(0xffffffff, 0); // outer meta box declares an impossible size
    expect(() => extractIccFromHeif(buffer)).not.toThrow();
    expect(extractIccFromHeif(buffer)).toBeNull();
  });

  test('returns null (not a hang or an uncaught error) for an empty buffer', () => {
    expect(() => extractIccFromHeif(Buffer.alloc(0))).not.toThrow();
    expect(extractIccFromHeif(Buffer.alloc(0))).toBeNull();
  });

  test('resolves ipma version 0 (16-bit item id, 1-byte index, flags=0)', () => {
    const icc = Buffer.from('fake-icc-data-v0');
    const buffer = buildHeicWithColr(buildColrProf(icc), { ipmaVersion: 0, ipmaFlags: 0 });
    const result = extractIccFromHeif(buffer);
    expect(result).not.toBeNull();
    expect(result!.equals(icc)).toBe(true);
  });

  test('resolves ipma version 1 with flags&1 (32-bit item id, 2-byte 15-bit index)', () => {
    const icc = Buffer.from('fake-icc-data-v1-flags1');
    const buffer = buildHeicWithColr(buildColrProf(icc), { ipmaVersion: 1, ipmaFlags: 1 });
    const result = extractIccFromHeif(buffer);
    expect(result).not.toBeNull();
    expect(result!.equals(icc)).toBe(true);
  });

  test('resolves ipma version 1 with flags=0 (32-bit item id, 1-byte index)', () => {
    const icc = Buffer.from('fake-icc-data-v1-flags0');
    const buffer = buildHeicWithColr(buildColrProf(icc), { ipmaVersion: 1, ipmaFlags: 0 });
    const result = extractIccFromHeif(buffer);
    expect(result).not.toBeNull();
    expect(result!.equals(icc)).toBe(true);
  });
});
