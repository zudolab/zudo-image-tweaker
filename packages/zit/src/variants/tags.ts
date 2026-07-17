import path from 'node:path';
import type { ParsedTag, TagParser } from './types.js';

const OG_ONLY_SUFFIX = '__ogonly';
const OG_SUFFIX = '__og';

function baseSlug(filename: string): string {
  return path.basename(filename, path.extname(filename));
}

/**
 * Default filename-tag parser. A `__ogonly` suffix selects the OGP-only
 * pipeline, `__og` selects full processing plus an OGP card, and anything
 * else is a plain full-variant image. The directive suffix is stripped
 * from the returned slug so outputs land in a clean directory name.
 */
export const defaultTagParser: TagParser = (filename) => {
  const base = baseSlug(filename);
  if (base.endsWith(OG_ONLY_SUFFIX)) {
    return { mode: 'ogonly', slug: base.slice(0, -OG_ONLY_SUFFIX.length) };
  }
  if (base.endsWith(OG_SUFFIX)) {
    return { mode: 'og', slug: base.slice(0, -OG_SUFFIX.length) };
  }
  return { mode: 'full', slug: base };
};

/**
 * Tag parser that disables all OGP dispatch: every file is a plain
 * full-variant image keyed by its bare basename. Used by the photo preset.
 */
export const noTagParser: TagParser = (filename): ParsedTag => ({
  mode: 'full',
  slug: baseSlug(filename),
});
