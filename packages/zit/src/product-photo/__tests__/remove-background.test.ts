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
