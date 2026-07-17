/**
 * Cross-cutting tests for encodeUnderByteBudget's input loading: a Buffer
 * passed directly, a local file path, and a remote URL. Remote fetches are
 * always mocked — these tests never hit the network.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import type { Socket } from 'node:net';
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

      expect(fetchMock).toHaveBeenCalledWith(
        'https://example.com/photo.jpg',
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
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

/**
 * Remote-input hardening (#62): a real localhost node:http server exercises
 * the timeout and byte-cap paths that a mocked fetch cannot — the abort has
 * to interrupt an actual pending response / streaming body.
 */
describe('encodeUnderByteBudget — remote input hardening', () => {
  async function withServer(
    handler: http.RequestListener,
    run: (url: string) => Promise<void>,
  ): Promise<void> {
    const server = http.createServer(handler);
    const sockets = new Set<Socket>();
    server.on('connection', (socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('expected a bound port');

    try {
      await run(`http://127.0.0.1:${address.port}/image.png`);
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    }
  }

  it(
    'aborts with a descriptive timeout error when the server never responds',
    async () => {
      await withServer(
        () => {
          // Never respond — hold the request open until the socket is destroyed.
        },
        async (url) => {
          await expect(
            encodeUnderByteBudget(url, { maxBytes: 8 * 1024 * 1024, fetchTimeoutMs: 300 }),
          ).rejects.toThrow(/timed out after 300ms/);
        },
      );
    },
    TEST_TIMEOUT,
  );

  it(
    'aborts with a descriptive timeout error when the body download stalls after headers',
    async () => {
      await withServer(
        (_req, res) => {
          res.writeHead(200, { 'content-type': 'image/png' });
          res.write('partial'); // then stall — never end the response
        },
        async (url) => {
          await expect(
            encodeUnderByteBudget(url, { maxBytes: 8 * 1024 * 1024, fetchTimeoutMs: 300 }),
          ).rejects.toThrow(/timed out after 300ms/);
        },
      );
    },
    TEST_TIMEOUT,
  );

  it(
    'rejects a response whose declared content-length exceeds the input cap without downloading it',
    async () => {
      await withServer(
        (_req, res) => {
          res.writeHead(200, { 'content-type': 'image/png', 'content-length': '99999999' });
          res.write('x');
        },
        async (url) => {
          await expect(
            encodeUnderByteBudget(url, { maxBytes: 8 * 1024 * 1024, maxInputBytes: 1000 }),
          ).rejects.toThrow(/declares 99999999 bytes.*exceeds the maximum input size of 1000 bytes/);
        },
      );
    },
    TEST_TIMEOUT,
  );

  it(
    'aborts a chunked (no content-length) body once it streams past the input cap',
    async () => {
      await withServer(
        (_req, res) => {
          // Chunked transfer: no content-length header, keep pumping bytes
          // well past the cap without ever ending the response.
          res.writeHead(200, { 'content-type': 'image/png' });
          const chunk = Buffer.alloc(1024, 7);
          const pump = setInterval(() => {
            if (!res.writableEnded && res.writable) res.write(chunk);
          }, 5);
          res.on('close', () => clearInterval(pump));
        },
        async (url) => {
          await expect(
            encodeUnderByteBudget(url, { maxBytes: 8 * 1024 * 1024, maxInputBytes: 4000 }),
          ).rejects.toThrow(/exceeds the maximum input size of 4000 bytes/);
        },
      );
    },
    TEST_TIMEOUT,
  );
});
