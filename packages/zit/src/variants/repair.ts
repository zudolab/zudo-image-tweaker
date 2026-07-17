import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { hasFfmpeg, hasMagick } from './feature-detect.js';
import { run } from './run.js';

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
): Promise<Buffer | null> {
  const outputPath = path.join(os.tmpdir(), `zit-repair-${process.pid}-${randomUUID()}.jpg`);
  try {
    await run(command, buildArgs(inputPath, outputPath));
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
 * Attempt to recover a corrupt image by re-encoding it through an external
 * tool, returning a clean JPEG buffer or null if repair isn't possible.
 *
 * Repair is best-effort and entirely optional: ImageMagick (`magick`) is
 * tried first, then `ffmpeg`, each only if feature-detected on the host.
 * On a machine with neither (e.g. plain Linux without ImageMagick), this
 * warns and returns null rather than failing — a missing optional binary
 * must never break a run. The caller's source file is never mutated; the
 * repaired bytes are produced in a throwaway temp file.
 */
export async function repairCorruptedImage(inputPath: string): Promise<Buffer | null> {
  if (await hasMagick()) {
    const repaired = await repairWith(
      'magick',
      (input, output) => [input, '-strip', '-set', 'colorspace', 'sRGB', output],
      inputPath,
    );
    if (repaired) return repaired;
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
