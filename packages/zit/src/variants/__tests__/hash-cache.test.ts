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
      animated: false,
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
