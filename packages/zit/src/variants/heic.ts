import path from 'node:path';
import { hasFileBinary } from './feature-detect.js';
import { isMissingBinaryError, run } from './run.js';

const HEIC_EXTENSIONS = new Set(['.heic', '.heif']);
const JPEG_EXTENSIONS = new Set(['.jpg', '.jpeg']);

async function identify(inputPath: string): Promise<string | null> {
  if (!(await hasFileBinary())) return null;
  try {
    const { stdout } = await run('file', [inputPath]);
    return stdout;
  } catch (error) {
    if (isMissingBinaryError(error)) return null;
    // A non-ENOENT failure (unreadable path, etc.) leaves identification
    // indeterminate; callers treat null as "couldn't tell".
    return null;
  }
}

/**
 * Whether a source should be treated as HEIC/HEIF. Trusts the extension
 * for `.heic`/`.heif`, and additionally sniffs `.jpg`/`.jpeg` files with
 * the `file` binary because cameras and messaging apps routinely hand out
 * HEIF payloads under a `.jpg` name. When `file` is unavailable, only the
 * extension is consulted.
 */
export async function isHeicSource(inputPath: string): Promise<boolean> {
  const ext = path.extname(inputPath).toLowerCase();
  if (HEIC_EXTENSIONS.has(ext)) return true;
  if (!JPEG_EXTENSIONS.has(ext)) return false;

  const description = await identify(inputPath);
  return description !== null && (description.includes('HEIF') || description.includes('HEIC'));
}

/**
 * Heuristic guard against non-image files that were saved with an image
 * extension — most commonly an HTML error page or a plain-text response
 * downloaded to `photo.jpg`. Returns false (don't skip) whenever `file`
 * can't make the determination.
 */
export async function isNonImageFile(inputPath: string): Promise<boolean> {
  const description = await identify(inputPath);
  if (description === null) return false;
  return description.includes('HTML') || description.includes('ASCII text');
}
