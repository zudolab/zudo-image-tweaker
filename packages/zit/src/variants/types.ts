import type { SmartOgpOptions } from '../ogp/index.js';

/**
 * Default responsive-image widths. Kept in lockstep with the width/srcset
 * contract the package documents ([600, 900, 1200, 1600, 2000]); a source
 * whose own width is smaller never gets upscaled past it.
 */
export const DEFAULT_WIDTHS = [600, 900, 1200, 1600, 2000];
export const DEFAULT_QUALITY = 85;
export const DEFAULT_FORMATS = ['webp'];
export const DEFAULT_CONCURRENCY = 4;
export const DEFAULT_OGP_FILENAME = 'ogp.jpg';
export const DEFAULT_CACHE_FILENAME = '.cache.json';

/** Which pipeline a single file runs through, chosen by the filename-tag parser. */
export type TagMode = 'full' | 'og' | 'ogonly';

/** The parsed result of a filename tag: the pipeline to run plus the identity slug. */
export interface ParsedTag {
  mode: TagMode;
  /** Directory name (under the output dir) this image's outputs are written into. */
  slug: string;
}

/**
 * Derive a {@link ParsedTag} from a source filename (basename, extension
 * included). Fully replaceable so a caller can define their own tag
 * vocabulary or disable tag dispatch entirely.
 */
export type TagParser = (filename: string) => ParsedTag;

/** Builds a variant's output filename from its width and format. */
export type OutputNameFn = (width: number, format: string) => string;

/**
 * The per-image record handed to {@link ProcessOneConfig.onMetadata}. The
 * engine itself never persists this anywhere — persistence (a DB, a JSON
 * index, nothing at all) is entirely the caller's decision.
 */
export interface VariantMetadata {
  /** Output directory name / stable identity key for this image. */
  slug: string;
  /** blurhash string, or null when encoding failed and no fallback was configured. */
  blurhash: string | null;
  /** Displayed (EXIF-oriented) width in pixels. */
  width: number;
  /** Displayed (EXIF-oriented) height in pixels. */
  height: number;
  /** height / width as a percentage, rounded to 2 dp (an intrinsic-ratio box value). */
  aspectRatio: number;
  /** Whether raster width variants were produced (false for animated-GIF passthrough). */
  hasVariants: boolean;
  /** Content hash of the source file, used for cache invalidation. */
  hash: string;
  /** ISO-8601 timestamp of when this record was produced. */
  processedAt: string;
  /** Source container format (extension, lowercased) when it isn't plain `webp`. */
  originalFormat?: string;
}

export interface VariantOutput {
  width: number;
  format: string;
  filename: string;
  /** Absolute path to the written variant file. */
  path: string;
  size: number;
}

export interface OgpOutput {
  filename: string;
  path: string;
  size: number;
  method: 'landscape' | 'composite';
}

export type ItemStatus = 'processed' | 'skipped';

export interface ItemResult {
  slug: string;
  inputPath: string;
  /** The per-image output directory (`config.outputDir` joined with the slug). */
  outputDir: string;
  status: ItemStatus;
  /** Present when status is 'skipped'. */
  reason?: 'cache-hit' | 'not-an-image';
  mode: TagMode;
  animated: boolean;
  variants: VariantOutput[];
  ogp: OgpOutput | null;
  metadata: VariantMetadata | null;
}

export interface ProcessFailure {
  inputPath: string;
  slug: string;
  /** Coarse pipeline stage the failure surfaced from, for triage. */
  stage: 'slug' | 'heic' | 'probe' | 'variants' | 'ogp' | 'passthrough' | 'cache' | 'unknown';
  error: string;
}

export interface ProcessSummary {
  /** Successfully handled images (both freshly processed and cache-hit skips). */
  results: ItemResult[];
  /** One entry per file that threw; the run itself never throws for these. */
  failed: ProcessFailure[];
  /** Absolute paths of orphaned output directories removed (only when cleanup was opted into). */
  removed: string[];
}

/** A single image to process, as accepted by {@link processOne}. */
export interface ImageEntry {
  inputPath: string;
  /** Pre-resolved tag; when omitted, `config.tagParser` derives it from the filename. */
  tag?: ParsedTag;
}

export interface ProcessOneConfig {
  /** Root directory the per-image slug directories are created under. Required. */
  outputDir: string;
  /** Responsive widths to emit. @default DEFAULT_WIDTHS */
  widths?: number[];
  /** Output formats per width. @default ['webp'] */
  formats?: string[];
  /** Encode quality (1-100) for variants and OGP. @default 85 */
  quality?: number;
  /** Names each variant file. @default `${width}w.${format}` */
  outputName?: OutputNameFn;
  /** OGP output filename within the slug directory. @default 'ogp.jpg' */
  ogpFileName?: string;
  /** Extra options forwarded to `/ogp`'s generateSmartOgp. */
  ogpOptions?: SmartOgpOptions;
  /** Cache sidecar filename within the slug directory. @default '.cache.json' */
  cacheFileName?: string;
  /** blurhash to record when encoding fails. No baked default — omit and the record's blurhash is null. */
  fallbackBlurhash?: string;
  /** Filename-tag parser. @default the `__og` / `__ogonly` parser */
  tagParser?: TagParser;
  /** Attempt to repair corrupt sources via magick/ffmpeg when available. @default true */
  autoRepair?: boolean;
  /**
   * Bake EXIF orientation into pixels. The pipeline ALWAYS does this —
   * the variant encode chain (and blurhash/OGP) auto-orient via sharp's
   * `.rotate()`, and no output ever carries an EXIF orientation tag — so
   * enabling this flag changes nothing (issue #29: it previously added
   * only a redundant lossy pre-encode). Retained for API compatibility.
   * See the `stripMetadata` behavior matrix for the full metadata
   * semantics.
   * @default false
   */
  bakeExifOrientation?: boolean;
  /**
   * Strip ALL metadata — including the ICC profile — from the emitted
   * variants.
   *
   * Behavior matrix for `stripMetadata` × `bakeExifOrientation` — what each
   * combination means for the emitted variant files (issues #71, #29):
   *
   * | stripMetadata | bakeExifOrientation | EXIF    | XMP     | ICC profile | pixel orientation   | colour handling                          |
   * |---------------|---------------------|---------|---------|-------------|---------------------|------------------------------------------|
   * | false         | false               | dropped | dropped | retained    | baked (encode-time) | source-space pixels + profile carried    |
   * | false         | true                | dropped | dropped | retained    | baked (encode-time) | source-space pixels + profile carried    |
   * | true          | false               | dropped | dropped | dropped     | baked (encode-time) | pixels genuinely converted to sRGB first |
   * | true          | true                | dropped | dropped | dropped     | baked (encode-time) | pixels genuinely converted to sRGB first |
   *
   * Each variant is produced by exactly ONE encode of the source — no
   * combination adds an intermediate re-encode, so `bakeExifOrientation`
   * rows are byte-identical to their flagless counterparts.
   *
   * - EXIF and XMP are always dropped: sharp strips them on every encode
   *   unless explicitly asked to keep them, and this pipeline never asks.
   *   The EXIF orientation tag is therefore never emitted; instead the
   *   rotation/flip it describes is always physically baked into the
   *   pixels at encode time via the variant chain's `.rotate()`
   *   (blurhash and OGP auto-orient the same way on their own).
   * - With `stripMetadata: false`, the ICC profile is retained via sharp's
   *   `keepIccProfile()`: pixel values stay in the source colour space and
   *   the profile carries through byte-identically, so a Display-P3 photo
   *   (every modern iPhone) keeps its full gamut and renders exactly as
   *   shot in any colour-managed viewer.
   * - With `stripMetadata: true`, the profile is stripped strictly
   *   AFTER conversion, never instead of it: sharp 0.35.3's default
   *   pipeline honours the embedded input profile and genuinely converts
   *   the pixels to sRGB (verified pixel-level on a P3 fixture), so the
   *   untagged output renders correctly — at the cost of clipping
   *   wide-gamut colours to sRGB.
   * @default false
   */
  stripMetadata?: boolean;
  /** Invoked (and awaited) with each produced/cache-hit VariantMetadata record. */
  onMetadata?: (record: VariantMetadata) => void | Promise<void>;
  /** Invoked (and awaited) once per failing file. The engine writes no report anywhere. */
  onError?: (report: ProcessFailure) => void | Promise<void>;
}

export interface ProcessImagesConfig extends ProcessOneConfig {
  /** Directory scanned for source images. Mutually usable with `files`. */
  inputDir?: string;
  /** Explicit list of source file paths, instead of (or in addition to) scanning inputDir. */
  files?: string[];
  /** Max images processed concurrently. @default 4 */
  concurrency?: number;
  /**
   * Remove output slug directories that no longer correspond to any input.
   * Opt-in, and only ever touches directories directly under `outputDir`.
   * @default false
   */
  cleanupOrphans?: boolean;
}
