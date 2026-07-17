import fs from 'node:fs/promises';
import path from 'node:path';
import sharp, { type FormatEnum, type Metadata, type Sharp } from 'sharp';
import { encodeImageToBlurhash } from '../blurhash/index.js';
import { bakeOrientation, pickVariantWidths } from '../exif/index.js';
import { convertHeifToJpeg } from '../heif/index.js';
import { generateSmartOgp } from '../ogp/index.js';
import { hashFile, readCache, writeCache, type CacheEntry } from './hash-cache.js';
import { isHeicSource, isNonImageFile } from './heic.js';
import { isCorruptionError, repairCorruptedImage } from './repair.js';
import { defaultTagParser } from './tags.js';
import {
  DEFAULT_CACHE_FILENAME,
  DEFAULT_CONCURRENCY,
  DEFAULT_FORMATS,
  DEFAULT_OGP_FILENAME,
  DEFAULT_QUALITY,
  DEFAULT_WIDTHS,
  type ImageEntry,
  type ItemResult,
  type OgpOutput,
  type OutputNameFn,
  type ProcessFailure,
  type ProcessImagesConfig,
  type ProcessOneConfig,
  type ProcessSummary,
  type TagMode,
  type TagParser,
  type VariantMetadata,
  type VariantOutput,
} from './types.js';

/** Source file extensions the directory scanner treats as images. */
export const SUPPORTED_IMAGE_EXTENSIONS = ['jpg', 'jpeg', 'png', 'webp', 'heic', 'heif', 'gif', 'avif'];
export const IMAGE_EXTENSION_REGEX = new RegExp(`\\.(${SUPPORTED_IMAGE_EXTENSIONS.join('|')})$`, 'i');

const defaultOutputName: OutputNameFn = (width, format) => `${width}w.${format}`;

/**
 * Thrown for a stage-specific processing failure. `processImages` catches
 * it to record which pipeline stage failed; a caller invoking `processOne`
 * directly can read `stage` and the underlying `cause`.
 */
export class VariantProcessingError extends Error {
  readonly stage: ProcessFailure['stage'];
  constructor(stage: ProcessFailure['stage'], cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = 'VariantProcessingError';
    this.stage = stage;
  }
}

interface ResolvedConfig {
  outputDir: string;
  widths: number[];
  formats: string[];
  quality: number;
  outputName: OutputNameFn;
  ogpFileName: string;
  ogpOptions: NonNullable<ProcessOneConfig['ogpOptions']>;
  cacheFileName: string;
  fallbackBlurhash?: string;
  tagParser: TagParser;
  autoRepair: boolean;
  bakeExifOrientation: boolean;
  stripMetadata: boolean;
  onMetadata?: ProcessOneConfig['onMetadata'];
  onError?: ProcessOneConfig['onError'];
}

function resolveConfig(config: ProcessOneConfig): ResolvedConfig {
  return {
    outputDir: config.outputDir,
    widths: config.widths ?? DEFAULT_WIDTHS,
    formats: config.formats ?? DEFAULT_FORMATS,
    quality: config.quality ?? DEFAULT_QUALITY,
    outputName: config.outputName ?? defaultOutputName,
    ogpFileName: config.ogpFileName ?? DEFAULT_OGP_FILENAME,
    ogpOptions: config.ogpOptions ?? {},
    cacheFileName: config.cacheFileName ?? DEFAULT_CACHE_FILENAME,
    fallbackBlurhash: config.fallbackBlurhash,
    tagParser: config.tagParser ?? defaultTagParser,
    autoRepair: config.autoRepair ?? true,
    bakeExifOrientation: config.bakeExifOrientation ?? false,
    stripMetadata: config.stripMetadata ?? false,
    onMetadata: config.onMetadata,
    onError: config.onError,
  };
}

/**
 * The widths actually emitted for a source: every configured width that
 * doesn't upscale it (via `/exif`'s pickVariantWidths), or — when the
 * source is smaller than every configured width — a single variant at the
 * source's own width so even a tiny image gets one representation.
 */
export function selectVariantWidths(sourceWidth: number, widths: number[]): number[] {
  const fitted = pickVariantWidths(sourceWidth, widths);
  return fitted.length > 0 ? fitted : [sourceWidth];
}

function roundTo(value: number, digits: number): number {
  return Number(value.toFixed(digits));
}

function passthroughName(inputPath: string): string {
  return `original${path.extname(inputPath).toLowerCase()}`;
}

/**
 * A slug must be a single, safe directory segment. This rejects `''`, `.`,
 * `..`, and anything containing a path separator or NUL — a filename like
 * `...jpg` otherwise parses to the slug `..`, which would escape outputDir.
 */
function isSafeSlug(slug: string): boolean {
  return (
    slug.length > 0 &&
    slug !== '.' &&
    slug !== '..' &&
    !slug.includes('/') &&
    !slug.includes('\\') &&
    !slug.includes('\0')
  );
}

/**
 * A stable fingerprint of the output-affecting config, stored alongside the
 * source hash so a rerun with a changed quality/OGP/blurhash/orientation
 * option invalidates the cache even when the source bytes are identical.
 *
 * The custom `outputName` naming scheme is deliberately NOT fingerprinted
 * here: the emitted filenames depend on the (not-yet-probed) source width
 * for the sub-min-width fallback, so a pre-probe fingerprint can't capture
 * them. Naming identity is enforced instead by the persisted output manifest
 * (`CacheEntry.outputs`), compared in the cache check — which also covers
 * that fallback filename.
 */
function fingerprintConfig(cfg: ResolvedConfig): string {
  return JSON.stringify({
    quality: cfg.quality,
    widths: cfg.widths,
    formats: cfg.formats,
    ogpFileName: cfg.ogpFileName,
    ogpOptions: cfg.ogpOptions,
    fallbackBlurhash: cfg.fallbackBlurhash ?? null,
    bakeExifOrientation: cfg.bakeExifOrientation,
    stripMetadata: cfg.stripMetadata,
  });
}

/** Order-independent equality of two filename lists (the output manifest). */
function sameFileSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sortedA = [...a].sort();
  const sortedB = [...b].sort();
  return sortedA.every((name, i) => name === sortedB[i]);
}

function applyFormat(pipeline: Sharp, format: string, quality: number): Sharp {
  switch (format) {
    case 'webp':
      return pipeline.webp({ quality });
    case 'jpg':
    case 'jpeg':
      return pipeline.jpeg({ quality, progressive: true, mozjpeg: true });
    case 'png':
      return pipeline.png();
    case 'avif':
      return pipeline.avif({ quality });
    default:
      return pipeline.toFormat(format as keyof FormatEnum, { quality });
  }
}

async function probeWithRepair(
  input: string | Buffer,
  autoRepair: boolean,
): Promise<{ metadata: Metadata; input: string | Buffer }> {
  try {
    return { metadata: await sharp(input).metadata(), input };
  } catch (error) {
    // Repair operates on a file path (magick/ffmpeg read files); a Buffer
    // input here is already a freshly decoded intermediate, so there's
    // nothing on disk to repair.
    if (autoRepair && typeof input === 'string' && isCorruptionError(error)) {
      const repaired = await repairCorruptedImage(input);
      if (repaired) {
        return { metadata: await sharp(repaired).metadata(), input: repaired };
      }
    }
    throw error;
  }
}

async function tryBlurhash(
  input: string | Buffer,
  slug: string,
  fallback: string | undefined,
): Promise<string | null> {
  try {
    return await encodeImageToBlurhash(input);
  } catch (error) {
    console.warn(`zit/variants: blurhash encoding failed for "${slug}": ${(error as Error).message}`);
    return fallback ?? null;
  }
}

async function generateVariants(
  input: string | Buffer,
  imageOutputDir: string,
  sourceWidth: number,
  cfg: ResolvedConfig,
): Promise<VariantOutput[]> {
  const outputs: VariantOutput[] = [];
  for (const width of selectVariantWidths(sourceWidth, cfg.widths)) {
    for (const format of cfg.formats) {
      const filename = cfg.outputName(width, format);
      const outputPath = path.join(imageOutputDir, filename);
      // Colour management (issue #71), verified empirically on sharp 0.35.3
      // with pixel-level probes on a Display-P3 fixture:
      // - default: `keepIccProfile()` retains the source ICC profile with
      //   the pixel values untouched, across the webp/jpeg/png/avif
      //   encoders. This keeps a wide-gamut source (Display-P3 iPhone
      //   photos, or the profile `/heif` deliberately embeds in its
      //   HEIC→JPEG intermediate) rendering exactly as shot, with no
      //   sRGB gamut clip.
      // - stripMetadata: sharp's default pipeline honours the embedded
      //   input profile — pixels are genuinely converted to sRGB and
      //   emitted untagged, so stripping the profile introduces no colour
      //   shift (strip-after-convert, not strip-and-mis-render).
      const pipeline = sharp(input).rotate().resize({ width, withoutEnlargement: true });
      if (!cfg.stripMetadata) pipeline.keepIccProfile();
      const { size } = await applyFormat(pipeline, format, cfg.quality).toFile(outputPath);
      outputs.push({ width, format, filename, path: outputPath, size });
    }
  }
  return outputs;
}

async function generateOgp(
  input: string | Buffer,
  imageOutputDir: string,
  cfg: ResolvedConfig,
): Promise<OgpOutput> {
  const outputPath = path.join(imageOutputDir, cfg.ogpFileName);
  const result = await generateSmartOgp(input, {
    quality: cfg.quality,
    ...cfg.ogpOptions,
    outPath: outputPath,
  });
  return {
    filename: cfg.ogpFileName,
    path: outputPath,
    size: result.buffer.length,
    method: result.method,
  };
}

function expectedOutputs(
  mode: TagMode,
  cache: CacheEntry,
  inputPath: string,
  cfg: ResolvedConfig,
): string[] | null {
  if (mode === 'ogonly') return [cfg.ogpFileName];
  if (cache.animated) {
    // Animated passthrough emits the copied original, plus an OGP card when
    // tagged __og (generated from the first frame).
    return mode === 'og' ? [passthroughName(inputPath), cfg.ogpFileName] : [passthroughName(inputPath)];
  }
  const width = cache.metadata?.width;
  if (!width) return null; // no cached dimensions → can't verify, force reprocessing
  const files: string[] = [];
  for (const w of selectVariantWidths(width, cfg.widths)) {
    for (const format of cfg.formats) {
      files.push(cfg.outputName(w, format));
    }
  }
  if (mode === 'og') files.push(cfg.ogpFileName);
  return files;
}

async function allExist(dir: string, files: string[]): Promise<boolean> {
  for (const file of files) {
    try {
      await fs.access(path.join(dir, file));
    } catch {
      return false;
    }
  }
  return true;
}

/**
 * Process a single image end-to-end: HEIC conversion, content-hash cache
 * check, corruption repair, blurhash, width variants (or animated-GIF
 * passthrough), and optional OGP — dispatched by the entry's tag.
 *
 * Throws {@link VariantProcessingError} on a genuine processing failure
 * (carrying the failing `stage`); returns a `skipped` result for a
 * deliberate skip (cache hit, or a non-image guard trip).
 */
export async function processOne(entry: ImageEntry, config: ProcessOneConfig): Promise<ItemResult> {
  const cfg = resolveConfig(config);
  const { inputPath } = entry;
  const { mode, slug } = entry.tag ?? cfg.tagParser(path.basename(inputPath));
  if (!isSafeSlug(slug)) {
    throw new VariantProcessingError(
      'slug',
      new Error(`unsafe output slug "${slug}" derived from "${path.basename(inputPath)}"`),
    );
  }
  const imageOutputDir = path.join(cfg.outputDir, slug);

  const base = { slug, inputPath, outputDir: imageOutputDir, mode } as const;
  const cachePath = path.join(imageOutputDir, cfg.cacheFileName);
  const configHash = fingerprintConfig(cfg);

  // Cache check first — the content hash is of the untouched source, so a
  // hit lets us skip before the costly work (HEIC decode, `file` sniff). A
  // config change (different quality, etc.) invalidates it even when the
  // source bytes are unchanged.
  const fileHash = await hashFile(inputPath);
  const cache = await readCache(cachePath);
  // `cache.mode` gates on the tag pipeline too: a pre-`mode` (older-format)
  // entry has it undefined and so never matches, which safely forces a
  // one-time reprocess rather than a crash.
  if (cache && cache.hash === fileHash && cache.configHash === configHash && cache.mode === mode) {
    const expected = expectedOutputs(mode, cache, inputPath, cfg);
    // The manifest guards against a stale hit under a changed naming scheme:
    // the current config's expected filenames must match the ones the cached
    // run actually emitted (older entries without `outputs` never match).
    if (
      expected &&
      Array.isArray(cache.outputs) &&
      sameFileSet(expected, cache.outputs) &&
      (await allExist(imageOutputDir, expected))
    ) {
      if (cache.metadata) await cfg.onMetadata?.(cache.metadata);
      return {
        ...base,
        status: 'skipped',
        reason: 'cache-hit',
        animated: cache.animated,
        variants: [],
        ogp: null,
        metadata: cache.metadata,
      };
    }
  }

  if (await isNonImageFile(inputPath)) {
    return { ...base, status: 'skipped', reason: 'not-an-image', animated: false, variants: [], ogp: null, metadata: null };
  }

  await fs.mkdir(imageOutputDir, { recursive: true });

  let processInput: string | Buffer = inputPath;
  if (await isHeicSource(inputPath)) {
    try {
      processInput = (await convertHeifToJpeg(inputPath, { quality: 90 })).buffer;
    } catch (error) {
      throw new VariantProcessingError('heic', error);
    }
  }

  // `metadata()` reads the header only, so it can succeed on a header-valid
  // but pixel-truncated file; that corruption surfaces later in the decode.
  let metadata: Metadata;
  try {
    const probed = await probeWithRepair(processInput, cfg.autoRepair);
    metadata = probed.metadata;
    processInput = probed.input;
  } catch (error) {
    throw new VariantProcessingError('probe', error);
  }

  const displayWidth = metadata.autoOrient?.width || metadata.width || 0;
  const displayHeight = metadata.autoOrient?.height || metadata.height || 0;
  if (!displayWidth || !displayHeight) {
    throw new VariantProcessingError('probe', new Error(`could not determine dimensions for "${slug}"`));
  }
  const animated = metadata.format === 'gif' && (metadata.pages ?? 1) > 1;

  if (mode === 'ogonly') {
    let ogp: OgpOutput;
    try {
      ogp = await generateOgp(processInput, imageOutputDir, cfg);
    } catch (error) {
      throw new VariantProcessingError('ogp', error);
    }
    await writeCache(cachePath, {
      hash: fileHash,
      configHash,
      mode,
      animated,
      outputs: [ogp.filename],
      metadata: null,
    });
    return { ...base, status: 'processed', animated, variants: [], ogp, metadata: null };
  }

  let blurhash: string | null;
  let variants: VariantOutput[] = [];
  let ogp: OgpOutput | null = null;

  if (animated) {
    blurhash = await tryBlurhash(processInput, slug, cfg.fallbackBlurhash);
    try {
      await fs.copyFile(inputPath, path.join(imageOutputDir, passthroughName(inputPath)));
    } catch (error) {
      throw new VariantProcessingError('passthrough', error);
    }
    // __og still gets an OGP card, generated from the first frame.
    if (mode === 'og') {
      try {
        ogp = await generateOgp(processInput, imageOutputDir, cfg);
      } catch (error) {
        throw new VariantProcessingError('ogp', error);
      }
    }
  } else {
    // Run the decode-heavy stages together so a pixel-level corruption error
    // from any of them (bake, variants, OGP) can trigger one repair of the
    // original file and a single retry from the repaired bytes. Baking
    // orientation via `/exif` also strips metadata, so stripMetadata routes
    // through it too — stripping the EXIF tag without baking would leave a
    // sideways image once the variant pipeline auto-orients.
    // OGP is tagged with its own stage so a failure there is reported as
    // 'ogp', not 'variants' — but it still runs inside runPipeline so a
    // corruption that only surfaces at OGP shares the single repair+retry.
    const runPipeline = async (src: string | Buffer) => {
      const oriented = cfg.bakeExifOrientation || cfg.stripMetadata ? await bakeOrientation(src) : src;
      const bh = await tryBlurhash(oriented, slug, cfg.fallbackBlurhash);
      const vs = await generateVariants(oriented, imageOutputDir, displayWidth, cfg);
      let og: OgpOutput | null = null;
      if (mode === 'og') {
        try {
          og = await generateOgp(oriented, imageOutputDir, cfg);
        } catch (error) {
          throw new VariantProcessingError('ogp', error);
        }
      }
      return { blurhash: bh, variants: vs, ogp: og };
    };

    let pipeline: Awaited<ReturnType<typeof runPipeline>>;
    try {
      pipeline = await runPipeline(processInput);
    } catch (error) {
      // A stage-tagged OGP failure carries the underlying error as `cause`;
      // unwrap it so the repair check sees the real corruption signature.
      const cause = error instanceof VariantProcessingError ? error.cause : error;
      const repaired =
        cfg.autoRepair && typeof processInput === 'string' && isCorruptionError(cause)
          ? await repairCorruptedImage(processInput)
          : null;
      if (!repaired) {
        // Preserve the originating stage ('ogp' when OGP threw), defaulting
        // the untagged bake/blurhash/variants failures to 'variants'.
        if (error instanceof VariantProcessingError) throw error;
        throw new VariantProcessingError('variants', error);
      }
      pipeline = await runPipeline(repaired);
    }
    ({ blurhash, variants, ogp } = pipeline);
  }

  const originalFormat = path.extname(inputPath).slice(1).toLowerCase();
  const record: VariantMetadata = {
    slug,
    blurhash,
    width: displayWidth,
    height: displayHeight,
    aspectRatio: roundTo((displayHeight / displayWidth) * 100, 2),
    hasVariants: !animated && variants.length > 0,
    hash: fileHash,
    processedAt: new Date().toISOString(),
  };
  if (originalFormat && originalFormat !== 'webp') {
    record.originalFormat = originalFormat;
  }

  const outputs = [
    ...variants.map((v) => v.filename),
    ...(ogp ? [ogp.filename] : []),
    ...(animated ? [passthroughName(inputPath)] : []),
  ];
  try {
    await writeCache(cachePath, { hash: fileHash, configHash, mode, animated, outputs, metadata: record });
  } catch (error) {
    throw new VariantProcessingError('cache', error);
  }
  await cfg.onMetadata?.(record);

  return { ...base, status: 'processed', animated, variants, ogp, metadata: record };
}

async function collectFiles(config: ProcessImagesConfig): Promise<string[]> {
  const files: string[] = [];
  if (config.inputDir) {
    const inputDir = config.inputDir;
    let names: string[];
    try {
      names = await fs.readdir(inputDir);
    } catch (error) {
      throw new Error(`variants: could not read inputDir "${inputDir}": ${(error as Error).message}`, {
        cause: error,
      });
    }
    for (const name of names.sort()) {
      if (IMAGE_EXTENSION_REGEX.test(name)) files.push(path.join(inputDir, name));
    }
  }
  if (config.files) files.push(...config.files);
  return files;
}

async function mapWithConcurrency<T>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  const pool = Math.max(1, Math.min(limit, items.length));
  let cursor = 0;
  const runners = Array.from({ length: pool }, async () => {
    while (cursor < items.length) {
      const item = items[cursor++];
      await worker(item);
    }
  });
  await Promise.all(runners);
}

async function cleanupOrphans(outputDir: string, keepSlugs: Set<string>): Promise<string[]> {
  const removed: string[] = [];
  let dirents;
  try {
    dirents = await fs.readdir(outputDir, { withFileTypes: true });
  } catch {
    return removed;
  }
  const resolvedRoot = path.resolve(outputDir);
  for (const dirent of dirents) {
    if (!dirent.isDirectory() || keepSlugs.has(dirent.name)) continue;
    const target = path.resolve(outputDir, dirent.name);
    // Hard safety rail: only ever remove a direct child directory of the
    // configured output dir — never anything above or beside it.
    if (path.dirname(target) !== resolvedRoot) continue;
    await fs.rm(target, { recursive: true, force: true });
    removed.push(target);
  }
  return removed;
}

/**
 * Process every source image from `inputDir` and/or an explicit `files`
 * list, with bounded concurrency and a collect-and-continue error policy:
 * one bad file lands in `ProcessSummary.failed[]` and never aborts the run.
 * Orphan output directories are pruned only when `cleanupOrphans` is set.
 */
export async function processImages(config: ProcessImagesConfig): Promise<ProcessSummary> {
  const cfg = resolveConfig(config);
  // Validate up front (as compositeBatch does): NaN would make the pool
  // empty and silently process nothing; Infinity would drop the bound.
  const concurrency = config.concurrency ?? DEFAULT_CONCURRENCY;
  if (!Number.isFinite(concurrency) || concurrency < 1) {
    throw new Error(
      `processImages: concurrency must be a finite number >= 1, received ${concurrency}`,
    );
  }
  const paths = await collectFiles(config);

  const results: ItemResult[] = [];
  const failed: ProcessFailure[] = [];

  const report = async (failure: ProcessFailure): Promise<void> => {
    failed.push(failure);
    await cfg.onError?.(failure);
  };

  // Parse each filename's tag inside the collect-and-continue path: a custom
  // tagParser that throws for one file records a 'slug'-stage failure and
  // keeps going, rather than rejecting the whole batch.
  const entries: ImageEntry[] = [];
  let tagParseFailed = false;
  for (const inputPath of paths) {
    try {
      entries.push({ inputPath, tag: cfg.tagParser(path.basename(inputPath)) });
    } catch (error) {
      tagParseFailed = true;
      await report({
        inputPath,
        slug: path.basename(inputPath),
        stage: 'slug',
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // Two inputs that normalise to the same slug would race on one output
  // directory (and thrash each other's cache on later runs), so any slug
  // claimed by more than one input is rejected up front rather than
  // processed non-deterministically.
  const bySlug = new Map<string, ImageEntry[]>();
  for (const entry of entries) {
    const group = bySlug.get(entry.tag!.slug);
    if (group) group.push(entry);
    else bySlug.set(entry.tag!.slug, [entry]);
  }

  const unique: ImageEntry[] = [];
  for (const [slug, group] of bySlug) {
    if (group.length === 1) {
      unique.push(group[0]);
      continue;
    }
    for (const entry of group) {
      await report({
        inputPath: entry.inputPath,
        slug,
        stage: 'slug',
        error: `duplicate output slug "${slug}" — ${group.length} inputs map to the same output directory`,
      });
    }
  }

  await mapWithConcurrency(unique, concurrency, async (entry) => {
    try {
      results.push(await processOne(entry, config));
    } catch (error) {
      await report({
        inputPath: entry.inputPath,
        slug: entry.tag?.slug ?? path.basename(entry.inputPath),
        stage: error instanceof VariantProcessingError ? error.stage : 'unknown',
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // Keep every slug an input maps to (including duplicated ones) so cleanup
  // never deletes a directory that still corresponds to a source file. A
  // thrown tagParser leaves its input out of `entries`, so its slug is
  // unknown and can't be added to the keep-set — skip cleanup entirely in
  // that case rather than risk deleting that input's still-backed outputs.
  const removed =
    config.cleanupOrphans && !tagParseFailed
      ? await cleanupOrphans(cfg.outputDir, new Set(entries.map((e) => e.tag!.slug)))
      : [];

  return { results, failed, removed };
}
