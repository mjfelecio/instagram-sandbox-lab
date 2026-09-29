/**
 * Instagram scope and field mapping shared by server and client.
 * Sources: official Meta docs for Instagram API with Instagram Login
 * (Business Login, Get Started, IG Media, Media Insights, Mar 2025 Insights
 * announcement). Validated 2026-09-29, API v25.0.
 */

export const KNOWN_SCOPES = [
  'instagram_business_basic',
  'instagram_business_manage_insights',
  'instagram_business_content_publish',
  'instagram_business_manage_comments',
  'instagram_business_manage_messages',
] as const;
export type KnownScope = (typeof KNOWN_SCOPES)[number];

/** Minimum read-only set for BloxClips research path. */
export const MIN_READ_SCOPES: KnownScope[] = [
  'instagram_business_basic',
  'instagram_business_manage_insights',
];

/** Fields requested for account info (GET /me). Scope: instagram_business_basic. */
export const ACCOUNT_FIELDS = [
  'user_id',
  'username',
  'name',
  'account_type',
  'profile_picture_url',
  'followers_count',
  'follows_count',
  'media_count',
] as const;

/** App-scoped id field (distinct from stable user_id). Requested for display only. */
export const ACCOUNT_ID_FIELD = 'id' as const;

/** Fields requested for single media fetch (GET /<IG_MEDIA_ID>). */
export const MEDIA_FIELDS = [
  'id',
  'media_type',
  'permalink',
  'shortcode',
  'timestamp',
  'caption',
  'username',
  'like_count',
  'comments_count',
  'thumbnail_url',
  'media_url',
] as const;

/**
 * Experimental field probes (NOT part of the default media request).
 * - media_product_type is documented as Facebook-Login-only; requesting it under
 *   Instagram Login may reject the whole fields= request, so it must never be
 *   bundled with the core media-resolution workflow. Use the explicit probe
 *   endpoint (`POST /api/instagram/media/probe`) to test it in isolation.
 * - owner is only returned when the caller also created the media.
 */
export const OPTIONAL_MEDIA_FIELDS = ['media_product_type', 'owner'] as const;

/** Allowlist for the experimental probe endpoint (prevents arbitrary field injection). */
export const PROBEABLE_MEDIA_FIELDS: readonly string[] = OPTIONAL_MEDIA_FIELDS;

/** Default Insights metrics for Reels/Feed under Instagram Login. */
export const INSIGHT_METRICS_REELS_FEED = [
  'views',
  'reach',
  'likes',
  'comments',
  'shares',
  'saved',
  'total_interactions',
] as const;

/** Extra Insights metrics worth probing manually (follows, profile visits). */
export const INSIGHT_METRICS_EXTRA = ['follows', 'profile_visits', 'profile_activity'] as const;

/**
 * Parse INSTAGRAM_SCOPES. Unknown tokens reported separately so typos surface
 * before breaking auth.
 */
export function parseScopes(raw: string | undefined | null): {
  scopes: string[];
  unknown: string[];
} {
  const tokens = (raw ?? '')
    .split(',')
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
  const scopes: string[] = [];
  const unknown: string[] = [];
  const known = new Set<string>(KNOWN_SCOPES);
  for (const token of tokens) {
    if (known.has(token)) {
      if (!scopes.includes(token)) scopes.push(token);
    } else {
      unknown.push(token);
    }
  }
  if (scopes.length === 0) {
    scopes.push(...MIN_READ_SCOPES);
  }
  return { scopes, unknown };
}

export function hasScope(granted: string[] | undefined | null, scope: KnownScope): boolean {
  if (!granted) return false;
  return granted.includes(scope);
}

export const INSIGHTS_SCOPE = 'instagram_business_manage_insights' as const;
export const BASIC_SCOPE = 'instagram_business_basic' as const;
