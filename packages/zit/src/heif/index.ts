/**
 * Node-native HEIC/HEIF -> JPEG conversion, with a dependency-free ISOBMFF
 * ICC-profile extractor.
 *
 * TRUSTED-INPUT ONLY: the Node/WASM fallback decoder (`heic-decode` ->
 * bundled `libheif-js` 1.19.8) predates the libheif 1.22.0 fixes for
 * CVE-2026-32740 (heap overflow) and CVE-2026-32739 (infinite-loop DoS).
 * Only decode HEIC/HEIF files from sources you trust. The decoder runs
 * inside a WASM sandbox and `maxInputBytes` rejects oversized inputs
 * before they reach it, but both are defense-in-depth, not a substitute
 * for trusting the source. Bump `heic-decode` once its bundled
 * `libheif-js` reaches >= 1.22.0.
 *
 * Why the box parser: `libheif-js` 1.19.8's high-level ICC API
 * (`heif_image_handle_get_color_profile_type` et al.) is broken and
 * reports "not present" even when a profile exists, so the ICC profile is
 * pulled directly out of the container's meta/iprp/ipco/ipma boxes
 * instead.
 *
 * Why the sips/Node split exists at all: system libheif (what macOS
 * `sips` and sharp's bundled libvips use) can predate 1.18.0 and
 * hardcodes a strict security limit on auxiliary-image references, which
 * rejects the HDR "gain map" (`tmap` compatible-brand) HEIC files emitted
 * by recent iPhone/Android cameras ("Too many auxiliary image
 * references"). `sips` is tried first on macOS for speed with no extra
 * deps; the Node fallback's bundled WASM `libheif-js` doesn't carry that
 * limit, so it also serves as the fallback wherever `sips` is
 * unavailable.
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import sharp from 'sharp';

const execFileAsync = promisify(execFile);

const DEFAULT_QUALITY = 90;
const DEFAULT_MAX_INPUT_BYTES = 256 * 1024 * 1024;

export interface ConvertHeifToJpegOptions {
  /** JPEG encode quality, 1-100. @default 90 */
  quality?: number;
  /** Reject inputs larger than this many bytes before decoding. @default 268435456 (256 MiB) */
  maxInputBytes?: number;
}

export interface ConvertHeifResult {
  buffer: Buffer;
  width: number;
  height: number;
  iccApplied: boolean;
}

async function inputByteLength(input: string | Buffer): Promise<number> {
  if (typeof input === 'string') {
    return (await fs.stat(input)).size;
  }
  return input.length;
}

async function assertWithinSizeBound(
  input: string | Buffer,
  maxInputBytes: number,
): Promise<void> {
  const size = await inputByteLength(input);
  if (size > maxInputBytes) {
    throw new Error(`HEIF input of ${size} bytes exceeds maxInputBytes (${maxInputBytes})`);
  }
}

/**
 * Convert a HEIF/HEIC source to JPEG.
 *
 * Primary path: macOS `sips`, tried only when `input` is a file path —
 * feature-detected via `execFile`'s ENOENT (never a shell string, so
 * paths containing spaces or shell metacharacters pass through
 * unmangled). Fallback (non-macOS, `sips` missing, or `input` is a
 * Buffer): {@link convertHeifToJpegNode}. Any other `sips` failure (e.g.
 * a genuinely corrupt file on macOS) is rethrown unchanged.
 */
export async function convertHeifToJpeg(
  input: string | Buffer,
  opts: ConvertHeifToJpegOptions = {},
): Promise<ConvertHeifResult> {
  const quality = opts.quality ?? DEFAULT_QUALITY;
  const maxInputBytes = opts.maxInputBytes ?? DEFAULT_MAX_INPUT_BYTES;
  await assertWithinSizeBound(input, maxInputBytes);

  if (typeof input === 'string') {
    const sipsResult = await tryConvertWithSips(input, quality);
    if (sipsResult) return sipsResult;
  }

  try {
    return await convertHeifToJpegNode(input, { quality, maxInputBytes });
  } catch (nodeError) {
    const reason =
      typeof input === 'string'
        ? "'sips' is unavailable (non-macOS) and the Node fallback also failed"
        : 'the Node fallback failed';
    throw new Error(
      `HEIF conversion failed: ${reason}. Original error: ${(nodeError as Error).message}`,
    );
  }
}

/**
 * Try converting via macOS `sips`. Returns null when `sips` isn't present
 * (ENOENT) so the caller can fall back to the Node path; any other error
 * (e.g. a genuinely corrupt file) is rethrown unchanged.
 */
async function tryConvertWithSips(
  inputPath: string,
  quality: number,
): Promise<ConvertHeifResult | null> {
  const outPath = path.join(os.tmpdir(), `heif-sips-${process.pid}-${Date.now()}.jpg`);
  try {
    await execFileAsync('sips', [
      '-s',
      'format',
      'jpeg',
      '-s',
      'formatOptions',
      String(quality),
      inputPath,
      '--out',
      outPath,
    ]);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw error;
  }

  try {
    const buffer = await fs.readFile(outPath);
    const metadata = await sharp(buffer).metadata();
    return {
      buffer,
      width: metadata.width ?? 0,
      height: metadata.height ?? 0,
      iccApplied: Boolean(metadata.icc),
    };
  } finally {
    await fs.rm(outPath, { force: true });
  }
}

/**
 * Node-native HEIF/HEIC -> JPEG conversion: decode via `heic-decode`
 * (`libheif-js` WASM), extract the source ICC profile via
 * {@link extractIccFromHeif}, and encode via sharp.
 *
 * `heic-decode` is imported lazily so its WASM decoder only loads on this
 * fallback path, not on every `sips`-capable macOS call.
 *
 * Known limitation: `heic-decode`'s default export decodes the first
 * top-level image in the container, not necessarily the item marked
 * primary in the `pitm` box (which is what {@link extractIccFromHeif}
 * targets). This is a non-issue for single-image consumer photos,
 * including HDR gain-map ("tmap") files, whose gain map is an auxiliary
 * image reference on the same item rather than a separate top-level
 * image — but a multi-image container whose primary item isn't first
 * would decode the wrong image while attaching the correct image's ICC
 * profile to it.
 */
export async function convertHeifToJpegNode(
  input: string | Buffer,
  opts: ConvertHeifToJpegOptions = {},
): Promise<ConvertHeifResult> {
  const quality = opts.quality ?? DEFAULT_QUALITY;
  const maxInputBytes = opts.maxInputBytes ?? DEFAULT_MAX_INPUT_BYTES;
  await assertWithinSizeBound(input, maxInputBytes);

  const buffer = typeof input === 'string' ? await fs.readFile(input) : input;
  const { default: decode } = await import('heic-decode');
  const { width, height, data } = await decode({ buffer });
  const icc = extractIccFromHeif(buffer); // null for nclx-only files

  let pipeline = sharp(Buffer.from(data.buffer, data.byteOffset, data.byteLength), {
    raw: { width, height, channels: 4 },
  }).removeAlpha();

  let iccTmp: string | null = null;
  try {
    if (icc) {
      // sharp .withIccProfile() takes a filesystem path -- write the extracted
      // profile to a tmpdir file rather than beside the source input.
      iccTmp = path.join(os.tmpdir(), `heif-icc-${process.pid}-${Date.now()}.icc`);
      await fs.writeFile(iccTmp, icc);
      pipeline = pipeline.withIccProfile(iccTmp);
    }
    const outBuffer = await pipeline.jpeg({ quality }).toBuffer();
    return { buffer: outBuffer, width, height, iccApplied: icc !== null };
  } finally {
    if (iccTmp) await fs.rm(iccTmp, { force: true });
  }
}

// ---- ISOBMFF box parser --------------------------------------------------

interface Box {
  type: string;
  start: number;
  header: number;
  size: number;
  bodyStart: number;
  bodyEnd: number;
}

/**
 * Walk sibling ISOBMFF boxes in b[start, end), yielding each box's type
 * and bounds. Hardened against malformed/truncated input: any box whose
 * declared size doesn't fit within [start, end) stops the walk instead of
 * looping or reading out of bounds.
 */
function* walkBoxes(b: Buffer, start: number, end: number): Generator<Box> {
  let off = start;
  while (off + 8 <= end) {
    let size = b.readUInt32BE(off);
    const type = b.toString('latin1', off + 4, off + 8);
    let header = 8;
    if (size === 1) {
      if (off + 16 > end) break;
      size = Number(b.readBigUInt64BE(off + 8));
      header = 16;
    } else if (size === 0) {
      size = end - off;
    }
    if (size < header || off + size > end) break;
    yield { type, start: off, header, size, bodyStart: off + header, bodyEnd: off + size };
    off += size;
  }
}

function findBox(b: Buffer, start: number, end: number, type: string): Box | null {
  for (const box of walkBoxes(b, start, end)) {
    if (box.type === type) return box;
  }
  return null;
}

/**
 * Extract the ICC profile associated with a HEIF file's primary item, by
 * walking meta/pitm (primary item id) and meta/iprp/{ipco,ipma} (item
 * properties + their associations) to find the primary item's `colr` box.
 *
 * Returns the ICC profile bytes when the primary item has a `colr` box of
 * type `prof`/`rICC`, or null when it doesn't (e.g. nclx-only files, or
 * any structurally unexpected/malformed box layout). Never throws: any
 * out-of-bounds read on a malformed/truncated box layout is caught and
 * surfaces as "no ICC available" instead of an uncaught RangeError.
 *
 * Known limitation: only the first `ipma` box under `iprp` is consulted
 * (ISOBMFF technically permits more than one). Every real-world file this
 * was validated against — including camera-generated HDR gain-map files
 * — carries a single ipma box, so this hasn't been a problem in practice.
 */
export function extractIccFromHeif(b: Buffer): Buffer | null {
  try {
    const meta = findBox(b, 0, b.length, 'meta');
    if (!meta) return null;
    const metaBody = meta.bodyStart + 4; // meta is a FullBox: skip version+flags

    const pitm = findBox(b, metaBody, meta.bodyEnd, 'pitm');
    if (!pitm) return null;
    const pitmVersion = b.readUInt8(pitm.bodyStart);
    const primaryItemId =
      pitmVersion === 0 ? b.readUInt16BE(pitm.bodyStart + 4) : b.readUInt32BE(pitm.bodyStart + 4);

    const iprp = findBox(b, metaBody, meta.bodyEnd, 'iprp');
    if (!iprp) return null;
    const ipco = findBox(b, iprp.bodyStart, iprp.bodyEnd, 'ipco');
    if (!ipco) return null;

    // ipco children in order; property indices in ipma are 1-based into this list
    const properties = [...walkBoxes(b, ipco.bodyStart, ipco.bodyEnd)];

    const ipma = findBox(b, iprp.bodyStart, iprp.bodyEnd, 'ipma');
    if (!ipma) return null;
    const ipmaVersion = b.readUInt8(ipma.bodyStart);
    const ipmaFlags = b.readUIntBE(ipma.bodyStart + 1, 3);
    let p = ipma.bodyStart + 4;
    const entryCount = b.readUInt32BE(p);
    p += 4;
    let primaryPropIndices: number[] | null = null;
    for (let i = 0; i < entryCount; i++) {
      const itemId = ipmaVersion < 1 ? b.readUInt16BE(p) : b.readUInt32BE(p);
      p += ipmaVersion < 1 ? 2 : 4;
      const assocCount = b.readUInt8(p);
      p += 1;
      const indices: number[] = [];
      for (let j = 0; j < assocCount; j++) {
        let index: number;
        if (ipmaFlags & 1) {
          index = b.readUInt16BE(p) & 0x7fff;
          p += 2;
        } else {
          index = b.readUInt8(p) & 0x7f;
          p += 1;
        }
        indices.push(index);
      }
      if (itemId === primaryItemId) primaryPropIndices = indices;
    }
    if (!primaryPropIndices) return null;

    for (const idx of primaryPropIndices) {
      const prop = properties[idx - 1]; // 1-based
      if (prop && prop.type === 'colr') {
        const colourType = b.toString('latin1', prop.bodyStart, prop.bodyStart + 4);
        if (colourType === 'prof' || colourType === 'rICC') {
          return b.subarray(prop.bodyStart + 4, prop.bodyEnd);
        }
      }
    }
    return null;
  } catch {
    return null;
  }
}
