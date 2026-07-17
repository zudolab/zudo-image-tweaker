/**
 * Cross-cutting tests for encodeUnderByteBudget's input loading: a Buffer
 * passed directly, a local file path, and a remote URL. Remote fetches are
 * always mocked — these tests never hit the network.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';

import { encodeUnderByteBudget } from './index';

const TEST_TIMEOUT = 20000;

async function makeSolidImage(width: number, height: number) {
  return sharp({
    create: { width, height, channels: 3, background: { r: 50, g: 150, b: 50 } },
  })
    .jpeg()
    .toBuffer();
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('encodeUnderByteBudget — input sources', () => {
  it(
    'accepts a Buffer directly',
    async () => {
      const src = await makeSolidImage(120, 90);
      const result = await encodeUnderByteBudget(src, { maxBytes: 8 * 1024 * 1024 });
      expect(result.ok).toBe(true);
    },
    TEST_TIMEOUT,
  );

  it(
    'reads a local file path',
    async () => {
      const dir = await mkdtemp(path.join(tmpdir(), 'zit-budget-test-'));
      const filePath = path.join(dir, 'source.jpg');
      try {
        const src = await makeSolidImage(120, 90);
        await writeFile(filePath, src);

        const result = await encodeUnderByteBudget(filePath, { maxBytes: 8 * 1024 * 1024 });
        expect(result.ok).toBe(true);
        expect(result.ok && result.format).toBe('jpeg');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
    TEST_TIMEOUT,
  );

  it(
    'throws a clear error when a local file path does not exist',
    async () => {
      await expect(
        encodeUnderByteBudget('/nonexistent/path/does-not-exist.jpg', { maxBytes: 8 * 1024 * 1024 }),
      ).rejects.toThrow(/Failed to read local file/);
    },
    TEST_TIMEOUT,
  );

  it(
    'fetches a remote URL (mocked — never hits the network)',
    async () => {
      const src = await makeSolidImage(120, 90);
      const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(src, { status: 200 }),
      );

      const result = await encodeUnderByteBudget('https://example.com/photo.jpg', {
        maxBytes: 8 * 1024 * 1024,
      });

      expect(fetchMock).toHaveBeenCalledWith('https://example.com/photo.jpg');
      expect(result.ok).toBe(true);
    },
    TEST_TIMEOUT,
  );

  it(
    'throws a clear error when the remote fetch responds with a non-ok status',
    async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('not found', { status: 404 }));

      await expect(
        encodeUnderByteBudget('https://example.com/missing.jpg', { maxBytes: 8 * 1024 * 1024 }),
      ).rejects.toThrow(/HTTP 404/);
    },
    TEST_TIMEOUT,
  );

  it(
    'throws a clear error when the remote fetch itself fails',
    async () => {
      vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network down'));

      await expect(
        encodeUnderByteBudget('https://example.com/photo.jpg', { maxBytes: 8 * 1024 * 1024 }),
      ).rejects.toThrow(/Failed to fetch/);
    },
    TEST_TIMEOUT,
  );
});
