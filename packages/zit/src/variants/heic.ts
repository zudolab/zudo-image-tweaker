import path from 'node:path';
import { hasFileBinary } from './feature-detect.js';
import { isMissingBinaryError, run } from './run.js';

const HEIC_EXTENSIONS = new Set(['.heic', '.heif']);
const JPEG_EXTENSIONS = new Set(['.jpg', '.jpeg']);

const HEIC_MIME_TYPES = new Set(['image/heic', 'image/heif']);
const NON_IMAGE_MIME_TYPES = new Set(['text/html', 'text/plain']);

/**
 * Returns the exact MIME type reported by `file -b --mime-type` (e.g.
 * `image/heic`), never the default human-readable output. The default
 * output is prefixed with the echoed file path unless `-b` is passed, so
 * a path substring (e.g. a directory named `HTML-exports/`) would
 * otherwise corrupt a naive substring match against the description.
 */
async function identify(inputPath: string): Promise<string | null> {
  if (!(await hasFileBinary())) return null;
  try {
    const { stdout } = await run('file', ['-b', '--mime-type', inputPath]);
    return stdout.trim();
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

  const mimeType = await identify(inputPath);
  return mimeType !== null && HEIC_MIME_TYPES.has(mimeType);
}

/**
 * Heuristic guard against non-image files that were saved with an image
 * extension — most commonly an HTML error page or a plain-text response
 * downloaded to `photo.jpg`. Returns false (don't skip) whenever `file`
 * can't make the determination.
 */
export async function isNonImageFile(inputPath: string): Promise<boolean> {
  const mimeType = await identify(inputPath);
  if (mimeType === null) return false;
  return NON_IMAGE_MIME_TYPES.has(mimeType);
}
