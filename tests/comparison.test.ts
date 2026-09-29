import { describe, expect, it } from 'vitest';
import { compareMetrics, metricsFromMedia, parseBaselineJson } from '../src/shared/comparison';

describe('compareMetrics', () => {
  const official = {
    mediaId: '179123456789',
    views: 1_500_000,
    likes: 20_000,
    comments: 300,
    shares: 42,
    saves: 25,
    observedAt: '2026-09-28T10:00:00.000Z',
  };
  const baseline = {
    mediaId: '179123456789',
    views: 1_400_000,
    likes: 19_000,
    comments: 250,
    shares: null,
    saves: 20,
    observedAt: '2026-09-28T09:00:00.000Z',
  };

  it('computes signed diff official minus baseline', () => {
    const result = compareMetrics(official, baseline)!;
    expect(result.rows.find((r) => r.metric === 'views')?.diff).toBe(100_000);
    expect(result.rows.find((r) => r.metric === 'saves')?.diff).toBe(5);
  });

  it('computes percentage relative to nonzero baseline', () => {
    const result = compareMetrics(official, baseline)!;
    const views = result.rows.find((r) => r.metric === 'views')!;
    expect(views.percentDiff).toBeCloseTo((100_000 / 1_400_000) * 100, 6);
  });

  it('returns null percentDiff when baseline is zero', () => {
    const result = compareMetrics(official, { ...baseline, views: 0 })!;
    expect(result.rows.find((r) => r.metric === 'views')?.percentDiff).toBeNull();
    expect(result.rows.find((r) => r.metric === 'views')?.diff).toBe(1_500_000);
  });

  it('keeps unknown values unknown instead of zero', () => {
    const result = compareMetrics(official, baseline)!;
    const shares = result.rows.find((r) => r.metric === 'shares')!;
    expect(shares.official).toBe(42);
    expect(shares.baseline).toBeNull();
    expect(shares.diff).toBeNull();
  });

  it('rejects mismatched media IDs', () => {
    expect(compareMetrics(official, { ...baseline, mediaId: '999' })).toBeNull();
  });

  it('observation gap uses both timestamps only', () => {
    const result = compareMetrics(official, baseline)!;
    expect(result.observationGapMs).toBe(3_600_000);
    const unknownBaseline = compareMetrics(official, { ...baseline, observedAt: null })!;
    expect(unknownBaseline.observationGapMs).toBeNull();
  });

  it('never substitutes import time for unknown baseline time', () => {
    const result = compareMetrics(official, { ...baseline, observedAt: null })!;
    expect(result.baselineObservedAt).toBeNull();
    expect(result.observationGapMs).toBeNull();
  });
});

describe('metricsFromMedia', () => {
  it('extracts basic counts and keeps missing null', () => {
    const snap = metricsFromMedia({ id: '1791', like_count: 5, comments_count: 0 })!;
    expect(snap.likes).toBe(5);
    expect(snap.comments).toBe(0);
    expect(snap.views).toBeNull();
    expect(snap.shares).toBeNull();
    expect(snap.saves).toBeNull();
  });

  it('prefers Insights values when present', () => {
    const snap = metricsFromMedia({
      id: '1791',
      like_count: 5,
      insights: { likes: 7, views: 100, saved: 3 },
    })!;
    expect(snap.likes).toBe(7);
    expect(snap.views).toBe(100);
  });

  it('returns null when no usable id', () => {
    expect(metricsFromMedia({ like_count: 5 })).toBeNull();
  });

  it('zero is distinct from missing', () => {
    const snap = metricsFromMedia({ id: '1791', like_count: 0 })!;
    expect(snap.likes).toBe(0);
  });
});

describe('parseBaselineJson', () => {
  it('parses documented shape', () => {
    const r = parseBaselineJson(
      JSON.stringify({ mediaId: '1791', source: 'BloxClips public scraper', observedAt: null, views: 10, saves: 2 }),
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.baseline.saves).toBe(2);
  });

  it('rejects invalid JSON and missing mediaId', () => {
    expect(parseBaselineJson('not json').ok).toBe(false);
    expect(parseBaselineJson(JSON.stringify({ views: 1 })).ok).toBe(false);
  });

  it('rejects non-numeric metric', () => {
    expect(parseBaselineJson(JSON.stringify({ mediaId: '1', views: 'many' })).ok).toBe(false);
  });
});
