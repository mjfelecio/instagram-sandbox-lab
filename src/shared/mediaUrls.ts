/**
 * Instagram Reel / post URL handling shared by server and client.
 *
 * Supported inputs:
 * - Bare numeric official media IDs (Graph media IDs are long numeric strings;
 *   keep as strings, never parse as numbers).
 * - Canonical Reel URLs: https://www.instagram.com/reel/<shortcode>/
 * - Canonical post URLs: https://www.instagram.com/p/<shortcode>/
 * - Permalink forms returned by the API (same hosts, may include query params).
 *
 * The shortcode is NOT the official media ID. Resolution to the official media
 * object happens by matching permalink/shortcode against owned media owned by
 * the connected account (bounded pagination, explicit in UI). Ownership is never
 * inferred from username alone.
 */

/** Shortcodes are 5-80 chars of [A-Za-z0-9_-]. */
const SHORTCODE_PATTERN = '[A-Za-z0-9_-]{5,80}';
const REEL_URL_PATTERN = new RegExp(`(?:instagram\\.com)?/reel/(${SHORTCODE_PATTERN})(?:[/?#]|$)`, 'i');
const POST_URL_PATTERN = new RegExp(`(?:instagram\\.com)?/p/(${SHORTCODE_PATTERN})(?:[/?#]|$)`, 'i');
const BARE_MEDIA_ID_PATTERN = /^\d{8,32}$/;
const BARE_SHORTCODE_PATTERN = /^[A-Za-z0-9_-]{5,80}$/;

export type MediaUrlKind = 'media_id' | 'reel' | 'post' | 'unknown';

export interface ParsedMediaUrl {
  kind: MediaUrlKind;
  /** Official media ID when input was a bare ID, else null. */
  mediaId: string | null;
  /** Shortcode when input was a Reel/post URL, else null. */
  shortcode: string | null;
  /** Normalized canonical URL for Reel/post inputs, else null. */
  canonicalUrl: string | null;
}

export function parseMediaInput(input: string): ParsedMediaUrl {
  const trimmed = (input ?? '').trim();
  if (!trimmed) return { kind: 'unknown', mediaId: null, shortcode: null, canonicalUrl: null };
  if (BARE_MEDIA_ID_PATTERN.test(trimmed)) {
    return { kind: 'media_id', mediaId: trimmed, shortcode: null, canonicalUrl: null };
  }
  // If input looks like an absolute URL, require an Instagram host. This prevents
  // foreign hosts like example.com/reel/<code> from being accepted.
  const looksLikeUrl = /^(https?:)?\/\//i.test(trimmed) || /^[a-z0-9.-]+\.[a-z]{2,}\//i.test(trimmed);
  if (looksLikeUrl) {
    let host: string | null = null;
    try {
      const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
      host = new URL(withScheme).hostname.toLowerCase();
    } catch {
      host = null;
    }
    if (host && !(host === 'instagram.com' || host.endsWith('.instagram.com'))) {
      return { kind: 'unknown', mediaId: null, shortcode: null, canonicalUrl: null };
    }
  }
  const reel = REEL_URL_PATTERN.exec(trimmed);
  if (reel) {
    const shortcode = reel[1];
    return { kind: 'reel', mediaId: null, shortcode, canonicalUrl: `https://www.instagram.com/reel/${shortcode}/` };
  }
  const post = POST_URL_PATTERN.exec(trimmed);
  if (post) {
    const shortcode = post[1];
    return { kind: 'post', mediaId: null, shortcode, canonicalUrl: `https://www.instagram.com/p/${shortcode}/` };
  }
  // Bare shortcode (user pasted just the code) — treat as unknown kind but
  // preserve shortcode so the resolver can still match by shortcode field.
  if (BARE_SHORTCODE_PATTERN.test(trimmed) && !/^(https?|instagram)/i.test(trimmed)) {
    return { kind: 'unknown', mediaId: null, shortcode: trimmed, canonicalUrl: null };
  }
  return { kind: 'unknown', mediaId: null, shortcode: null, canonicalUrl: null };
}

/** Normalize a permalink for comparison: lowercase host, strip query/hash, trailing slash. */
export function normalizePermalink(url: string | null | undefined): string | null {
  if (!url || typeof url !== 'string') return null;
  const trimmed = url.trim();
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed);
    const host = parsed.hostname.toLowerCase();
    if (!host.endsWith('instagram.com')) return trimmed;
    let path = parsed.pathname.replace(/\/+$/, '');
    if (!path.startsWith('/')) path = `/${path}`;
    return `https://www.instagram.com${path}/`;
  } catch {
    return null;
  }
}

/** Extract shortcode from a permalink (reel or p form), else null. */
export function shortcodeFromPermalink(permalink: string | null | undefined): string | null {
  if (!permalink || typeof permalink !== 'string') return null;
  const reel = REEL_URL_PATTERN.exec(permalink);
  if (reel) return reel[1];
  const post = POST_URL_PATTERN.exec(permalink);
  if (post) return post[1];
  return null;
}

export interface MediaIdentity {
  id?: unknown;
  permalink?: unknown;
  shortcode?: unknown;
}

/**
 * Check whether an owned-media object matches a requested shortcode or
 * canonical URL. Matches on normalized permalink OR exact shortcode field.
 */
export function mediaMatchesRequest(
  media: MediaIdentity,
  request: { shortcode: string | null; canonicalUrl: string | null },
): boolean {
  if (!request.shortcode && !request.canonicalUrl) return false;
  if (request.shortcode && typeof media.shortcode === 'string' && media.shortcode === request.shortcode) {
    return true;
  }
  const mediaPermalink = normalizePermalink(typeof media.permalink === 'string' ? media.permalink : null);
  const requestPermalink = request.canonicalUrl ? normalizePermalink(request.canonicalUrl) : null;
  if (mediaPermalink && requestPermalink && mediaPermalink === requestPermalink) return true;
  // Fallback: shortcode embedded in permalink matches requested shortcode.
  if (request.shortcode && mediaPermalink) {
    const embedded = shortcodeFromPermalink(mediaPermalink);
    if (embedded === request.shortcode) return true;
  }
  return false;
}

/** Split mixed user inputs into usable resolver inputs; invalid entries reported. */
export function extractMediaInputs(inputs: string[]): {
  parsed: ParsedMediaUrl[];
  invalid: string[];
} {
  const parsed: ParsedMediaUrl[] = [];
  const invalid: string[] = [];
  for (const raw of inputs) {
    const input = (raw ?? '').trim();
    if (!input) continue;
    const p = parseMediaInput(input);
    if (p.kind === 'unknown' && !p.shortcode) invalid.push(input);
    else parsed.push(p);
  }
  return { parsed, invalid };
}

/** Max owned-media IDs to resolve per request (bounded walk, explicit in UI). */
export const MAX_RESOLVE_PAGES = 10;
/** Page size for owned media listing. */
export const MEDIA_PAGE_SIZE = 25;
