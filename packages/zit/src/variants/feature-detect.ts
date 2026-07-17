import { isMissingBinaryError, run } from './run.js';

/**
 * Feature-detect optional external binaries (`file`, `magick`, `ffmpeg`).
 * None of these are hard dependencies — every one is probed at runtime and
 * gracefully absent on a machine that doesn't have it (e.g. plain Linux
 * without ImageMagick). Results are memoised for the lifetime of the
 * process; {@link resetFeatureDetectionCache} clears the memo for tests.
 */
const detectionCache = new Map<string, boolean>();

async function probe(command: string, args: string[]): Promise<boolean> {
  try {
    await run(command, args);
    return true;
  } catch (error) {
    // ENOENT means the binary isn't installed. Any other failure (a
    // non-zero exit from `--version`, say) still proves the binary exists.
    return !isMissingBinaryError(error);
  }
}

async function detect(command: string, args: string[]): Promise<boolean> {
  const cached = detectionCache.get(command);
  if (cached !== undefined) return cached;
  const available = await probe(command, args);
  detectionCache.set(command, available);
  return available;
}

/** Whether the `file` type-identification binary is available. */
export function hasFileBinary(): Promise<boolean> {
  return detect('file', ['--version']);
}

/** Whether ImageMagick's `magick` binary is available. */
export function hasMagick(): Promise<boolean> {
  return detect('magick', ['-version']);
}

/** Whether `ffmpeg` is available. */
export function hasFfmpeg(): Promise<boolean> {
  return detect('ffmpeg', ['-version']);
}

/** Clear the memoised detection results. For tests only. */
export function resetFeatureDetectionCache(): void {
  detectionCache.clear();
}
