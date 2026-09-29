/**
 * Instagram Sandbox Lab UI: header (connection/scopes/callback), Tab A (account),
 * Tab B (owned media + resolve), Tab C (Insights), Tab D (compare).
 * Provider/user content rendered as text nodes only — never innerHTML.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, type StatusResponse } from './api';
import { formatCount, formatIso, formatGap, formatPercentDiff, formatSignedDiff } from './format';

type Tab = 'account' | 'media' | 'insights' | 'compare';

interface MediaRow {
  id: string;
  mediaType: string | null;
  mediaProductType: string | null;
  permalink: string | null;
  shortcode: string | null;
  timestamp: string | null;
  caption: string | null;
  username: string | null;
  likeCount: number | null;
  commentsCount: number | null;
  thumbnailUrl: string | null;
  mediaUrl: string | null;
}

function normalizeMedia(raw: Record<string, unknown>): MediaRow | null {
  const id = typeof raw.id === 'string' ? raw.id : null;
  if (!id) return null;
  const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
  return {
    id,
    mediaType: str(raw.media_type),
    mediaProductType: str(raw.media_product_type),
    permalink: str(raw.permalink),
    shortcode: str(raw.shortcode),
    timestamp: str(raw.timestamp),
    caption: str(raw.caption),
    username: str(raw.username),
    likeCount: num(raw.like_count),
    commentsCount: num(raw.comments_count),
    thumbnailUrl: str(raw.thumbnail_url),
    mediaUrl: str(raw.media_url),
  };
}

interface FetchMeta {
  startedAt: number;
  receivedAt: number;
  httpStatus: number;
  providerError: { code: string; message: string; type?: string } | null;
  transportError?: string;
  precisionWarnings: string[];
  rawBody: string;
  sanitizedUrl?: string;
  requestedFields: string[];
  requestedMetrics?: string[];
}

function JsonDetails({ label, text }: { label: string; text: string }) {
  const [open, setOpen] = useState(false);
  let pretty = text;
  try {
    pretty = JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    /* keep raw */
  }
  return (
    <div>
      <button type="button" onClick={() => setOpen(!open)}>
        {open ? 'Hide' : 'Show'} {label}
      </button>
      {open && <pre style={{ maxHeight: 320, overflow: 'auto', background: '#111', color: '#ddd', padding: 8, fontSize: 12 }}>{pretty}</pre>}
    </div>
  );
}

const DEFAULT_INSIGHT_METRICS = ['views', 'reach', 'likes', 'comments', 'shares', 'saved', 'total_interactions'];

export default function App() {
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [tab, setTab] = useState<Tab>('account');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [account, setAccount] = useState<{ data: unknown; fields: string[]; meta: FetchMeta } | null>(null);

  const [mediaIds, setMediaIds] = useState<string[]>([]);
  const [after, setAfter] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [mediaListMeta, setMediaListMeta] = useState<FetchMeta | null>(null);
  const [medias, setMedias] = useState<MediaRow[]>([]);
  const [mediaFetchMeta, setMediaFetchMeta] = useState<FetchMeta | null>(null);
  const [notReturned, setNotReturned] = useState<string[]>([]);
  const [resolveInput, setResolveInput] = useState('');
  const [resolveResult, setResolveResult] = useState<{ media: MediaRow | null; pagesWalked: number; meta: FetchMeta; note?: string } | null>(null);
  const [selected, setSelected] = useState<MediaRow | null>(null);

  const [insights, setInsights] = useState<{ map: Record<string, number | null>; meta: FetchMeta; mediaId: string } | null>(null);
  const [insightsMetricsText, setInsightsMetricsText] = useState(DEFAULT_INSIGHT_METRICS.join(','));

  const loadStatus = useCallback(async () => {
    try {
      setStatus(await api.status());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void loadStatus();
    const params = new URLSearchParams(window.location.search);
    if (params.get('connected') === '1' || params.get('auth_error')) {
      window.history.replaceState({}, '', window.location.pathname);
      void loadStatus();
    }
  }, [loadStatus]);

  const fetchAccount = useCallback(async () => {
    setBusy('account');
    setError(null);
    try {
      const payload = await api.account();
      setAccount({
        data: payload.data,
        fields: payload.requestedFields,
        meta: {
          startedAt: payload.startedAt, receivedAt: payload.receivedAt, httpStatus: payload.httpStatus,
          providerError: payload.providerError, transportError: payload.transportError,
          precisionWarnings: payload.precisionWarnings, rawBody: payload.rawBody,
          sanitizedUrl: payload.sanitizedUrl, requestedFields: payload.requestedFields,
        },
      });
      if (!payload.ok) setError(describeFailure('Account fetch failed', payload));
      await loadStatus();
    } catch (e) {
      setError(describeThrown('Account fetch failed', e));
    } finally {
      setBusy(null);
    }
  }, [loadStatus]);

  const fetchMediaIds = useCallback(async (cursor: string | null, append: boolean) => {
    setBusy('media');
    setError(null);
    try {
      const payload = await api.mediaList(cursor, 25);
      const meta: FetchMeta = {
        startedAt: payload.startedAt, receivedAt: payload.receivedAt, httpStatus: payload.httpStatus,
        providerError: payload.providerError, transportError: payload.transportError,
        precisionWarnings: payload.precisionWarnings, rawBody: payload.rawBody,
        sanitizedUrl: payload.sanitizedUrl, requestedFields: [],
      };
      if (payload.ok) {
        setMediaIds((prev) => (append ? [...prev, ...payload.ids.filter((id) => !prev.includes(id))] : payload.ids));
        setAfter(payload.after);
        setHasMore(payload.hasMore);
        setMediaListMeta(meta);
      } else {
        setError(describeFailure('Media list failed', payload));
      }
    } catch (e) {
      setError(describeThrown('Media list failed', e));
    } finally {
      setBusy(null);
    }
  }, []);

  const fetchDetails = useCallback(async (ids: string[]) => {
    if (ids.length === 0) return;
    setBusy('details');
    setError(null);
    try {
      const payload = await api.mediaFetch(ids.slice(0, 25));
      const rows = payload.medias.map(normalizeMedia).filter((m): m is MediaRow => m !== null);
      setMedias((prev) => {
        const seen = new Set(prev.map((m) => m.id));
        const next = [...prev];
        for (const r of rows) if (!seen.has(r.id)) next.push(r);
        return next;
      });
      setNotReturned(payload.notReturned);
      setMediaFetchMeta({
        startedAt: Date.now(), receivedAt: Date.now(), httpStatus: payload.ok ? 200 : 400,
        providerError: null, precisionWarnings: [], rawBody: JSON.stringify(payload, null, 2), requestedFields: [],
      });
      if (payload.note) setError(payload.note);
    } catch (e) {
      setError(describeThrown('Media fetch failed', e));
    } finally {
      setBusy(null);
    }
  }, []);

  const resolveUrl = useCallback(async () => {
    if (!resolveInput.trim()) return;
    setBusy('resolve');
    setError(null);
    try {
      const payload = await api.resolve(resolveInput.trim(), 10);
      const meta: FetchMeta = {
        startedAt: payload.startedAt, receivedAt: payload.receivedAt, httpStatus: payload.httpStatus,
        providerError: payload.providerError, transportError: payload.transportError,
        precisionWarnings: payload.precisionWarnings, rawBody: payload.rawBody,
        sanitizedUrl: payload.sanitizedUrl, requestedFields: payload.requestedFields ?? [],
      };
      if (payload.matched) {
        const row = normalizeMedia(payload.matched);
        setResolveResult({ media: row, pagesWalked: payload.pagesWalked, meta, note: payload.note });
        if (row) {
          setMedias((prev) => (prev.some((m) => m.id === row.id) ? prev : [...prev, row]));
          setSelected(row);
        }
      } else {
        setResolveResult({ media: null, pagesWalked: payload.pagesWalked, meta, note: payload.note });
        setError(payload.note ?? 'Ownership not proven by the connected account.');
      }
    } catch (e) {
      setError(describeThrown('Resolve failed', e));
    } finally {
      setBusy(null);
    }
  }, [resolveInput]);

  const fetchInsights = useCallback(async () => {
    if (!selected) return;
    setBusy('insights');
    setError(null);
    try {
      const metrics = insightsMetricsText.split(',').map((s) => s.trim()).filter(Boolean);
      const payload = await api.insights(selected.id, metrics);
      setInsights({
        map: payload.insights,
        mediaId: payload.mediaId,
        meta: {
          startedAt: payload.startedAt, receivedAt: payload.receivedAt, httpStatus: payload.httpStatus,
          providerError: payload.providerError, transportError: payload.transportError,
          precisionWarnings: payload.precisionWarnings, rawBody: payload.rawBody,
          sanitizedUrl: payload.sanitizedUrl, requestedFields: [], requestedMetrics: metrics,
        },
      });
      if (!payload.ok) setError(describeFailure('Insights fetch failed', payload));
    } catch (e) {
      setError(describeThrown('Insights fetch failed', e));
    } finally {
      setBusy(null);
    }
  }, [selected, insightsMetricsText]);

  const doRefresh = useCallback(async () => {
    setBusy('refresh');
    setError(null);
    try {
      await api.refresh();
      await loadStatus();
    } catch (e) {
      setError(describeThrown('Refresh/extend failed', e));
      await loadStatus();
    } finally {
      setBusy(null);
    }
  }, [loadStatus]);

  const clearSession = useCallback(async () => {
    setBusy('clear');
    setError(null);
    try {
      await api.clearSession();
      setAccount(null);
      setMediaIds([]);
      setMedias([]);
      setAfter(null);
      setHasMore(false);
      setSelected(null);
      setInsights(null);
      setResolveResult(null);
      setNotReturned([]);
      await loadStatus();
    } catch (e) {
      setError(describeThrown('Clear session failed', e));
    } finally {
      setBusy(null);
    }
  }, [loadStatus]);

  const accountObj = useMemo(() => {
    if (!account?.data || typeof account.data !== 'object') return null;
    const d = account.data as Record<string, unknown>;
    const inner = Array.isArray(d.data) && d.data.length > 0 && typeof d.data[0] === 'object' ? (d.data[0] as Record<string, unknown>) : d;
    return inner;
  }, [account]);

  return (
    <div style={{ fontFamily: 'system-ui, sans-serif', maxWidth: 1020, margin: '0 auto', padding: 16 }}>
      <header>
        <h1 style={{ margin: 0 }}>Instagram Sandbox Lab</h1>
        <div><span style={{ background: '#fbbc04', padding: '2px 8px', borderRadius: 4 }}>Temporary research tool</span></div>
        <div>
          Connection: {status ? (status.connected ? 'connected' : 'not connected') : 'checking…'}
          {status?.connected && status.accessTokenExpiresAt && (
            <span> · token expires {formatIso(status.accessTokenExpiresAt)} ({status.isLongLived ? 'long-lived 60d' : 'short-lived 1h'})</span>
          )}
          {status && <span> · API {status.apiVersion}</span>}
        </div>
        {status?.providerUserId && <div>Provider user_id: {status.providerUserId}</div>}
        {status && (
          <div style={{ marginTop: 8 }}>
            <button type="button" onClick={() => { if (status.publicOrigin) window.location.href = '/auth/instagram/start'; }} disabled={!status.publicOrigin || !status.credentialsConfigured}>
              Connect Instagram
            </button>{' '}
            <button type="button" onClick={() => void doRefresh()} disabled={busy === 'refresh' || !status.connected}>
              {busy === 'refresh' ? 'Extending…' : 'Refresh/Extend token'}
            </button>{' '}
            <button type="button" onClick={() => void clearSession()} disabled={busy === 'clear'}>
              Clear local session
            </button>
          </div>
        )}
        {status && (
          <div style={{ marginTop: 4, fontSize: 13 }}>
            Requested: {status.configuredScopes.join(', ') || '(none)'} · Granted: {status.grantedScopes.length > 0 ? status.grantedScopes.join(', ') : '(none yet)'}
          </div>
        )}
        {status && (
          <div style={{ fontSize: 13 }}>
            Callback URL: {status.callbackUrl ?? '(no public origin — start the tunnel)'}{' '}
            {status.callbackUrl ? '✅' : '⚠️ no tunnel'} · Credentials: {status.credentialsConfigured ? 'configured' : 'missing (.env.local)'}
          </div>
        )}
        {status?.authFailure && <div style={{ color: '#b00020' }}>Auth failure ({status.authFailure.category}): {status.authFailure.detail}</div>}
        {status?.refreshFailure && <div style={{ color: '#b00020' }}>Refresh/extend failure ({status.refreshFailure.category}): {status.refreshFailure.detail}</div>}
        {error && <div style={{ color: '#b00020' }}>{error}</div>}
      </header>

      <nav style={{ marginTop: 16 }}>
        {(['account', 'media', 'insights', 'compare'] as Tab[]).map((t) => (
          <span key={t}>
            <button type="button" onClick={() => setTab(t)} disabled={tab === t}>
              {t === 'account' ? 'Tab A: Account' : t === 'media' ? 'Tab B: Owned media' : t === 'insights' ? 'Tab C: Media Insights' : 'Tab D: Compare'}
            </button>{' '}
          </span>
        ))}
      </nav>

      {tab === 'account' && (
        <section>
          <h2>Account</h2>
          <p style={{ color: '#555' }}>Official provider account ID (user_id) is stable identity. Username is display metadata — do not use as identity. OAuth/provider identity ≠ public scraper identity.</p>
          <button type="button" onClick={() => void fetchAccount()} disabled={busy === 'account'}>
            {busy === 'account' ? 'Fetching…' : 'Fetch account info'}
          </button>
          {accountObj && (
            <div style={{ border: '1px solid #ccc', padding: 12, marginTop: 12 }}>
              <AccountRow label="user_id (providerSubjectId)" value={accountObj.user_id} strong />
              <AccountRow label="id (app-scoped, not identity)" value={accountObj.id} />
              <AccountRow label="username" value={accountObj.username} />
              <AccountRow label="name" value={accountObj.name} />
              <AccountRow label="account_type" value={accountObj.account_type} />
              <AccountRow label="followers_count" value={accountObj.followers_count} numeric />
              <AccountRow label="follows_count" value={accountObj.follows_count} numeric />
              <AccountRow label="media_count" value={accountObj.media_count} numeric />
              <div style={{ color: '#555', fontSize: 13 }}>Observed at: {account?.meta ? formatIso(account.meta.receivedAt) : 'unknown'}</div>
              {accountObj.account_type !== undefined && !['Business', 'Media_Creator', 'BUSINESS', 'CREATOR'].includes(String(accountObj.account_type)) && (
                <div style={{ color: '#a05a00' }}>Note: only professional accounts (Business/Creator) are supported. Personal accounts cannot authorize media/Insights.</div>
              )}
            </div>
          )}
          {account && <JsonDetails label="sanitized JSON response" text={account.meta.rawBody} />}
          {account && <FetchMetaLine meta={account.meta} />}
        </section>
      )}

      {tab === 'media' && (
        <section>
          <h2>Owned media</h2>
          <p style={{ color: '#555' }}>Enumerates media owned by the connected professional account via GET /{'<IG_ID>'}/media with cursor pagination. Never silently stops after the first page when resolving.</p>
          <button type="button" onClick={() => void fetchMediaIds(null, false)} disabled={busy === 'media'}>
            {busy === 'media' ? 'Fetching…' : 'Fetch media'}
          </button>{' '}
          {hasMore && (
            <button type="button" onClick={() => void fetchMediaIds(after, true)} disabled={busy === 'media'}>
              Load more
            </button>
          )}{' '}
          {mediaIds.length > 0 && (
            <button type="button" onClick={() => void fetchDetails(mediaIds.filter((id) => !medias.some((m) => m.id === id)))} disabled={busy === 'details'}>
              {busy === 'details' ? 'Fetching details…' : `Fetch details (${mediaIds.filter((id) => !medias.some((m) => m.id === id)).length} remaining)`}
            </button>
          )}
          {mediaListMeta && <FetchMetaLine meta={mediaListMeta} />}
          {mediaIds.length > 0 && <div style={{ fontSize: 13 }}>IDs listed: {mediaIds.length}{hasMore ? ' (more available)' : ''}</div>}
          <MediaTable medias={medias} selectedId={selected?.id ?? null} onSelect={setSelected} />
          {notReturned.length > 0 && <div style={{ color: '#a05a00' }}>Not returned (ownership not proven): {notReturned.join(', ')}</div>}
          {mediaFetchMeta && <JsonDetails label="media fetch JSON" text={mediaFetchMeta.rawBody} />}

          <h3>Resolve Reel URL / permalink</h3>
          <p style={{ color: '#555' }}>Paste https://www.instagram.com/reel/&lt;shortcode&gt;/, /p/&lt;shortcode&gt;/, permalink, shortcode, or numeric media ID. Resolution matches permalink/shortcode against owned media (bounded walk, max 10 pages). Ownership is never inferred from username.</p>
          <input value={resolveInput} onChange={(e) => setResolveInput(e.target.value)} style={{ width: '100%' }} placeholder="https://www.instagram.com/reel/XXXXXXX/" />
          <button type="button" onClick={() => void resolveUrl()} disabled={busy === 'resolve' || !resolveInput.trim()}>
            {busy === 'resolve' ? 'Resolving…' : 'Resolve Reel URL / permalink'}
          </button>
          {resolveResult && (
            <div style={{ marginTop: 8 }}>
              <div>Pages walked: {resolveResult.pagesWalked} · {resolveResult.media ? `Matched ${resolveResult.media.id}` : 'No match'}</div>
              {resolveResult.note && <div style={{ color: '#a05a00' }}>{resolveResult.note}</div>}
              <FetchMetaLine meta={resolveResult.meta} />
              <JsonDetails label="resolve JSON" text={resolveResult.meta.rawBody} />
            </div>
          )}
        </section>
      )}

      {tab === 'insights' && (
        <section>
          <h2>Media Insights</h2>
          {!selected && <p style={{ color: '#a05a00' }}>Select a media item in Tab B first.</p>}
          {selected && (
            <>
              <div>Selected: {selected.id} · {selected.permalink ?? '(no permalink)'} · {selected.mediaType ?? 'unknown type'}</div>
              <div style={{ marginTop: 8 }}>
                <label>Metrics (comma-separated): <input value={insightsMetricsText} onChange={(e) => setInsightsMetricsText(e.target.value)} style={{ width: '100%' }} /></label>
              </div>
              <button type="button" onClick={() => void fetchInsights()} disabled={busy === 'insights'}>
                {busy === 'insights' ? 'Fetching…' : 'Fetch Insights'}
              </button>
              {insights && (
                <>
                  <table style={{ borderCollapse: 'collapse', marginTop: 8 }}>
                    <thead><tr><th style={th}>metric</th><th style={th}>value (full integer)</th><th style={th}>source</th></tr></thead>
                    <tbody>
                      {Object.entries(insights.map).map(([metric, value]) => (
                        <tr key={metric}>
                          <td style={td}>{metric}</td>
                          <td style={td}>{value === null ? <em>Not returned / Unavailable / Unsupported</em> : formatCount(value)}</td>
                          <td style={td}>Insights</td>
                        </tr>
                      ))}
                      <tr><td style={td}>likes (basic field)</td><td style={td}>{selected.likeCount === null ? <em>Not returned</em> : formatCount(selected.likeCount)}</td><td style={td}>basic media field</td></tr>
                      <tr><td style={td}>comments (basic field)</td><td style={td}>{selected.commentsCount === null ? <em>Not returned</em> : formatCount(selected.commentsCount)}</td><td style={td}>basic media field</td></tr>
                    </tbody>
                  </table>
                  <div style={{ color: '#555', fontSize: 13 }}>Basic media fields vs Insights metrics are shown separately. Missing is never zero. plays is not used — current metric is views.</div>
                  <FetchMetaLine meta={insights.meta} />
                  <JsonDetails label="sanitized Insights JSON" text={insights.meta.rawBody} />
                </>
              )}
            </>
          )}
        </section>
      )}

      {tab === 'compare' && (
        <section>
          <h2>Compare</h2>
          {!selected && <p style={{ color: '#a05a00' }}>Select a media item in Tab B first.</p>}
          {selected && <ComparisonPanel media={selected} insights={insights?.map ?? null} observationTs={insights?.meta.receivedAt ?? mediaFetchMeta?.receivedAt ?? null} />}
        </section>
      )}
    </div>
  );
}

function AccountRow({ label, value, strong, numeric }: { label: string; value: unknown; strong?: boolean; numeric?: boolean }) {
  const display =
    value === undefined || value === null || value === '' ? <em>Not returned</em> :
    numeric && typeof value === 'number' ? formatCount(value) : String(value);
  return <div>{strong ? <strong>{label}: {display}</strong> : <span><strong>{label}:</strong> {display}</span>}</div>;
}

function describeFailure(prefix: string, payload: { providerError: { code: string; message: string } | null; transportError?: string; httpStatus: number }): string {
  if (payload.providerError) return `${prefix}: ${payload.providerError.code} — ${payload.providerError.message}`;
  if (payload.transportError) return `${prefix}: ${payload.transportError}`;
  return `${prefix}: HTTP ${payload.httpStatus}`;
}

function describeThrown(prefix: string, e: unknown): string {
  if (e && typeof e === 'object' && 'message' in e) return `${prefix}: ${String((e as { message: unknown }).message)}`;
  return `${prefix}: ${String(e)}`;
}

function MediaTable({ medias, selectedId, onSelect }: { medias: MediaRow[]; selectedId: string | null; onSelect: (m: MediaRow | null) => void }) {
  if (medias.length === 0) return null;
  return (
    <table style={{ borderCollapse: 'collapse', width: '100%', marginTop: 12 }}>
      <thead><tr>
        <th style={th}>thumb</th><th style={th}>ID</th><th style={th}>type</th><th style={th}>permalink</th><th style={th}>published</th><th style={th}>likes</th><th style={th}>comments</th><th style={th}></th>
      </tr></thead>
      <tbody>
        {medias.map((m) => (
          <tr key={m.id} style={selectedId === m.id ? { background: '#e8f0fe' } : undefined}>
            <td style={td}>{m.thumbnailUrl ? <img src={m.thumbnailUrl} alt="" width={48} referrerPolicy="no-referrer" /> : '—'}</td>
            <td style={td}>{m.id}</td>
            <td style={td}>{[m.mediaType, m.mediaProductType].filter(Boolean).join(' / ') || <em>Not returned</em>}</td>
            <td style={td}>{m.permalink ? <a href={m.permalink} target="_blank" rel="noreferrer noopener">{m.shortcode ?? m.permalink}</a> : <em>Not returned</em>}</td>
            <td style={td}>{m.timestamp ?? <em>Not returned</em>}</td>
            <td style={td}>{formatCount(m.likeCount)}</td>
            <td style={td}>{formatCount(m.commentsCount)}</td>
            <td style={td}><button type="button" onClick={() => onSelect(selectedId === m.id ? null : m)}>{selectedId === m.id ? 'Deselect' : 'Select'}</button></td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function ComparisonPanel({ media, insights, observationTs }: { media: MediaRow; insights: Record<string, number | null> | null; observationTs: number | null }) {
  const [baselineJson, setBaselineJson] = useState('');
  const [result, setResult] = useState<Awaited<ReturnType<typeof api.compare>>['comparison'] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const sampleJson = useMemo(
    () => JSON.stringify({ mediaId: media.id, source: 'BloxClips public scraper', observedAt: null, views: null, likes: media.likeCount, comments: media.commentsCount, shares: null, saves: null }, null, 2),
    [media.id, media.likeCount, media.commentsCount],
  );

  const runCompare = async () => {
    setError(null);
    setResult(null);
    try {
      const official: Record<string, unknown> = { id: media.id, like_count: media.likeCount, comments_count: media.commentsCount };
      if (insights) {
        official.insights = {
          views: insights.views ?? null, likes: insights.likes ?? null, comments: insights.comments ?? null,
          shares: insights.shares ?? null, saved: insights.saved ?? null, saves: insights.saved ?? null,
        };
        if (insights.views !== undefined) official.views = insights.views;
      }
      const payload = await api.compare(official, observationTs ? new Date(observationTs).toISOString() : null, baselineJson);
      setResult(payload.comparison);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const exportJson = () => {
    if (!result) return;
    const blob = new Blob([JSON.stringify({ comparison: result }, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `comparison-${media.id}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div style={{ border: '1px solid #999', padding: 12, marginTop: 16 }}>
      <h3>Compare: media {media.id}</h3>
      <p style={{ color: '#555' }}>Paste baseline JSON (mediaId, source, observedAt, views, likes, comments, shares, saves). Unknown baseline time stays unknown.</p>
      <textarea value={baselineJson} onChange={(e) => setBaselineJson(e.target.value)} rows={8} style={{ width: '100%', fontFamily: 'monospace' }} placeholder={sampleJson} />
      <button type="button" onClick={() => void runCompare()} disabled={baselineJson.trim().length === 0}>Compare</button>{' '}
      {result && <button type="button" onClick={exportJson}>Export comparison JSON</button>}
      {error && <div style={{ color: '#b00020' }}>{error}</div>}
      {result && (
        <table style={{ borderCollapse: 'collapse', marginTop: 8 }}>
          <thead><tr><th style={th}>metric</th><th style={th}>official</th><th style={th}>baseline</th><th style={th}>diff</th><th style={th}>%</th></tr></thead>
          <tbody>
            {result.rows.map((row) => (
              <tr key={row.metric}>
                <td style={td}>{row.metric}</td>
                <td style={td}>{formatCount(row.official)}</td>
                <td style={td}>{formatCount(row.baseline)}</td>
                <td style={td}>{formatSignedDiff(row.diff)}</td>
                <td style={td}>{formatPercentDiff(row.percentDiff)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {result && <div style={{ color: '#555' }}>Official observed at: {result.officialObservedAt ?? 'unknown'} · Baseline: {result.baselineObservedAt ?? 'unknown'} · Gap: {formatGap(result.observationGapMs)}</div>}
    </div>
  );
}

function FetchMetaLine({ meta }: { meta: FetchMeta }) {
  return (
    <div style={{ color: '#555', fontSize: 13 }}>
      Request {formatIso(meta.startedAt)} → response {formatIso(meta.receivedAt)} · HTTP {meta.httpStatus}
      {meta.sanitizedUrl ? ` · ${meta.sanitizedUrl}` : ''}
      {meta.providerError ? ` · provider error ${meta.providerError.code}: ${meta.providerError.message}` : ''}
      {meta.precisionWarnings.length > 0 && (
        <div style={{ color: '#a05a00' }}>{meta.precisionWarnings.map((w, i) => <div key={i}>⚠ {w}</div>)}</div>
      )}
    </div>
  );
}

const th: React.CSSProperties = { border: '1px solid #ccc', padding: 6, textAlign: 'left' };
const td: React.CSSProperties = { border: '1px solid #ccc', padding: 6 };
