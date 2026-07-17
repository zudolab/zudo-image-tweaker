import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hashFile, readCache, writeCache, writeFileAtomic, type CacheEntry } from '../hash-cache.js';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'zit-cache-'));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fsPromises.rm(tmpDir, { recursive: true, force: true });
});

describe('hashFile', () => {
  it('is stable for identical bytes and differs for changed bytes', async () => {
    const a = path.join(tmpDir, 'a.bin');
    const b = path.join(tmpDir, 'b.bin');
    await fsPromises.writeFile(a, 'hello world');
    await fsPromises.writeFile(b, 'hello world');
    const changed = path.join(tmpDir, 'c.bin');
    await fsPromises.writeFile(changed, 'hello world!');

    const ha = await hashFile(a);
    expect(ha).toBe(await hashFile(b));
    expect(ha).not.toBe(await hashFile(changed));
    expect(ha).toMatch(/^[0-9a-f]+$/);
  });
});

describe('hashFile — hasher init retry', () => {
  it('re-invokes xxhash on the next call after a failed init instead of poisoning the process', async () => {
    // The memoized hasher promise must be cleared on rejection so a transient
    // WASM init failure does not break hashFile for the rest of the process.
    vi.resetModules();
    const xxhashMock = vi.fn();
    vi.doMock('xxhash-wasm', () => ({ default: xxhashMock }));

    const file = path.join(tmpDir, 'h.bin');
    await fsPromises.writeFile(file, 'payload');

    const realXxhash = (await vi.importActual<typeof import('xxhash-wasm')>('xxhash-wasm')).default;
    xxhashMock.mockRejectedValueOnce(new Error('wasm init boom'));
    xxhashMock.mockImplementationOnce(() => realXxhash());

    const { hashFile: freshHashFile } = await import('../hash-cache.js');

    await expect(freshHashFile(file)).rejects.toThrow('wasm init boom');
    // Second call must retry the init (not reuse the rejected memo) and succeed.
    await expect(freshHashFile(file)).resolves.toMatch(/^[0-9a-f]+$/);
    expect(xxhashMock).toHaveBeenCalledTimes(2);

    vi.doUnmock('xxhash-wasm');
    vi.resetModules();
  });
});

describe('writeFileAtomic', () => {
  it('writes the target via a temp file + rename, leaving no temp residue', async () => {
    const renameSpy = vi.spyOn(fsPromises, 'rename');
    const target = path.join(tmpDir, 'out.json');

    await writeFileAtomic(target, 'payload');

    expect(await fsPromises.readFile(target, 'utf-8')).toBe('payload');
    // Proves the temp+rename strategy: rename lands on the final target.
    expect(renameSpy).toHaveBeenCalledTimes(1);
    expect(renameSpy.mock.calls[0][1]).toBe(target);
    const leftovers = (await fsPromises.readdir(tmpDir)).filter((f) => f.endsWith('.tmp'));
    expect(leftovers).toEqual([]);
  });

  it('cleans up the temp file and rethrows if the rename fails', async () => {
    vi.spyOn(fsPromises, 'rename').mockRejectedValueOnce(new Error('boom'));
    const target = path.join(tmpDir, 'out.json');

    await expect(writeFileAtomic(target, 'payload')).rejects.toThrow('boom');
    const leftovers = (await fsPromises.readdir(tmpDir)).filter((f) => f.endsWith('.tmp'));
    expect(leftovers).toEqual([]);
  });
});

describe('readCache / writeCache', () => {
  it('round-trips a cache entry', async () => {
    const cachePath = path.join(tmpDir, '.cache.json');
    const entry: CacheEntry = {
      hash: 'deadbeef',
      configHash: '{"quality":85}',
      mode: 'full',
      animated: false,
      outputs: ['600w.webp', '900w.webp'],
      outputSizes: { '600w.webp': 1234, '900w.webp': 5678 },
      metadata: {
        slug: 'x',
        blurhash: 'LEHV6nWB',
        width: 100,
        height: 200,
        aspectRatio: 200,
        hasVariants: true,
        hash: 'deadbeef',
        processedAt: '2026-01-01T00:00:00.000Z',
      },
    };
    await writeCache(cachePath, entry);
    expect(await readCache(cachePath)).toEqual(entry);
  });

  it('returns null for a missing cache file', async () => {
    expect(await readCache(path.join(tmpDir, 'nope.json'))).toBeNull();
  });

  it('returns null for a corrupt cache file instead of throwing', async () => {
    const cachePath = path.join(tmpDir, 'bad.json');
    await fsPromises.writeFile(cachePath, '{ not valid json');
    expect(await readCache(cachePath)).toBeNull();
  });
});
