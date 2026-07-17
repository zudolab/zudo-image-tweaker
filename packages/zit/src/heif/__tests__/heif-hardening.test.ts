/**
 * Crafted-input hardening tests (issue #73). The WASM decoder is mocked
 * out so the synthetic hand-built box layouts don't need to be actually
 * decodable — these tests exercise the container-level guards that run
 * around the decode, not the decode itself.
 */
import { describe, expect, test, vi } from 'vitest';
import sharp from 'sharp';
import { convertHeifToJpegNode, extractIccFromHeif } from '../index.js';

const decodeMock = vi.hoisted(() =>
  vi.fn(async () => ({
    width: 4,
    height: 4,
    data: new Uint8Array(4 * 4 * 4).fill(128),
  })),
);

vi.mock('heic-decode', () => ({ default: decodeMock }));

// ---- minimal ISOBMFF builders (mirrors the synthetic-edge-case suite) ----

function box(type: string, body: Buffer): Buffer {
  const size = 8 + body.length;
  const buf = Buffer.alloc(8);
  buf.writeUInt32BE(size, 0);
  buf.write(type, 4, 'latin1');
  return Buffer.concat([buf, body]);
}

function fullBoxBody(version: number, flags: number, rest: Buffer): Buffer {
  const head = Buffer.alloc(4);
  head.writeUInt8(version, 0);
  head.writeUIntBE(flags, 1, 3);
  return Buffer.concat([head, rest]);
}

function buildPitm(itemId: number): Buffer {
  const rest = Buffer.alloc(2);
  rest.writeUInt16BE(itemId, 0);
  return box('pitm', fullBoxBody(0, 0, rest));
}

function buildIspe(width: number, height: number): Buffer {
  const rest = Buffer.alloc(8);
  rest.writeUInt32BE(width, 0);
  rest.writeUInt32BE(height, 4);
  return box('ispe', fullBoxBody(0, 0, rest));
}

function buildColrProf(iccData: Buffer): Buffer {
  return box('colr', Buffer.concat([Buffer.from('prof', 'latin1'), iccData]));
}

function buildIpma(itemId: number, indices: number[]): Buffer {
  const head = Buffer.alloc(4 + 2 + 1);
  head.writeUInt32BE(1, 0); // entry_count
  head.writeUInt16BE(itemId, 4);
  head.writeUInt8(indices.length, 6);
  const idx = Buffer.from(indices.map((i) => i & 0x7f));
  return box('ipma', fullBoxBody(0, 0, Buffer.concat([head, idx])));
}

function buildMeta(itemId: number, properties: Buffer[]): Buffer {
  const ipco = box('ipco', Buffer.concat(properties));
  const ipma = buildIpma(
    itemId,
    properties.map((_, i) => i + 1),
  );
  const iprp = box('iprp', Buffer.concat([ipco, ipma]));
  return box(
    'meta',
    Buffer.concat([Buffer.alloc(4), buildPitm(itemId), iprp]),
  );
}

// Same derivation as the implementation: 255 max chunks x max ICC payload
// per APP2 segment (0xFFFF - length field - "ICC_PROFILE\0" - seq - count).
const MAX_ICC_CHUNK_BYTES = 0xffff - 2 - 12 - 1 - 1;
const MAX_EMBEDDABLE_ICC_BYTES = 255 * MAX_ICC_CHUNK_BYTES;

describe('#63: declared-dimension pre-check before decode', () => {
  test('rejects a tiny crafted HEIC declaring huge ispe dimensions before the decoder runs', async () => {
    const crafted = buildMeta(1, [buildIspe(0xffff, 0xffff)]); // ~4.29 gigapixels declared
    decodeMock.mockClear();

    await expect(convertHeifToJpegNode(crafted)).rejects.toThrow(
      /65535x65535.*decode limit/s,
    );
    expect(decodeMock).not.toHaveBeenCalled();
  });

  test('respects a caller-supplied maxDecodePixels', async () => {
    const crafted = buildMeta(1, [buildIspe(100, 100)]);
    await expect(convertHeifToJpegNode(crafted, { maxDecodePixels: 100 })).rejects.toThrow(
      /100x100.*decode limit/s,
    );
  });

  test('dimensions within the limit pass the pre-check and reach the decoder', async () => {
    const crafted = buildMeta(1, [buildIspe(4, 4)]);
    decodeMock.mockClear();

    const result = await convertHeifToJpegNode(crafted);
    expect(decodeMock).toHaveBeenCalledTimes(1);
    expect(result.width).toBe(4);
    expect(result.converter).toBe('node');
  });
});

describe('#65: oversized colr box degrades gracefully', () => {
  test('a colr profile too large for 255 APP2 chunks is skipped, not a RangeError', async () => {
    const oversizedIcc = Buffer.alloc(MAX_EMBEDDABLE_ICC_BYTES + 1, 0xab);
    const crafted = buildMeta(1, [buildColrProf(oversizedIcc)]);

    // the extractor itself still returns the attacker-declared bytes...
    expect(extractIccFromHeif(crafted)!.length).toBe(MAX_EMBEDDABLE_ICC_BYTES + 1);

    // ...but the conversion pipeline refuses to embed them
    const result = await convertHeifToJpegNode(crafted);
    expect(result.iccApplied).toBe(false);
    const metadata = await sharp(result.buffer).metadata();
    expect(metadata.format).toBe('jpeg');
    expect(metadata.icc).toBeUndefined();
  });

  test('a normally-sized colr profile still embeds (guard threshold sanity check)', async () => {
    // a syntactically plausible small profile: sharp only needs to report
    // its presence, not validate it
    const icc = Buffer.alloc(128, 0x01);
    icc.write('acsp', 36, 'latin1');
    const crafted = buildMeta(1, [buildColrProf(icc)]);

    const result = await convertHeifToJpegNode(crafted);
    expect(result.iccApplied).toBe(true);
    const metadata = await sharp(result.buffer).metadata();
    expect(metadata.icc).toBeDefined();
    expect(Buffer.from(metadata.icc!).equals(icc)).toBe(true);
  });
});
