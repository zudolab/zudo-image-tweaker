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
 * instead. It is then spliced into the output JPEG as a raw APP2 marker
 * (see `embedIccProfileInJpeg`) rather than handed to sharp's
 * `withIccProfile()`, which performs a colour-managed transform from the
 * (assumed sRGB) input to the target profile -- since the decoded pixels
 * are already in the space the extracted profile describes, that would
 * alter already-correct sample values instead of just tagging them.
 *
 * Why the sips/Node split exists at all: system libheif (what macOS
 * `sips` and sharp's bundled libvips use) can predate 1.18.0 and
 * hardcodes a strict security limit on auxiliary-image references, which
 * rejects the HDR "gain map" (`tmap` compatible-brand) HEIC files emitted
 * by recent iPhone/Android cameras ("Too many auxiliary image
 * references"). `sips` is tried first on macOS for speed with no extra
 * deps; the Node fallback's bundled WASM `libheif-js` doesn't carry that
 * limit, so it also serves as the fallback whenever `sips` is unavailable
 * OR fails on a given input (including that documented limitation).
 */

import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
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
 * unmangled). Fallback (non-macOS, `sips` missing, `sips` fails for any
 * reason -- including the documented auxiliary-image-reference limit on
 * HDR gain-map files -- or `input` is a Buffer): {@link
 * convertHeifToJpegNode}. If both paths fail, the thrown error includes
 * both underlying failures.
 */
export async function convertHeifToJpeg(
  input: string | Buffer,
  opts: ConvertHeifToJpegOptions = {},
): Promise<ConvertHeifResult> {
  const quality = opts.quality ?? DEFAULT_QUALITY;
  const maxInputBytes = opts.maxInputBytes ?? DEFAULT_MAX_INPUT_BYTES;
  await assertWithinSizeBound(input, maxInputBytes);

  let sipsError: Error | null = null;
  if (typeof input === 'string') {
    const sipsOutcome = await tryConvertWithSips(input, quality);
    if (sipsOutcome.result) return sipsOutcome.result;
    sipsError = sipsOutcome.error;
  }

  try {
    return await convertHeifToJpegNode(input, { quality, maxInputBytes });
  } catch (nodeError) {
    const sipsReason =
      typeof input === 'string'
        ? sipsError
          ? `'sips' failed (${sipsError.message})`
          : "'sips' is unavailable (non-macOS)"
        : null;
    const reasons = [sipsReason, `the Node fallback also failed: ${(nodeError as Error).message}`]
      .filter(Boolean)
      .join(' and ');
    throw new Error(`HEIF conversion failed: ${reasons}.`);
  }
}

interface SipsOutcome {
  result: ConvertHeifResult | null;
  /** Non-null only when `sips` ran but failed for a reason other than being absent. */
  error: Error | null;
}

/**
 * Try converting via macOS `sips`. Returns a null result when `sips`
 * isn't present (ENOENT) or fails for any other reason (e.g. the
 * documented auxiliary-image-reference limit, or a genuinely corrupt
 * file) so the caller always falls back to the Node path; `error` carries
 * the non-ENOENT failure for diagnostics if the Node path also fails.
 */
async function tryConvertWithSips(inputPath: string, quality: number): Promise<SipsOutcome> {
  // randomUUID (not just pid+timestamp) avoids output-path collisions
  // between concurrent conversions in the same process.
  const outPath = path.join(os.tmpdir(), `heif-sips-${process.pid}-${randomUUID()}.jpg`);
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
    // A non-zero `sips` exit can still leave a partial `outPath` on disk
    // (e.g. the documented gain-map failure). This early return skips the
    // cleanup `finally` below, so remove it here too — otherwise repeated
    // fallbacks accumulate temp JPEGs. `force` no-ops when nothing was
    // written (including the ENOENT "sips absent" case).
    await fs.rm(outPath, { force: true });
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { result: null, error: null };
    }
    return { result: null, error: error as Error };
  }

  try {
    const buffer = await fs.readFile(outPath);
    const metadata = await sharp(buffer).metadata();
    return {
      result: {
        buffer,
        width: metadata.width ?? 0,
        height: metadata.height ?? 0,
        iccApplied: Boolean(metadata.icc),
      },
      error: null,
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

  const jpegBuffer = await sharp(Buffer.from(data.buffer, data.byteOffset, data.byteLength), {
    raw: { width, height, channels: 4 },
  })
    .removeAlpha()
    .jpeg({ quality })
    .toBuffer();

  const outBuffer = icc ? embedIccProfileInJpeg(jpegBuffer, icc) : jpegBuffer;
  return { buffer: outBuffer, width, height, iccApplied: icc !== null };
}

const ICC_APP2_IDENTIFIER = Buffer.from('ICC_PROFILE\0', 'latin1');
// Max APP2 marker segment size is 0xFFFF, which includes the 2-byte length
// field itself (but not the 2-byte marker code) -- subtract the length
// field, identifier, sequence number, and marker count to get the max ICC
// payload per chunk.
const MAX_ICC_CHUNK_BYTES = 0xffff - 2 - ICC_APP2_IDENTIFIER.length - 1 - 1;

/**
 * Embed an ICC profile into a JPEG buffer as APP2 marker segment(s),
 * chunked per the ICC-in-JPEG convention (ICC.1:2010 Annex B) for
 * profiles too large for a single marker segment. This splices the
 * profile bytes in directly as metadata rather than asking sharp to
 * `.withIccProfile()` it -- see the module-level doc comment for why.
 */
function embedIccProfileInJpeg(jpeg: Buffer, icc: Buffer): Buffer {
  if (jpeg.length < 2 || jpeg[0] !== 0xff || jpeg[1] !== 0xd8) {
    throw new Error('Expected a JPEG buffer starting with the SOI marker');
  }

  const chunkCount = Math.max(1, Math.ceil(icc.length / MAX_ICC_CHUNK_BYTES));
  const segments: Buffer[] = [];
  for (let i = 0; i < chunkCount; i++) {
    const chunk = icc.subarray(i * MAX_ICC_CHUNK_BYTES, (i + 1) * MAX_ICC_CHUNK_BYTES);
    const segmentLength = 2 + ICC_APP2_IDENTIFIER.length + 1 + 1 + chunk.length;
    const header = Buffer.alloc(4 + ICC_APP2_IDENTIFIER.length + 2);
    header.writeUInt8(0xff, 0);
    header.writeUInt8(0xe2, 1);
    header.writeUInt16BE(segmentLength, 2);
    ICC_APP2_IDENTIFIER.copy(header, 4);
    header.writeUInt8(i + 1, 4 + ICC_APP2_IDENTIFIER.length);
    header.writeUInt8(chunkCount, 4 + ICC_APP2_IDENTIFIER.length + 1);
    segments.push(header, chunk);
  }

  return Buffer.concat([jpeg.subarray(0, 2), ...segments, jpeg.subarray(2)]);
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
