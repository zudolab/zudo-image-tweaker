import { describe, expect, it } from 'vitest';
import { defaultTagParser, noTagParser } from '../tags.js';

describe('defaultTagParser', () => {
  it('treats an untagged filename as full processing, keyed by its basename', () => {
    expect(defaultTagParser('sunset.jpg')).toEqual({ mode: 'full', slug: 'sunset' });
  });

  it('routes a __og suffix to the og pipeline and strips the suffix from the slug', () => {
    expect(defaultTagParser('hero__og.png')).toEqual({ mode: 'og', slug: 'hero' });
  });

  it('routes a __ogonly suffix to the ogonly pipeline and strips the suffix', () => {
    expect(defaultTagParser('banner__ogonly.heic')).toEqual({ mode: 'ogonly', slug: 'banner' });
  });

  it('does not confuse __ogonly for __og', () => {
    // __ogonly ends in "only", so the og branch must not claim it first.
    expect(defaultTagParser('x__ogonly.jpg').mode).toBe('ogonly');
  });

  it('ignores directory components, keying on the basename only', () => {
    expect(defaultTagParser('/a/b/c/photo__og.jpg')).toEqual({ mode: 'og', slug: 'photo' });
  });
});

describe('noTagParser', () => {
  it('always reports full mode and never strips a tag', () => {
    expect(noTagParser('hero__og.jpg')).toEqual({ mode: 'full', slug: 'hero__og' });
    expect(noTagParser('plain.png')).toEqual({ mode: 'full', slug: 'plain' });
  });
});
