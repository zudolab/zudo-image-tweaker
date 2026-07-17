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
 * `ConvertHeifResult.converter` reports which path produced the output.
 *
 * Residual Node-fallback divergence from `sips`: files whose wide-gamut
 * colour is described only by an `nclx` colr box (no embedded ICC
 * profile) lose that colour description on the Node path — the output
 * JPEG carries no ICC profile and decodes as sRGB. `sips` converts such
 * files through the system colour engine and tags the output itself.
 * Source EXIF, previously also lost on this path, is now copied into the
 * output (see `extractExifFromHeif`), with the EXIF Orientation tag
 * neutralised to 1 because the WASM decoder already applies the
 * container's irot/imir transforms to the pixels.
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
// Same default as the shared variants runner (src/variants/run.ts): long
// enough for a real conversion, short enough that a hung `sips` process
// can't stall a caller forever — it always has the Node/WASM fallback to
// fall through to (issue #67).
const DEFAULT_SIPS_TIMEOUT_MS = 60_000;
// sharp's default limitInputPixels (0x3FFF * 0x3FFF). The Node path checks
// the container's declared dimensions against this BEFORE the WASM decode,
// because a tiny crafted HEIC declaring huge dimensions would otherwise
// force a multi-GB allocation inside the decoder before sharp's own pixel
// limit ever gets a chance to apply.
const DEFAULT_MAX_DECODE_PIXELS = 0x3fff * 0x3fff;

export interface ConvertHeifToJpegOptions {
  /** JPEG encode quality, 1-100. @default 90 */
  quality?: number;
  /** Reject inputs larger than this many bytes before decoding. @default 268435456 (256 MiB) */
  maxInputBytes?: number;
  /**
   * Node path only: reject inputs whose container declares more pixels
   * than this before the WASM decode. @default 268402689 (sharp's default
   * limitInputPixels, 0x3FFF x 0x3FFF)
   */
  maxDecodePixels?: number;
  /**
   * `sips` path only: kill the `sips` subprocess if it hasn't exited after
   * this many ms, falling back to the Node/WASM path. @default 60000
   */
  sipsTimeoutMs?: number;
}

export interface ConvertHeifResult {
  buffer: Buffer;
  width: number;
  height: number;
  iccApplied: boolean;
  /**
   * Which conversion path produced the output: macOS `sips`, or the
   * Node/WASM fallback. The fallback diverges from `sips` for nclx-only
   * wide-gamut files (see the module doc comment), so callers that care
   * can detect it here.
   */
  converter: 'sips' | 'node';
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
  const maxDecodePixels = opts.maxDecodePixels ?? DEFAULT_MAX_DECODE_PIXELS;
  const sipsTimeoutMs = opts.sipsTimeoutMs ?? DEFAULT_SIPS_TIMEOUT_MS;
  await assertWithinSizeBound(input, maxInputBytes);

  let sipsError: Error | null = null;
  if (typeof input === 'string') {
    const sipsOutcome = await tryConvertWithSips(input, quality, sipsTimeoutMs);
    if (sipsOutcome.result) return sipsOutcome.result;
    sipsError = sipsOutcome.error;
  }

  try {
    return await convertHeifToJpegNode(input, { quality, maxInputBytes, maxDecodePixels });
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
async function tryConvertWithSips(
  inputPath: string,
  quality: number,
  timeoutMs: number,
): Promise<SipsOutcome> {
  // randomUUID (not just pid+timestamp) avoids output-path collisions
  // between concurrent conversions in the same process.
  const outPath = path.join(os.tmpdir(), `heif-sips-${process.pid}-${randomUUID()}.jpg`);
  // Resolved before it reaches `sips`' argv so a bare leading-dash relative
  // filename (e.g. `-rf.heic`) can never be parsed as an option flag
  // (issue #66).
  const resolvedInputPath = path.resolve(inputPath);
  try {
    await execFileAsync(
      'sips',
      [
        '-s',
        'format',
        'jpeg',
        '-s',
        'formatOptions',
        String(quality),
        resolvedInputPath,
        '--out',
        outPath,
      ],
      { timeout: timeoutMs, killSignal: 'SIGTERM' },
    );
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
        converter: 'sips',
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
  const maxDecodePixels = opts.maxDecodePixels ?? DEFAULT_MAX_DECODE_PIXELS;
  await assertWithinSizeBound(input, maxInputBytes);

  const buffer = typeof input === 'string' ? await fs.readFile(input) : input;
  assertDeclaredPixelsWithinBound(buffer, maxDecodePixels);
  const { default: decode } = await import('heic-decode');
  const { width, height, data } = await decode({ buffer });
  // null for nclx-only files; a crafted colr box larger than what fits in
  // 255 APP2 chunks is malformed by definition (real profiles are KBs), so
  // degrade to "no ICC" instead of letting the chunk counter overflow.
  const icc = extractIccFromHeif(buffer);
  const embeddableIcc = icc !== null && icc.length <= MAX_EMBEDDABLE_ICC_BYTES ? icc : null;
  const exif = extractExifFromHeif(buffer);

  const jpegBuffer = await sharp(Buffer.from(data.buffer, data.byteOffset, data.byteLength), {
    raw: { width, height, channels: 4 },
  })
    .removeAlpha()
    .jpeg({ quality })
    .toBuffer();

  let outBuffer: Buffer = jpegBuffer;
  if (embeddableIcc) outBuffer = embedIccProfileInJpeg(outBuffer, embeddableIcc);
  if (exif) outBuffer = embedExifInJpeg(outBuffer, exif);
  return {
    buffer: outBuffer,
    width,
    height,
    iccApplied: embeddableIcc !== null,
    converter: 'node',
  };
}

/**
 * Reject a HEIF whose container declares more pixels than `maxPixels`
 * (via any `ispe` image-spatial-extents property) before it reaches the
 * WASM decoder. Parsing failures on malformed layouts are ignored — the
 * decoder itself then rejects the file — so this only ever *adds* a
 * rejection, never blocks a decodable file.
 */
function assertDeclaredPixelsWithinBound(b: Buffer, maxPixels: number): void {
  let declared: { width: number; height: number } | null = null;
  try {
    const meta = findBox(b, 0, b.length, 'meta');
    if (!meta) return;
    const iprp = findBox(b, meta.bodyStart + 4, meta.bodyEnd, 'iprp');
    if (!iprp) return;
    const ipco = findBox(b, iprp.bodyStart, iprp.bodyEnd, 'ipco');
    if (!ipco) return;
    for (const prop of walkBoxes(b, ipco.bodyStart, ipco.bodyEnd)) {
      if (prop.type !== 'ispe' || prop.bodyEnd - prop.bodyStart < 12) continue;
      const width = b.readUInt32BE(prop.bodyStart + 4); // ispe FullBox: version+flags, then width, height
      const height = b.readUInt32BE(prop.bodyStart + 8);
      if (width * height > maxPixels) {
        declared = { width, height };
        break;
      }
    }
  } catch {
    return;
  }
  if (declared) {
    throw new Error(
      `HEIF declares an image of ${declared.width}x${declared.height} pixels, ` +
        `exceeding the ${maxPixels}-pixel decode limit (maxDecodePixels)`,
    );
  }
}

const ICC_APP2_IDENTIFIER = Buffer.from('ICC_PROFILE\0', 'latin1');
// Max APP2 marker segment size is 0xFFFF, which includes the 2-byte length
// field itself (but not the 2-byte marker code) -- subtract the length
// field, identifier, sequence number, and marker count to get the max ICC
// payload per chunk.
const MAX_ICC_CHUNK_BYTES = 0xffff - 2 - ICC_APP2_IDENTIFIER.length - 1 - 1;
// The chunk-count byte in each APP2 segment is a uint8, so at most 255
// chunks can ever be described. Anything larger cannot be represented in
// the ICC-in-JPEG convention at all.
const MAX_EMBEDDABLE_ICC_BYTES = 255 * MAX_ICC_CHUNK_BYTES;

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

const EXIF_APP1_IDENTIFIER = Buffer.from('Exif\0\0', 'latin1');

/**
 * Splice a TIFF-format EXIF block into a JPEG buffer as an APP1 marker
 * segment directly after SOI (so it precedes any APP2 ICC segments, per
 * the usual marker order). Returns the JPEG unchanged when the block
 * doesn't fit in a single APP1 segment — EXIF has no multi-segment
 * chunking convention, so an oversized block simply can't be carried.
 */
function embedExifInJpeg(jpeg: Buffer, tiff: Buffer): Buffer {
  if (jpeg.length < 2 || jpeg[0] !== 0xff || jpeg[1] !== 0xd8) {
    throw new Error('Expected a JPEG buffer starting with the SOI marker');
  }
  const segmentLength = 2 + EXIF_APP1_IDENTIFIER.length + tiff.length;
  if (segmentLength > 0xffff) return jpeg;

  const header = Buffer.alloc(4 + EXIF_APP1_IDENTIFIER.length);
  header.writeUInt8(0xff, 0);
  header.writeUInt8(0xe1, 1);
  header.writeUInt16BE(segmentLength, 2);
  EXIF_APP1_IDENTIFIER.copy(header, 4);
  return Buffer.concat([jpeg.subarray(0, 2), header, tiff, jpeg.subarray(2)]);
}

/**
 * Extract the EXIF metadata of a HEIF file as a TIFF-format block (the
 * payload of a JPEG APP1 `Exif\0\0` segment), by finding the `Exif` item
 * in meta/iinf and resolving its bytes through meta/iloc.
 *
 * The EXIF Orientation tag (IFD0 0x0112) in the returned block is
 * neutralised to 1: the WASM decoder already applies the container's
 * irot/imir transforms to the pixels, so carrying the source orientation
 * forward would double-rotate in EXIF-aware viewers.
 *
 * Returns null when the file has no EXIF item or on any
 * malformed/truncated box layout — same degrade-gracefully contract as
 * {@link extractIccFromHeif}.
 */
export function extractExifFromHeif(b: Buffer): Buffer | null {
  try {
    const meta = findBox(b, 0, b.length, 'meta');
    if (!meta) return null;
    const metaBody = meta.bodyStart + 4; // meta is a FullBox: skip version+flags

    const exifItemId = findExifItemId(b, metaBody, meta.bodyEnd);
    if (exifItemId === null) return null;
    const loc = findItemLocation(b, metaBody, meta.bodyEnd, exifItemId);
    // The ExifDataBlock needs at least the 4-byte tiff-header offset plus
    // a TIFF header; anything the iloc points at out of bounds is malformed.
    if (!loc || loc.length < 12 || loc.offset + loc.length > b.length) return null;

    const block = b.subarray(loc.offset, loc.offset + loc.length);
    // ExifDataBlock (ISO 23008-12): uint32 offset from the start of the
    // payload (i.e. after this field) to the TIFF header, then the payload.
    const tiffStart = 4 + block.readUInt32BE(0);
    if (tiffStart >= block.length - 8) return null;
    const byteOrder = block.toString('latin1', tiffStart, tiffStart + 2);
    if (byteOrder !== 'II' && byteOrder !== 'MM') return null;
    return neutralizeTiffOrientation(block.subarray(tiffStart));
  } catch {
    return null;
  }
}

/** Find the item id declared with item_type 'Exif' in meta/iinf, or null. */
function findExifItemId(b: Buffer, metaBody: number, metaEnd: number): number | null {
  const iinf = findBox(b, metaBody, metaEnd, 'iinf');
  if (!iinf) return null;
  const iinfVersion = b.readUInt8(iinf.bodyStart);
  const entriesStart = iinf.bodyStart + 4 + (iinfVersion === 0 ? 2 : 4); // skip entry_count
  for (const infe of walkBoxes(b, entriesStart, iinf.bodyEnd)) {
    if (infe.type !== 'infe') continue;
    const infeVersion = b.readUInt8(infe.bodyStart);
    if (infeVersion < 2) continue; // item_type only exists from infe version 2
    const idSize = infeVersion === 2 ? 2 : 4;
    const itemId =
      infeVersion === 2 ? b.readUInt16BE(infe.bodyStart + 4) : b.readUInt32BE(infe.bodyStart + 4);
    const typeStart = infe.bodyStart + 4 + idSize + 2; // skip item_protection_index
    if (b.toString('latin1', typeStart, typeStart + 4) === 'Exif') return itemId;
  }
  return null;
}

/**
 * Resolve an item's byte range in the file via meta/iloc. Returns null
 * for items stored with a non-zero construction method (idat/item
 * offsets), an external data reference, or spread over multiple extents
 * — none of which occur for the single-extent file-offset EXIF items
 * real encoders write.
 */
function findItemLocation(
  b: Buffer,
  metaBody: number,
  metaEnd: number,
  targetItemId: number,
): { offset: number; length: number } | null {
  const iloc = findBox(b, metaBody, metaEnd, 'iloc');
  if (!iloc) return null;
  const version = b.readUInt8(iloc.bodyStart);
  let p = iloc.bodyStart + 4;
  const sizeFields = b.readUInt16BE(p);
  p += 2;
  const offsetSize = (sizeFields >> 12) & 0xf;
  const lengthSize = (sizeFields >> 8) & 0xf;
  const baseOffsetSize = (sizeFields >> 4) & 0xf;
  const indexSize = version >= 1 ? sizeFields & 0xf : 0;

  const readSized = (size: number): number => {
    let value: number;
    if (size === 0) value = 0;
    else if (size === 8) value = Number(b.readBigUInt64BE(p));
    else value = b.readUIntBE(p, size);
    p += size;
    return value;
  };

  let itemCount: number;
  if (version < 2) {
    itemCount = b.readUInt16BE(p);
    p += 2;
  } else {
    itemCount = b.readUInt32BE(p);
    p += 4;
  }

  for (let i = 0; i < itemCount; i++) {
    let itemId: number;
    if (version < 2) {
      itemId = b.readUInt16BE(p);
      p += 2;
    } else {
      itemId = b.readUInt32BE(p);
      p += 4;
    }
    let constructionMethod = 0;
    if (version >= 1) {
      constructionMethod = b.readUInt16BE(p) & 0xf;
      p += 2;
    }
    const dataReferenceIndex = b.readUInt16BE(p);
    p += 2;
    const baseOffset = readSized(baseOffsetSize);
    const extentCount = b.readUInt16BE(p);
    p += 2;
    let firstExtent: { offset: number; length: number } | null = null;
    for (let j = 0; j < extentCount; j++) {
      if (indexSize > 0) readSized(indexSize);
      const extentOffset = readSized(offsetSize);
      const extentLength = readSized(lengthSize);
      if (j === 0) firstExtent = { offset: baseOffset + extentOffset, length: extentLength };
    }
    if (itemId === targetItemId) {
      if (constructionMethod !== 0 || dataReferenceIndex !== 0 || extentCount !== 1) return null;
      return firstExtent;
    }
  }
  return null;
}

/**
 * Return a copy of a TIFF-format EXIF block with the IFD0 Orientation
 * tag (0x0112), if present, set to 1 ("top-left, no rotation"). On any
 * parse failure the unmodified copy is returned.
 */
function neutralizeTiffOrientation(tiff: Buffer): Buffer {
  const out = Buffer.from(tiff);
  try {
    const littleEndian = out.toString('latin1', 0, 2) === 'II';
    const readUInt16 = (o: number) => (littleEndian ? out.readUInt16LE(o) : out.readUInt16BE(o));
    const readUInt32 = (o: number) => (littleEndian ? out.readUInt32LE(o) : out.readUInt32BE(o));
    const ifd0 = readUInt32(4);
    const entryCount = readUInt16(ifd0);
    for (let i = 0; i < entryCount; i++) {
      const entry = ifd0 + 2 + i * 12;
      if (readUInt16(entry) === 0x0112) {
        // value slot of a SHORT-type entry: 8 bytes into the 12-byte entry
        if (littleEndian) out.writeUInt16LE(1, entry + 8);
        else out.writeUInt16BE(1, entry + 8);
        break;
      }
    }
  } catch {
    // leave the copy unmodified; a partially unparseable block is still
    // better carried forward than dropped
  }
  return out;
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
