import { randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { hasFfmpeg, hasMagick } from './feature-detect.js';
import { resolveBinaryPath, run } from './run.js';

// sharp/libvips corruption signatures worth attempting a repair for
// (matched case-insensitively). A message not on this list is a genuine
// "this isn't a decodable image" error that repair wouldn't help, so it's
// left to propagate.
const CORRUPTION_SIGNATURES = [
  'premature end',
  'bad huffman',
  'corrupt jpeg',
  'libspng read error',
];

/** Whether an error looks like recoverable bitstream corruption rather than a non-image. */
export function isCorruptionError(error: unknown): boolean {
  const message = ((error as Error | undefined)?.message ?? '').toLowerCase();
  return CORRUPTION_SIGNATURES.some((sig) => message.includes(sig));
}

async function decodesCleanly(buffer: Buffer): Promise<boolean> {
  try {
    await sharp(buffer).metadata();
    return true;
  } catch {
    return false;
  }
}

async function repairWith(
  command: string,
  buildArgs: (inputPath: string, outputPath: string) => string[],
  inputPath: string,
  outputExt = 'jpg',
): Promise<Buffer | null> {
  const outputPath = path.join(os.tmpdir(), `zit-repair-${process.pid}-${randomUUID()}.${outputExt}`);
  try {
    await run(command, buildArgs(resolveBinaryPath(inputPath), outputPath));
    const buffer = await fs.readFile(outputPath);
    if (buffer.length > 0 && (await decodesCleanly(buffer))) {
      return buffer;
    }
    return null;
  } catch {
    return null;
  } finally {
    await fs.rm(outputPath, { force: true });
  }
}

/**
 * The sibling raster format to re-decode a corrupt source through. A damaged
 * JPEG bitstream sometimes survives a round-trip through PNG (and vice versa)
 * when a same-format re-encode can't recover it. Unknown/other extensions
 * default to PNG — lossless, and the most tolerant re-decode target.
 */
function siblingFormat(inputPath: string): 'png' | 'jpg' {
  return path.extname(inputPath).toLowerCase() === '.png' ? 'jpg' : 'png';
}

/**
 * Copy the untouched corrupt source to a sibling `<name>.corrupted.bak` before
 * a repair attempt, so an operator can inspect or recover the true original.
 * Best-effort and non-fatal — a repair must never fail because its backup did.
 * `COPYFILE_EXCL` preserves the FIRST backup (the most-original bytes): a later
 * repair of the same path finds the `.bak` already there and leaves it be.
 */
async function backupCorruptedSource(inputPath: string): Promise<void> {
  const backupPath = `${inputPath}.corrupted.bak`;
  try {
    await fs.copyFile(inputPath, backupPath, fsConstants.COPYFILE_EXCL);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return;
    console.warn(
      `zit/variants: could not back up corrupt source "${path.basename(inputPath)}": ${(error as Error).message}`,
    );
  }
}

export interface RepairCorruptedImageOptions {
  /**
   * Before attempting repair, copy the untouched corrupt source to a sibling
   * `<name>.corrupted.bak`. Off by default — repair otherwise never touches the
   * caller's file at all. An existing `.bak` is kept, never overwritten.
   * @default false
   */
  backupCorrupted?: boolean;
}

/**
 * Attempt to recover a corrupt image by re-encoding it through an external
 * tool, returning a clean image buffer or null if repair isn't possible.
 *
 * Repair is best-effort and entirely optional. When ImageMagick (`magick`) is
 * available it is tried twice — first a strip + colourspace normalise, then a
 * format-swap re-decode through the sibling raster format (jpg<->png), which
 * recovers a bitstream the same-format pass can't. `ffmpeg` is tried last.
 * Each strategy runs only if its binary is feature-detected; on a machine with
 * neither (e.g. plain Linux without ImageMagick) this warns and returns null
 * rather than failing — a missing optional binary must never break a run.
 *
 * The caller's source file is never modified. With `backupCorrupted` set, a
 * sibling `<name>.corrupted.bak` copy is written before the attempt (the source
 * itself is still left untouched); by default no backup is made.
 */
export async function repairCorruptedImage(
  inputPath: string,
  options: RepairCorruptedImageOptions = {},
): Promise<Buffer | null> {
  if (options.backupCorrupted) {
    await backupCorruptedSource(inputPath);
  }

  if (await hasMagick()) {
    // Strategy 1: strip metadata + normalise colourspace, re-encoding to JPEG.
    const stripped = await repairWith(
      'magick',
      (input, output) => [input, '-strip', '-set', 'colorspace', 'sRGB', output],
      inputPath,
    );
    if (stripped) return stripped;

    // Strategy 2: format-swap re-decode. Re-encode through the sibling raster
    // format (jpg<->png); a bitstream the same-format strip pass can't recover
    // sometimes survives the decoder switch (issue #99).
    const swapped = await repairWith(
      'magick',
      (input, output) => [input, output],
      inputPath,
      siblingFormat(inputPath),
    );
    if (swapped) return swapped;
  }

  if (await hasFfmpeg()) {
    const repaired = await repairWith(
      'ffmpeg',
      (input, output) => [
        '-v',
        'error',
        '-err_detect',
        'ignore_err',
        '-i',
        input,
        '-vf',
        'format=yuv420p',
        '-y',
        output,
      ],
      inputPath,
    );
    if (repaired) return repaired;
  }

  if (!(await hasMagick()) && !(await hasFfmpeg())) {
    console.warn(
      `zit/variants: cannot repair "${path.basename(inputPath)}" — neither magick nor ffmpeg is available; skipping repair.`,
    );
  }
  return null;
}
