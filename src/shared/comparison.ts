/**
 * Comparison arithmetic shared by the server tests and the client UI.
 *
 * Rules:
 * - Compare only matching media IDs and equivalent metrics.
 * - Signed difference: official minus baseline.
 * - Percentage difference relative to the baseline when baseline nonzero.
 * - Unknown values stay unknown (null) — never zero, never fabricated.
 * - Unknown baseline observation time stays unknown; never substitute import time.
 */

export const COMPARABLE_METRICS = ['views', 'likes', 'comments', 'shares', 'saves'] as const;
export type ComparableMetric = (typeof COMPARABLE_METRICS)[number];

/** A metrics snapshot for one media item, from official API or baseline. */
export interface MetricsSnapshot {
  mediaId: string;
  source?: string;
  /** ISO-8601 observation timestamp when known; stays null/undefined when unknown. */
  observedAt?: string | null;
  views?: number | null;
  likes?: number | null;
  comments?: number | null;
  shares?: number | null;
  saves?: number | null;
}

export interface MetricComparisonRow {
  metric: ComparableMetric;
  official: number | null;
  baseline: number | null;
  /** official minus baseline; null when either side unknown. */
  diff: number | null;
  /** Percent difference relative to baseline; null when baseline 0 or unknown. */
  percentDiff: number | null;
}

export interface ComparisonResult {
  mediaId: string;
  rows: MetricComparisonRow[];
  officialObservedAt: string | null;
  baselineObservedAt: string | null;
  /** Time gap between observations; null unless both timestamps known. */
  observationGapMs: number | null;
}

function asCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Extract comparable metrics from an official Instagram media object.
 * Basic fields (like_count/comments_count) and Insights values are both
 * accepted; Insights take precedence when both present (explicit in caller).
 * Missing values stay null.
 */
export function metricsFromMedia(media: Record<string, unknown>): MetricsSnapshot | null {
  const id = typeof media.id === 'string' && media.id.length > 0 ? media.id : null;
  if (!id) return null;
  const insights =
    media.insights && typeof media.insights === 'object'
      ? (media.insights as Record<string, unknown>)
      : null;
  const pick = (insightKey: string, ...basicKeys: string[]): number | null => {
    if (insights && insights[insightKey] !== undefined) {
      const v = asCount(insights[insightKey]);
      if (v !== null) return v;
      // Insights present but null/missing -> fall through to basic? No:
      // if insights object explicitly carries the key as null, keep null.
      if (insightKey in insights) return null;
    }
    for (const k of basicKeys) {
      const v = asCount(media[k]);
      if (v !== null) return v;
    }
    return null;
  };
  return {
    mediaId: id,
    views: pick('views'),
    likes: pick('likes', 'like_count'),
    comments: pick('comments', 'comments_count'),
    shares: pick('shares', 'shares_count'),
    saves: pick('saved', 'saves', 'saved_count'),
  };
}

function parseIsoOrNull(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isSameMedia(a: MetricsSnapshot, b: MetricsSnapshot): boolean {
  return a.mediaId === b.mediaId;
}

/** Compare official snapshot against baseline. Null when media IDs differ. */
export function compareMetrics(official: MetricsSnapshot, baseline: MetricsSnapshot): ComparisonResult | null {
  if (!isSameMedia(official, baseline)) return null;
  const rows: MetricComparisonRow[] = COMPARABLE_METRICS.map((metric) => {
    const officialValue = asCount(official[metric]);
    const baselineValue = asCount(baseline[metric]);
    const diff = officialValue === null || baselineValue === null ? null : officialValue - baselineValue;
    const percentDiff =
      diff === null || baselineValue === null || baselineValue === 0 ? null : (diff / baselineValue) * 100;
    return { metric, official: officialValue, baseline: baselineValue, diff, percentDiff };
  });
  const officialMs = parseIsoOrNull(official.observedAt ?? null);
  const baselineMs = parseIsoOrNull(baseline.observedAt ?? null);
  return {
    mediaId: official.mediaId,
    rows,
    officialObservedAt: official.observedAt ?? null,
    baselineObservedAt: baseline.observedAt ?? null,
    observationGapMs: officialMs === null || baselineMs === null ? null : Math.abs(officialMs - baselineMs),
  };
}

/**
 * Parse baseline JSON pasted by user.
 * Shape: { mediaId, source?, observedAt?, views?, likes?, comments?, shares?, saves? }
 */
export function parseBaselineJson(
  text: string,
): { ok: true; baseline: MetricsSnapshot } | { ok: false; error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, error: 'Not valid JSON.' };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: 'Expected a single JSON object.' };
  }
  const obj = parsed as Record<string, unknown>;
  const mediaId = typeof obj.mediaId === 'string' ? obj.mediaId.trim() : '';
  if (!mediaId) return { ok: false, error: 'Missing "mediaId" string.' };
  const observedAtRaw = obj.observedAt;
  if (observedAtRaw !== undefined && observedAtRaw !== null && typeof observedAtRaw !== 'string') {
    return { ok: false, error: '"observedAt" must be an ISO timestamp string or null.' };
  }
  if (typeof observedAtRaw === 'string' && observedAtRaw.trim().length > 0) {
    if (!Number.isFinite(Date.parse(observedAtRaw))) {
      return { ok: false, error: '"observedAt" is not a parseable timestamp.' };
    }
  }
  const source = typeof obj.source === 'string' && obj.source.trim().length > 0 ? obj.source.trim() : undefined;
  const observedAt =
    typeof observedAtRaw === 'string' && observedAtRaw.trim().length > 0
      ? new Date(Date.parse(observedAtRaw)).toISOString()
      : null;
  const counts: Partial<Record<ComparableMetric, number | null>> = {};
  for (const metric of COMPARABLE_METRICS) {
    const raw = obj[metric];
    if (raw === undefined || raw === null) {
      counts[metric] = null;
      continue;
    }
    if (typeof raw === 'number' && Number.isFinite(raw)) {
      counts[metric] = raw;
      continue;
    }
    if (typeof raw === 'string' && raw.trim() !== '' && Number.isFinite(Number(raw))) {
      counts[metric] = Number(raw);
      continue;
    }
    return { ok: false, error: `"${metric}" must be a number or null.` };
  }
  return {
    ok: true,
    baseline: {
      mediaId,
      source,
      observedAt,
      views: counts.views ?? null,
      likes: counts.likes ?? null,
      comments: counts.comments ?? null,
      shares: counts.shares ?? null,
      saves: counts.saves ?? null,
    },
  };
}
