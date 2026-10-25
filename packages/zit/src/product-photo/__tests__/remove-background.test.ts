import { describe, expect, it, vi } from 'vitest';

const IMGLY_PACKAGE = '@imgly/background-removal-node';

describe('removeBackground optional peer contract', () => {
  it('throws ERR_OPTIONAL_PEER_MISSING when the optional peer is not installed', async () => {
    vi.resetModules();
    vi.doMock(IMGLY_PACKAGE, () => {
      const err = new Error(`Cannot find package '${IMGLY_PACKAGE}'`);
      (err as NodeJS.ErrnoException).code = 'ERR_MODULE_NOT_FOUND';
      throw err;
    });

    const { removeBackground } = await import('../index.js');

    await expect(removeBackground(Buffer.from('fake'))).rejects.toMatchObject({
      code: 'ERR_OPTIONAL_PEER_MISSING',
      message: expect.stringMatching(/npm install @imgly\/background-removal-node/),
    });

    vi.doUnmock(IMGLY_PACKAGE);
    vi.resetModules();
  });

  it('also detects a missing module via the error message when `code` is absent', async () => {
    vi.resetModules();
    vi.doMock(IMGLY_PACKAGE, () => {
      throw new Error(`Cannot find module '${IMGLY_PACKAGE}'`);
    });

    const { removeBackground } = await import('../index.js');

    await expect(removeBackground(Buffer.from('fake'))).rejects.toMatchObject({
      code: 'ERR_OPTIONAL_PEER_MISSING',
    });

    vi.doUnmock(IMGLY_PACKAGE);
    vi.resetModules();
  });

  it('does not misclassify a missing transitive dependency of the peer as the peer itself missing', async () => {
    vi.resetModules();
    vi.doMock(IMGLY_PACKAGE, () => {
      // e.g. one of the peer's own native bindings failed to resolve — a distinct,
      // actionable installation/platform failure, not "the peer isn't installed".
      const err = new Error(
        `Cannot find package 'onnxruntime-node' imported from .../${IMGLY_PACKAGE}/dist/index.mjs`,
      );
      (err as NodeJS.ErrnoException).code = 'ERR_MODULE_NOT_FOUND';
      throw err;
    });

    const { removeBackground } = await import('../index.js');

    let caught: unknown;
    try {
      await removeBackground(Buffer.from('fake'));
    } catch (err) {
      caught = err;
    }

    expect((caught as { code?: string } | undefined)?.code).not.toBe('ERR_OPTIONAL_PEER_MISSING');

    vi.doUnmock(IMGLY_PACKAGE);
    vi.resetModules();
  });

  it('re-throws unrelated import errors unchanged (not mapped to ERR_OPTIONAL_PEER_MISSING)', async () => {
    vi.resetModules();
    vi.doMock(IMGLY_PACKAGE, () => {
      throw new Error('unexpected boom');
    });

    const { removeBackground } = await import('../index.js');

    let caught: unknown;
    try {
      await removeBackground(Buffer.from('fake'));
    } catch (err) {
      caught = err;
    }

    // vitest wraps a factory-thrown error in its own Error with `.cause` set
    // to the original — assert the unrelated failure surfaces unmapped,
    // wherever in the chain it lands, rather than being coerced to our
    // optional-peer error shape.
    expect((caught as { code?: string } | undefined)?.code).not.toBe('ERR_OPTIONAL_PEER_MISSING');
    const messages = [caught, (caught as { cause?: unknown })?.cause]
      .filter((e): e is Error => e instanceof Error)
      .map((e) => e.message);
    expect(messages.some((m) => m.includes('unexpected boom'))).toBe(true);

    vi.doUnmock(IMGLY_PACKAGE);
    vi.resetModules();
  });
});

describe('removeBackground input handling', () => {
  async function capturedSourceFor(input: Buffer): Promise<unknown> {
    vi.resetModules();
    const spy = vi.fn(async () => new Blob([Buffer.from('out')], { type: 'image/png' }));
    vi.doMock(IMGLY_PACKAGE, () => ({ removeBackground: spy }));
    try {
      const { removeBackground } = await import('../index.js');
      await removeBackground(input);
    } finally {
      vi.doUnmock(IMGLY_PACKAGE);
      vi.resetModules();
    }
    return (spy.mock.calls[0] as unknown[])[0];
  }

  it('passes a Buffer to imgly as a Blob typed with its detected MIME', async () => {
    const sharp = (await import('sharp')).default;
    const jpeg = await sharp({
      create: { width: 8, height: 8, channels: 3, background: { r: 0, g: 0, b: 255 } },
    })
      .jpeg()
      .toBuffer();

    const source = await capturedSourceFor(jpeg);
    expect(source).toBeInstanceOf(Blob);
    expect((source as Blob).type).toBe('image/jpeg');
  });

  it('re-encodes formats imgly cannot decode to a PNG Blob', async () => {
    const sharp = (await import('sharp')).default;
    const tiff = await sharp({
      create: { width: 8, height: 8, channels: 3, background: { r: 0, g: 255, b: 0 } },
    })
      .tiff()
      .toBuffer();

    const source = await capturedSourceFor(tiff);
    expect((source as Blob).type).toBe('image/png');
    const head = Buffer.from(await (source as Blob).arrayBuffer()).subarray(0, 8);
    expect(head.equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe(true);
  });
});

// Gated behind RUN_ML_TESTS=1 — downloads ~80MB of ONNX models on first run.
// NEVER enabled by default or in CI; opt-in only for local, manual verification.
describe.skipIf(process.env.RUN_ML_TESTS !== '1')('removeBackground (real ML path)', () => {
  it('removes the background from a real image using the ONNX model', async () => {
    const sharp = (await import('sharp')).default;
    const { removeBackground } = await import('../index.js');
    const input = await sharp({
      create: { width: 64, height: 64, channels: 3, background: { r: 255, g: 0, b: 0 } },
    })
      .png()
      .toBuffer();

    const result = await removeBackground(input);
    expect(Buffer.isBuffer(result)).toBe(true);
  });
});
