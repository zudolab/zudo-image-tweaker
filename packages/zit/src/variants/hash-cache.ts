import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import xxhash from 'xxhash-wasm';
import type { TagMode, VariantMetadata } from './types.js';

/** The engine's per-image cache sidecar. Purely internal — not a metadata DB. */
export interface CacheEntry {
  /** Content hash of the source file the cached outputs were produced from. */
  hash: string;
  /**
   * Fingerprint of the output-affecting config (quality, widths, OGP options,
   * …) the cached outputs were produced with. A change invalidates the cache
   * even when the source bytes are unchanged.
   */
  configHash: string;
  /**
   * The tag mode the cached outputs were produced under. Renaming a source
   * to change only its tag (e.g. `photo__og.jpg` → `photo__ogonly.jpg`)
   * keeps the same bytes and slug, so the mode is compared to stop the old
   * outputs from satisfying the new mode's expected-output subset.
   */
  mode: TagMode;
  /** Whether the source was handled as an animated passthrough (GIF/WebP/APNG). */
  animated: boolean;
  /**
   * The exact filenames this run emitted into the slug directory. Compared
   * against the current config's expected filenames so a changed custom
   * `outputName` scheme — including at the sub-min-width fallback, which the
   * config fingerprint can't capture pre-probe — is treated as a miss rather
   * than a stale hit on a lingering older-scheme file.
   */
  outputs: string[];
  /**
   * On-disk byte size of every filename in `outputs`, keyed by filename.
   * Validated against the actual file size on a cache hit so a truncated
   * output — e.g. one left by a crash mid-write under an older, non-atomic
   * version — is treated as a miss instead of a poisoned hit. An entry
   * written before this field existed lacks it entirely, which the cache
   * check reads as "unverifiable" and reprocesses once.
   */
  outputSizes: Record<string, number>;
  /** Last emitted metadata record (null for OGP-only images), replayed on a cache hit. */
  metadata: VariantMetadata | null;
}

let hasherPromise: ReturnType<typeof xxhash> | null = null;

function getHasher(): ReturnType<typeof xxhash> {
  if (!hasherPromise) {
    hasherPromise = xxhash();
    // A failed WASM init must not poison hashFile for the rest of the
    // process: drop the memo on rejection so the next call re-invokes
    // xxhash(). The assign-then-attach order keeps the concurrent-first-call
    // race safe — every caller in the same tick shares this one promise, and
    // the memo is only cleared once it has actually rejected.
    hasherPromise.catch(() => {
      hasherPromise = null;
    });
  }
  return hasherPromise;
}

/** Content-hash a file's bytes with xxhash (64-bit), returned as a hex string. */
export async function hashFile(filePath: string): Promise<string> {
  const [hasher, content] = await Promise.all([getHasher(), fs.readFile(filePath)]);
  // Buffer is a Uint8Array, so h64Raw hashes the raw bytes directly.
  return hasher.h64Raw(content).toString(16);
}

/**
 * Produce `filePath` atomically: `produce` writes to a sibling temp path in
 * the SAME directory, which is then renamed over the target. rename(2) is
 * atomic within a filesystem, so a reader never observes a half-written file
 * and a crash before the rename leaves the previous version intact — never a
 * truncated one at the final path. On any failure the temp file is removed.
 *
 * Invariant this establishes for every cached output: a file that exists at
 * its final path is complete. `produce`'s return value (e.g. sharp's
 * OutputInfo) is passed through so callers keep the size/metadata they need.
 */
export async function writeAtomicVia<T>(
  filePath: string,
  produce: (tmpPath: string) => Promise<T>,
): Promise<T> {
  const tmpPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${randomUUID()}.tmp`,
  );
  try {
    const result = await produce(tmpPath);
    await fs.rename(tmpPath, filePath);
    return result;
  } catch (error) {
    await fs.rm(tmpPath, { force: true });
    throw error;
  }
}

/**
 * Write `data` to `filePath` atomically via {@link writeAtomicVia}: staged in
 * a sibling temp file, then renamed over the target.
 */
export async function writeFileAtomic(filePath: string, data: string | Buffer): Promise<void> {
  await writeAtomicVia(filePath, (tmpPath) => fs.writeFile(tmpPath, data));
}

/** Read and parse a cache sidecar, or null when it's absent or unparseable. */
export async function readCache(cachePath: string): Promise<CacheEntry | null> {
  let raw: string;
  try {
    raw = await fs.readFile(cachePath, 'utf-8');
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as CacheEntry;
    if (typeof parsed?.hash !== 'string') return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Atomically write a cache sidecar. */
export function writeCache(cachePath: string, entry: CacheEntry): Promise<void> {
  return writeFileAtomic(cachePath, JSON.stringify(entry, null, 2));
}
