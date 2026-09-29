import { describe, expect, it } from 'vitest';
import {
  parseMediaInput,
  normalizePermalink,
  shortcodeFromPermalink,
  mediaMatchesRequest,
} from '../src/shared/mediaUrls';

describe('parseMediaInput', () => {
  it('parses bare numeric media IDs as strings', () => {
    const p = parseMediaInput('17912345678901234');
    expect(p.kind).toBe('media_id');
    expect(p.mediaId).toBe('17912345678901234');
  });

  it('parses canonical Reel URLs', () => {
    const p = parseMediaInput('https://www.instagram.com/reel/AbC123xYz_-/');
    expect(p.kind).toBe('reel');
    expect(p.shortcode).toBe('AbC123xYz_-');
    expect(p.canonicalUrl).toBe('https://www.instagram.com/reel/AbC123xYz_-/');
  });

  it('parses post URLs and strips query params', () => {
    const p = parseMediaInput('https://www.instagram.com/p/C123abcXYZ/?igsh=abc');
    expect(p.kind).toBe('post');
    expect(p.shortcode).toBe('C123abcXYZ');
  });

  it('rejects non-Instagram URLs', () => {
    expect(parseMediaInput('https://example.com/reel/abc123').kind).toBe('unknown');
    expect(parseMediaInput('not a url').shortcode).toBeNull();
  });

  it('keeps IDs as strings (never numbers)', () => {
    const p = parseMediaInput('17912345678901234');
    expect(typeof p.mediaId).toBe('string');
  });
});

describe('normalizePermalink', () => {
  it('normalizes to canonical https www form with trailing slash', () => {
    expect(normalizePermalink('https://instagram.com/reel/ABC123?utm=x#frag')).toBe(
      'https://www.instagram.com/reel/ABC123/',
    );
  });

  it('returns null for non-URLs', () => {
    expect(normalizePermalink(null)).toBeNull();
    expect(normalizePermalink('')).toBeNull();
  });
});

describe('shortcodeFromPermalink', () => {
  it('extracts shortcode from reel and post permalinks', () => {
    expect(shortcodeFromPermalink('https://www.instagram.com/reel/ABC123/')).toBe('ABC123');
    expect(shortcodeFromPermalink('https://www.instagram.com/p/XYZ789/')).toBe('XYZ789');
  });
});

describe('mediaMatchesRequest', () => {
  it('matches on exact shortcode field', () => {
    expect(
      mediaMatchesRequest({ id: '1', shortcode: 'ABC123' }, { shortcode: 'ABC123', canonicalUrl: null }),
    ).toBe(true);
  });

  it('matches on normalized permalink', () => {
    expect(
      mediaMatchesRequest(
        { id: '1', permalink: 'https://www.instagram.com/reel/ABC123/' },
        { shortcode: 'ABC123', canonicalUrl: 'https://instagram.com/reel/ABC123?utm=x' },
      ),
    ).toBe(true);
  });

  it('does not match different shortcodes', () => {
    expect(
      mediaMatchesRequest({ id: '1', permalink: 'https://www.instagram.com/reel/OTHER/' }, { shortcode: 'ABC123', canonicalUrl: null }),
    ).toBe(false);
  });

  it('requested Reel resolved after later pagination page (match works regardless of page)', () => {
    // Resolver walks pages; matching itself is page-agnostic.
    const page2Media = { id: '179999', permalink: 'https://www.instagram.com/reel/WANTED123/' };
    expect(mediaMatchesRequest(page2Media, { shortcode: 'WANTED123', canonicalUrl: 'https://www.instagram.com/reel/WANTED123/' })).toBe(true);
  });
});
