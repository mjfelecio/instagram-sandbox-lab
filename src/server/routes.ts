/**
 * Express routes for the Instagram lab: OAuth flow, session handling, and fixed
 * data operations (account, owned media, media fetch, resolve, Insights).
 * No unrestricted proxy. Every data route requires an authenticated session.
 *
 * Security model mirrors tiktok-sandbox-lab:
 * - Opaque 256-bit session key in HttpOnly, Secure (when HTTPS), SameSite=Lax cookie.
 * - OAuth state cryptographically random, single-use, short TTL, session-bound.
 * - Tokens never leave server. Responses carry sanitized data only.
 * - State-changing routes require allowed Origin + custom X-Requested-With.
 * - Redirects built from validated config, never Host headers.
 * - Graph URLs with access_token are sanitized before logging/export.
 */

import type { Express, Request, Response } from 'express';
import crypto from 'node:crypto';

import { CALLBACK_PATH, redirectUriForOrigin, localOrigin, DEFAULT_PORT } from './config.js';
import { SessionStore, type TokenSet, type RefreshResult } from './session.js';
import {
  buildAuthorizeUrl,
  exchangeAuthorizationCode,
  exchangeForLongLivedToken,
  extendLongLivedToken,
  fetchAccountInfo,
  fetchOwnedMediaPage,
  fetchMedia,
  fetchMediaInsights,
  extractMediaPage,
  insightsToMap,
  sanitizeGraphUrl,
  type ApiCallResult,
  type FetchImpl,
  type ProviderError,
} from './instagram.js';
import {
  ACCOUNT_FIELDS,
  ACCOUNT_ID_FIELD,
  MEDIA_FIELDS,
  PROBEABLE_MEDIA_FIELDS,
  INSIGHT_METRICS_REELS_FEED,
  INSIGHTS_SCOPE,
  BASIC_SCOPE,
} from '../shared/scopes.js';
import {
  parseMediaInput,
  normalizePermalink,
  mediaMatchesRequest,
  MAX_RESOLVE_PAGES,
  MEDIA_PAGE_SIZE,
} from '../shared/mediaUrls.js';
import { metricsFromMedia, compareMetrics, parseBaselineJson } from '../shared/comparison.js';
import { ObservationStore } from './observations.js';

export const SESSION_COOKIE = 'isl_session';
const CSRF_HEADER_VALUE = 'instagram-sandbox-lab';

export interface RouteDeps {
  store: SessionStore;
  observations: ObservationStore;
  getPublicOrigin: () => string | null;
  fetchImpl?: FetchImpl;
  now?: () => number;
  appId: string | null;
  appSecret: string | null;
  scopes: string[];
  apiVersion: string;
  extraAllowedOrigins?: string[];
  port?: number;
}

interface ResolvedDeps {
  store: SessionStore;
  observations: ObservationStore;
  getPublicOrigin: () => string | null;
  fetchImpl: FetchImpl;
  now: () => number;
  allowedOrigins: () => string[];
  port: number;
  appId: string | null;
  appSecret: string | null;
  scopes: string[];
  apiVersion: string;
}

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}
void safeEqual;

function setSessionCookie(res: Response, deps: ResolvedDeps, key: string): void {
  const secure = Boolean(deps.getPublicOrigin()?.startsWith('https://'));
  res.cookie(SESSION_COOKIE, key, {
    httpOnly: true,
    secure,
    sameSite: 'lax',
    path: '/',
    maxAge: 7 * 24 * 3600 * 1000,
  });
}

function clearSessionCookie(res: Response): void {
  res.clearCookie(SESSION_COOKIE, { path: '/' });
}

function sessionFromReq(req: Request, deps: ResolvedDeps) {
  const key = typeof req.cookies?.[SESSION_COOKIE] === 'string' ? req.cookies[SESSION_COOKIE] : null;
  return deps.store.getSession(key);
}

function sameOriginGuard(req: Request, deps: ResolvedDeps): boolean {
  const origin = typeof req.headers.origin === 'string' ? req.headers.origin : null;
  const requestedWith = req.headers['x-requested-with'];
  if (!origin || typeof requestedWith !== 'string' || requestedWith.length === 0) return false;
  if (requestedWith !== CSRF_HEADER_VALUE) return false;
  return deps.allowedOrigins().includes(origin);
}

function requireSession(req: Request, res: Response, deps: ResolvedDeps) {
  const session = sessionFromReq(req, deps);
  if (!session || !session.tokens) {
    res.status(401).json({ error: 'unauthenticated', message: 'Connect Instagram first.' });
    return null;
  }
  return session;
}

function sanitizeApiResultForClient(result: ApiCallResult, requested: { fields?: string[]; metrics?: string[] }) {
  return {
    ok: result.ok,
    httpStatus: result.httpStatus,
    providerError: result.providerError,
    data: result.data,
    rawBody: result.rawBody,
    sanitizedUrl: result.sanitizedUrl,
    precisionWarnings: result.precisionWarnings,
    transportError: result.transportError,
    startedAt: result.startedAt,
    receivedAt: result.receivedAt,
    requestedFields: requested.fields ?? [],
    requestedMetrics: requested.metrics ?? [],
  };
}

function oauthFailureDetail(providerError: ProviderError | null, transportError: string | undefined, httpStatus: number): string {
  if (providerError) return `${providerError.code}: ${providerError.message}`.slice(0, 300);
  if (transportError) return transportError.slice(0, 300);
  return `HTTP ${httpStatus}`;
}

export function registerRoutes(app: Express, deps: RouteDeps): { store: SessionStore; observations: ObservationStore } {
  const port = deps.port ?? DEFAULT_PORT;
  const resolved: ResolvedDeps = {
    store: deps.store,
    observations: deps.observations,
    getPublicOrigin: deps.getPublicOrigin,
    fetchImpl: deps.fetchImpl ?? fetch,
    now: deps.now ?? Date.now,
    port,
    appId: deps.appId,
    appSecret: deps.appSecret,
    scopes: deps.scopes,
    apiVersion: deps.apiVersion,
    allowedOrigins: () => {
      const list = [localOrigin(port), `http://127.0.0.1:${port}`, ...(deps.extraAllowedOrigins ?? [])];
      const publicOrigin = deps.getPublicOrigin();
      if (publicOrigin) list.push(publicOrigin);
      return list;
    },
  };
  const d = resolved;

  const creds = () => {
    if (!d.appId || !d.appSecret) return null;
    return { appId: d.appId, appSecret: d.appSecret };
  };

  app.get('/api/status', (req, res) => {
    const session = sessionFromReq(req, d);
    const publicOrigin = d.getPublicOrigin();
    const connected = Boolean(session?.tokens);
    const grantedScopes =
      connected && session?.tokens ? session.tokens.scope.split(',').map((s) => s.trim()).filter(Boolean) : [];
    res.json({
      connected,
      publicOrigin,
      callbackUrl: publicOrigin ? redirectUriForOrigin(publicOrigin) : null,
      configuredScopes: d.scopes,
      grantedScopes,
      accessTokenExpiresAt: connected && session?.tokens ? session.tokens.expiresAt : null,
      isLongLived: connected && session?.tokens ? session.tokens.isLongLived : null,
      providerUserId: connected && session?.tokens ? session.tokens.userId : null,
      apiVersion: d.apiVersion,
      authFailure: session ? d.store.getAuthFailure(session.key) : null,
      refreshFailure: session ? d.store.getRefreshFailure(session.key) : null,
      credentialsConfigured: Boolean(creds()),
    });
  });

  app.get('/auth/instagram/start', (req, res) => {
    const c = creds();
    const publicOrigin = d.getPublicOrigin();
    if (!c || !publicOrigin) {
      res.status(400).send('Configuration incomplete: missing credentials or public origin.');
      return;
    }
    const existing = sessionFromReq(req, d);
    const session = existing ?? d.store.createSession();
    setSessionCookie(res, d, session.key);
    const redirectUri = redirectUriForOrigin(publicOrigin);
    const state = d.store.issueOAuthState(session.key, redirectUri);
    res.redirect(buildAuthorizeUrl({ appId: c.appId, redirectUri, scopes: d.scopes, state }));
  });

  app.get(CALLBACK_PATH, (req, res) => {
    const query = req.query as Record<string, unknown>;
    const session = sessionFromReq(req, d);
    const base = d.getPublicOrigin() ?? localOrigin(d.port);
    const redirectToHome = (params: URLSearchParams) => {
      res.redirect(303, `${base}/?${params.toString()}`);
    };
    const fail = (category: string, detail: string) => {
      if (session) d.store.recordAuthFailure(session.key, category, detail);
      redirectToHome(new URLSearchParams({ auth_error: category, auth_error_detail: detail.slice(0, 300) }));
    };

    if (!session) {
      redirectToHome(
        new URLSearchParams({
          auth_error: 'session_missing',
          auth_error_detail: 'No lab browser session for this callback. Start the flow again from the Connect button.',
        }),
      );
      return;
    }

    if (typeof query.error === 'string' && query.error.length > 0) {
      const description =
        typeof query.error_description === 'string' ? query.error_description : String(query.error);
      fail('provider_denied', description);
      return;
    }
    const code = typeof query.code === 'string' ? query.code : null;
    const state = typeof query.state === 'string' ? query.state : null;
    if (!code || !state) {
      fail('invalid_callback', 'Missing code or state parameter.');
      return;
    }
    const consumed = d.store.consumeOAuthState(session.key, state);
    if (!consumed.ok) {
      fail(`state_${consumed.reason}`, `OAuth state rejected (${consumed.reason}).`);
      return;
    }
    const redirectUri = consumed.redirectUri;
    const c = creds();
    if (!c) {
      fail('config_missing', 'App credentials disappeared from configuration.');
      return;
    }

    exchangeAuthorizationCode(c, { code, redirectUri }, { fetchImpl: d.fetchImpl, timeoutMs: 20_000 })
      .then(async (result) => {
        if (!result.ok || !result.tokens) {
          fail('exchange_failed', oauthFailureDetail(result.providerError, result.transportError, result.httpStatus));
          return;
        }
        // Best-effort upgrade to long-lived (60d). Keep short-lived on failure.
        const shortLived = result.tokens;
        d.observations.add(session.key, {
          kind: 'token_exchange',
          startedAt: result.startedAt,
          receivedAt: result.receivedAt,
          endpoint: 'POST api.instagram.com/oauth/access_token (short-lived, 1h)',
          requested: {},
          httpStatus: result.httpStatus,
          providerError: result.providerError,
          transportError: result.transportError,
          metrics: [],
          data: { user_id: shortLived.userId, permissions: shortLived.scope, isLongLived: false },
          precisionWarnings: [],
          ok: true,
        });
        if (!c.appSecret) {
          d.store.storeTokens(session.key, shortLived);
          redirectToHome(new URLSearchParams({ connected: '1' }));
          return;
        }
        try {
          const longLived = await exchangeForLongLivedToken(
            { appSecret: c.appSecret, shortLivedToken: shortLived.accessToken, userId: shortLived.userId, scope: shortLived.scope },
            { fetchImpl: d.fetchImpl, timeoutMs: 20_000 },
          );
          if (longLived.ok && longLived.tokens) {
            d.store.storeTokens(session.key, longLived.tokens);
            d.observations.add(session.key, {
              kind: 'token_extend',
              startedAt: longLived.startedAt,
              receivedAt: longLived.receivedAt,
              endpoint: 'GET graph.instagram.com/access_token (ig_exchange_token, 60d)',
              requested: {},
              httpStatus: longLived.httpStatus,
              providerError: longLived.providerError,
              transportError: longLived.transportError,
              metrics: [],
              data: { user_id: longLived.tokens.userId, isLongLived: true },
              precisionWarnings: [],
              ok: true,
            });
          } else {
            d.store.storeTokens(session.key, shortLived);
            d.store.recordRefreshFailure(
              session.key,
              'long_lived_upgrade_failed',
              oauthFailureDetail(longLived.providerError, longLived.transportError, longLived.httpStatus),
            );
          }
        } catch {
          d.store.storeTokens(session.key, shortLived);
        }
        redirectToHome(new URLSearchParams({ connected: '1' }));
      })
      .catch(() => {
        fail('exchange_failed', 'Unexpected error during code exchange.');
      });
  });

  app.post('/api/session/clear', (req, res) => {
    if (!sameOriginGuard(req, d)) {
      res.status(403).json({ error: 'csrf_blocked', message: 'Blocked cross-site or unflagged request.' });
      return;
    }
    const key = typeof req.cookies?.[SESSION_COOKIE] === 'string' ? req.cookies[SESSION_COOKIE] : null;
    if (key) {
      d.store.destroySession(key);
      d.observations.clear(key);
    }
    clearSessionCookie(res);
    res.json({
      ok: true,
      note: 'Local session and displayed data cleared. This does not revoke authorization at Instagram (remove via Instagram Settings > Apps and Websites).',
    });
  });

  // ---------- Account ----------
  app.post('/api/instagram/account', async (req, res) => {
    if (!sameOriginGuard(req, d)) {
      res.status(403).json({ error: 'csrf_blocked', message: 'Blocked cross-site or unflagged request.' });
      return;
    }
    const session = requireSession(req, res, d);
    if (!session || !session.tokens) return;
    const fields = [ACCOUNT_ID_FIELD, ...ACCOUNT_FIELDS];
    const result = await fetchAccountInfo(session.tokens.accessToken, fields, d.apiVersion, { fetchImpl: d.fetchImpl });
    const observation = d.observations.add(session.key, {
      kind: 'account_info',
      startedAt: result.startedAt,
      receivedAt: result.receivedAt,
      endpoint: `GET graph.instagram.com/${d.apiVersion}/me`,
      requested: { fields },
      httpStatus: result.httpStatus,
      providerError: result.providerError,
      transportError: result.transportError,
      metrics: [],
      data: result.data,
      precisionWarnings: result.precisionWarnings,
      ok: result.ok,
    });
    if (result.ok && result.data) {
      session.accountInfo = { data: result.data, fields, observedAt: result.receivedAt };
    }
    res.json({ observationId: observation.id, ...sanitizeApiResultForClient(result, { fields }) });
  });

  // ---------- Owned media: one page of IDs ----------
  app.post('/api/instagram/media', async (req, res) => {
    if (!sameOriginGuard(req, d)) {
      res.status(403).json({ error: 'csrf_blocked', message: 'Blocked cross-site or unflagged request.' });
      return;
    }
    const session = requireSession(req, res, d);
    if (!session || !session.tokens) return;
    const granted = session.tokens.scope.split(',').map((s) => s.trim());
    if (!granted.includes(BASIC_SCOPE)) {
      res.status(403).json({ error: 'scope_missing', message: `Requires ${BASIC_SCOPE} — not granted.` });
      return;
    }
    const body = (req.body ?? {}) as { after?: unknown; limit?: unknown };
    const after = typeof body.after === 'string' && body.after.length > 0 ? body.after : undefined;
    const limitRaw = typeof body.limit === 'number' ? body.limit : MEDIA_PAGE_SIZE;
    const limit = Number.isSafeInteger(limitRaw) ? Math.min(Math.max(limitRaw, 1), MEDIA_PAGE_SIZE) : MEDIA_PAGE_SIZE;
    const result = await fetchOwnedMediaPage(
      session.tokens.accessToken,
      session.tokens.userId,
      { limit, after },
      d.apiVersion,
      { fetchImpl: d.fetchImpl },
    );
    const page = extractMediaPage(result.data);
    const observation = d.observations.add(session.key, {
      kind: 'media_list',
      startedAt: result.startedAt,
      receivedAt: result.receivedAt,
      endpoint: `GET graph.instagram.com/${d.apiVersion}/${session.tokens.userId}/media`,
      requested: { after: after ?? null, limit },
      httpStatus: result.httpStatus,
      providerError: result.providerError,
      transportError: result.transportError,
      metrics: page.ids.map((id) => ({ id })),
      data: result.data,
      precisionWarnings: result.precisionWarnings,
      ok: result.ok,
    });
    res.json({
      observationId: observation.id,
      ...sanitizeApiResultForClient(result, {}),
      ids: page.ids,
      after: page.after,
      hasMore: page.hasMore,
    });
  });

  // ---------- Media fetch: details for explicit IDs ----------
  app.post('/api/instagram/media/fetch', async (req, res) => {
    if (!sameOriginGuard(req, d)) {
      res.status(403).json({ error: 'csrf_blocked', message: 'Blocked cross-site or unflagged request.' });
      return;
    }
    const session = requireSession(req, res, d);
    if (!session || !session.tokens) return;
    const body = (req.body ?? {}) as { ids?: unknown };
    const rawIds = Array.isArray(body.ids) ? body.ids.filter((x): x is string => typeof x === 'string') : [];
    const ids = [...new Set(rawIds.map((s) => s.trim()).filter(Boolean))].slice(0, MEDIA_PAGE_SIZE);
    if (ids.length === 0) {
      res.status(400).json({ error: 'invalid_input', message: 'Provide at least one official media ID.' });
      return;
    }
    // Default media request contains only fields known to belong to the
    // Instagram Login integration. Facebook-Login-only fields are never bundled
    // here (a single unsupported field may reject the whole fields= request);
    // use POST /api/instagram/media/probe to test them in isolation.
    const fields = [...MEDIA_FIELDS];
    const medias: Array<Record<string, unknown>> = [];
    const notReturned: string[] = [];
    let lastResult: ApiCallResult | null = null;
    for (const id of ids) {
      const result = await fetchMedia(session.tokens.accessToken, id, fields, d.apiVersion, { fetchImpl: d.fetchImpl });
      lastResult = result;
      if (result.ok && result.data && typeof result.data === 'object') {
        medias.push(result.data as Record<string, unknown>);
      } else {
        notReturned.push(id);
      }
    }
    // One combined observation (sanitized media objects, no tokens).
    const observation = d.observations.add(session.key, {
      kind: 'media_fetch',
      startedAt: lastResult?.startedAt ?? Date.now(),
      receivedAt: lastResult?.receivedAt ?? Date.now(),
      endpoint: `GET graph.instagram.com/${d.apiVersion}/<MEDIA_ID> (x${ids.length})`,
      requested: { fields },
      httpStatus: lastResult?.httpStatus ?? 0,
      providerError: notReturned.length === ids.length ? (lastResult?.providerError ?? null) : null,
      transportError: lastResult?.transportError,
      metrics: medias,
      data: { medias },
      precisionWarnings: [],
      ok: medias.length > 0,
    });
    res.json({
      observationId: observation.id,
      ok: medias.length > 0,
      medias,
      requestedIds: ids,
      notReturned,
      note:
        notReturned.length > 0
          ? 'Ownership not proven by the connected account for IDs not returned. This is not proof of deletion/privacy/fraud.'
          : undefined,
    });
  });

  // ---------- Experimental field probe (isolated; never bundled with core flow) ----------
  // Tests a single Facebook-Login-documented or otherwise risky field (e.g.
  // media_product_type) against one media ID so a rejection cannot break the
  // core media-resolution workflow. Allowlisted to prevent arbitrary injection.
  app.post('/api/instagram/media/probe', async (req, res) => {
    if (!sameOriginGuard(req, d)) {
      res.status(403).json({ error: 'csrf_blocked', message: 'Blocked cross-site or unflagged request.' });
      return;
    }
    const session = requireSession(req, res, d);
    if (!session || !session.tokens) return;
    const body = (req.body ?? {}) as { mediaId?: unknown; field?: unknown };
    const mediaId = typeof body.mediaId === 'string' ? body.mediaId.trim() : '';
    const field = typeof body.field === 'string' ? body.field.trim() : '';
    if (!mediaId || !field) {
      res.status(400).json({ error: 'invalid_input', message: 'Provide mediaId and field.' });
      return;
    }
    if (!(PROBEABLE_MEDIA_FIELDS as readonly string[]).includes(field)) {
      res.status(400).json({
        error: 'invalid_input',
        message: `Field "${field}" is not probeable. Allowed: ${(PROBEABLE_MEDIA_FIELDS as readonly string[]).join(', ')}.`,
      });
      return;
    }
    const fields = ['id', field];
    const result = await fetchMedia(session.tokens.accessToken, mediaId, fields, d.apiVersion, {
      fetchImpl: d.fetchImpl,
    });
    const observation = d.observations.add(session.key, {
      kind: 'media_fetch',
      startedAt: result.startedAt,
      receivedAt: result.receivedAt,
      endpoint: `GET graph.instagram.com/${d.apiVersion}/${mediaId} (experimental probe: ${field})`,
      requested: { fields, mediaId },
      httpStatus: result.httpStatus,
      providerError: result.providerError,
      transportError: result.transportError,
      metrics: [],
      data: result.data,
      precisionWarnings: result.precisionWarnings,
      ok: result.ok,
    });
    res.json({ observationId: observation.id, ...sanitizeApiResultForClient(result, { fields }) });
  });

  // ---------- Resolve Reel/post URL -> official media ----------
  app.post('/api/instagram/resolve', async (req, res) => {
    if (!sameOriginGuard(req, d)) {
      res.status(403).json({ error: 'csrf_blocked', message: 'Blocked cross-site or unflagged request.' });
      return;
    }
    const session = requireSession(req, res, d);
    if (!session || !session.tokens) return;
    const body = (req.body ?? {}) as { input?: unknown; maxPages?: unknown };
    const input = typeof body.input === 'string' ? body.input.trim() : '';
    if (!input) {
      res.status(400).json({ error: 'invalid_input', message: 'Provide a Reel/post URL, permalink, shortcode, or media ID.' });
      return;
    }
    const parsed = parseMediaInput(input);
    if (parsed.kind === 'media_id' && parsed.mediaId) {
      const fields = [...MEDIA_FIELDS];
      const result = await fetchMedia(session.tokens.accessToken, parsed.mediaId, fields, d.apiVersion, {
        fetchImpl: d.fetchImpl,
      });
      const observation = d.observations.add(session.key, {
        kind: 'media_fetch',
        startedAt: result.startedAt,
        receivedAt: result.receivedAt,
        endpoint: `GET graph.instagram.com/${d.apiVersion}/${parsed.mediaId} (direct ID resolve)`,
        requested: { fields, mediaId: parsed.mediaId },
        httpStatus: result.httpStatus,
        providerError: result.providerError,
        transportError: result.transportError,
        metrics: result.ok ? [result.data as Record<string, unknown>] : [],
        data: result.data,
        precisionWarnings: result.precisionWarnings,
        ok: result.ok,
      });
      res.json({
        observationId: observation.id,
        ...sanitizeApiResultForClient(result, { fields }),
        matched: result.ok ? result.data : null,
        pagesWalked: 0,
        method: 'direct-id',
      });
      return;
    }
    if (!parsed.shortcode && !parsed.canonicalUrl) {
      res.status(400).json({
        error: 'invalid_input',
        message: 'Unrecognized Instagram URL. Use https://www.instagram.com/reel/<shortcode>/ or /p/<shortcode>/, a permalink, or a numeric media ID.',
      });
      return;
    }
    const maxPagesRaw = typeof body.maxPages === 'number' ? body.maxPages : MAX_RESOLVE_PAGES;
    const maxPages = Number.isSafeInteger(maxPagesRaw) ? Math.min(Math.max(maxPagesRaw, 1), MAX_RESOLVE_PAGES) : MAX_RESOLVE_PAGES;
    // Instagram-Login-only default fields (see media/fetch above).
    const fields = [...MEDIA_FIELDS];
    // Truthful evidence timing: capture before page 1; end at the last provider
    // response receipt (not after response serialization).
    const resolveStartedAt = Date.now();
    let resolveReceivedAt = resolveStartedAt;
    let after: string | undefined;
    let pagesWalked = 0;
    let matched: Record<string, unknown> | null = null;
    let lastStatus = 0;
    let lastError: ProviderError | null = null;
    for (let page = 0; page < maxPages; page += 1) {
      const listResult = await fetchOwnedMediaPage(
        session.tokens.accessToken,
        session.tokens.userId,
        { limit: MEDIA_PAGE_SIZE, after },
        d.apiVersion,
        { fetchImpl: d.fetchImpl },
      );
      lastStatus = listResult.httpStatus;
      lastError = listResult.providerError;
      resolveReceivedAt = listResult.receivedAt;
      if (!listResult.ok) break;
      const { ids, after: next } = extractMediaPage(listResult.data);
      pagesWalked += 1;
      for (const id of ids) {
        const detail = await fetchMedia(session.tokens.accessToken, id, fields, d.apiVersion, { fetchImpl: d.fetchImpl });
        resolveReceivedAt = detail.receivedAt;
        if (!detail.ok || !detail.data || typeof detail.data !== 'object') continue;
        const media = detail.data as Record<string, unknown>;
        if (mediaMatchesRequest(media, { shortcode: parsed.shortcode, canonicalUrl: parsed.canonicalUrl })) {
          matched = media;
          break;
        }
      }
      if (matched) break;
      if (!next) break;
      after = next;
    }
    const observation = d.observations.add(session.key, {
      kind: 'media_fetch',
      startedAt: resolveStartedAt,
      receivedAt: resolveReceivedAt,
      endpoint: `Resolve ${parsed.canonicalUrl ?? parsed.shortcode} via owned-media walk (bounded ${maxPages} pages)`,
      requested: { mediaId: parsed.shortcode ?? undefined },
      httpStatus: matched ? 200 : lastStatus,
      providerError: matched ? null : lastError,
      metrics: matched ? [matched] : [],
      data: matched ?? { pagesWalked, note: 'Ownership not proven by the connected account in walked pages.' },
      precisionWarnings: [],
      ok: Boolean(matched),
    });
    res.json({
      observationId: observation.id,
      ok: Boolean(matched),
      matched,
      pagesWalked,
      method: 'permalink-walk',
      requested: { shortcode: parsed.shortcode, canonicalUrl: parsed.canonicalUrl ?? normalizePermalink(input) },
      note: matched
        ? undefined
        : 'Ownership not proven by the connected account in walked pages. Not proof of deletion/privacy/fraud.',
    });
  });

  // ---------- Insights ----------
  app.post('/api/instagram/insights', async (req, res) => {
    if (!sameOriginGuard(req, d)) {
      res.status(403).json({ error: 'csrf_blocked', message: 'Blocked cross-site or unflagged request.' });
      return;
    }
    const session = requireSession(req, res, d);
    if (!session || !session.tokens) return;
    const granted = session.tokens.scope.split(',').map((s) => s.trim());
    if (!granted.includes(INSIGHTS_SCOPE)) {
      res.status(403).json({ error: 'scope_missing', message: `Requires ${INSIGHTS_SCOPE} — not granted.` });
      return;
    }
    const body = (req.body ?? {}) as { mediaId?: unknown; metrics?: unknown };
    const mediaId = typeof body.mediaId === 'string' ? body.mediaId.trim() : '';
    if (!mediaId) {
      res.status(400).json({ error: 'invalid_input', message: 'Provide mediaId.' });
      return;
    }
    const requestedMetrics = Array.isArray(body.metrics)
      ? body.metrics.filter((m): m is string => typeof m === 'string').map((m) => m.trim()).filter(Boolean)
      : [...INSIGHT_METRICS_REELS_FEED];
    const metrics = requestedMetrics.length > 0 ? requestedMetrics : [...INSIGHT_METRICS_REELS_FEED];
    const result = await fetchMediaInsights(session.tokens.accessToken, mediaId, metrics, d.apiVersion, {
      fetchImpl: d.fetchImpl,
    });
    const map = result.ok ? insightsToMap(result.data) : {};
    // Ensure every requested metric appears explicitly (null = unavailable/unsupported).
    const normalized: Record<string, number | null> = {};
    for (const m of metrics) normalized[m] = m in map ? map[m] : null;
    const observation = d.observations.add(session.key, {
      kind: 'media_insights',
      startedAt: result.startedAt,
      receivedAt: result.receivedAt,
      endpoint: `GET graph.instagram.com/${d.apiVersion}/${mediaId}/insights`,
      requested: { metrics, mediaId },
      httpStatus: result.httpStatus,
      providerError: result.providerError,
      transportError: result.transportError,
      metrics: [normalized as Record<string, unknown>],
      data: result.data,
      precisionWarnings: result.precisionWarnings,
      ok: result.ok,
    });
    res.json({
      observationId: observation.id,
      ...sanitizeApiResultForClient(result, { metrics }),
      insights: normalized,
      mediaId,
    });
  });

  // ---------- Token extend/refresh ----------
  app.post('/api/instagram/refresh', (req, res) => {
    if (!sameOriginGuard(req, d)) {
      res.status(403).json({ error: 'csrf_blocked', message: 'Blocked cross-site or unflagged request.' });
      return;
    }
    const session = requireSession(req, res, d);
    if (!session || !session.tokens) return;

    const respondToRefresh = (result: RefreshResult) => {
      if (result.ok) {
        d.store.storeTokens(session.key, result.tokens);
        res.json({ ok: true, expiresAt: result.tokens.expiresAt, isLongLived: result.tokens.isLongLived });
      } else {
        d.store.recordRefreshFailure(session.key, result.category, result.detail);
        res.status(400).json({ ok: false, category: result.category, message: result.detail });
      }
    };

    if (session.refreshInFlight) {
      void session.refreshInFlight.then(respondToRefresh);
      return;
    }

    const current = session.tokens as TokenSet;
    const promise: Promise<RefreshResult> = extendLongLivedToken(
      { accessToken: current.accessToken, userId: current.userId, scope: current.scope },
      { fetchImpl: d.fetchImpl },
    )
      .then((result): RefreshResult => {
        d.store.clearRefreshInFlight(session.key);
        if (result.ok && result.tokens) {
          d.observations.add(session.key, {
            kind: 'token_extend',
            startedAt: result.startedAt,
            receivedAt: result.receivedAt,
            endpoint: 'GET graph.instagram.com/refresh_access_token (ig_refresh_token)',
            requested: {},
            httpStatus: result.httpStatus,
            providerError: result.providerError,
            transportError: result.transportError,
            metrics: [],
            data: { user_id: result.tokens.userId, isLongLived: true, rotated: result.rotated },
            precisionWarnings: [],
            ok: true,
          });
          return { ok: true, tokens: result.tokens, rotated: result.rotated };
        }
        const code = result.providerError?.code ?? '';
        const expired =
          code === '190' || /expired|invalid.*token|session.*invalid/i.test(result.providerError?.message ?? '');
        return {
          ok: false,
          category: result.providerError ? (expired ? 'authorization_expired' : 'refresh_failed') : 'transport',
          detail: oauthFailureDetail(result.providerError, result.transportError, result.httpStatus),
        };
      })
      .catch((): RefreshResult => {
        d.store.clearRefreshInFlight(session.key);
        return { ok: false, category: 'transport', detail: 'Unexpected refresh failure.' };
      });
    session.refreshInFlight = promise;
    void promise.then(respondToRefresh);
  });

  // ---------- Compare ----------
  app.post('/api/compare', (req, res) => {
    if (!sameOriginGuard(req, d)) {
      res.status(403).json({ error: 'csrf_blocked', message: 'Blocked cross-site or unflagged request.' });
      return;
    }
    const session = requireSession(req, res, d);
    if (!session || !session.tokens) return;
    const body = (req.body ?? {}) as {
      officialMedia?: unknown;
      officialObservedAt?: unknown;
      baselineJson?: unknown;
    };
    const officialMedia =
      typeof body.officialMedia === 'object' && body.officialMedia !== null
        ? (body.officialMedia as Record<string, unknown>)
        : null;
    if (!officialMedia) {
      res.status(400).json({ error: 'invalid_input', message: 'Missing official media object.' });
      return;
    }
    const official = metricsFromMedia(officialMedia);
    if (!official) {
      res.status(400).json({ error: 'invalid_input', message: 'Official media object has no usable id.' });
      return;
    }
    official.observedAt = typeof body.officialObservedAt === 'string' ? body.officialObservedAt : null;
    if (typeof body.baselineJson !== 'string' || body.baselineJson.trim().length === 0) {
      res.status(400).json({ error: 'invalid_input', message: 'Missing baseline JSON text.' });
      return;
    }
    const baselineResult = parseBaselineJson(body.baselineJson);
    if (!baselineResult.ok) {
      res.status(400).json({ error: 'invalid_baseline', message: baselineResult.error });
      return;
    }
    const comparison = compareMetrics(official, baselineResult.baseline);
    if (!comparison) {
      res.status(400).json({
        error: 'id_mismatch',
        message: `Baseline mediaId ${baselineResult.baseline.mediaId} does not match official media ${official.mediaId}.`,
      });
      return;
    }
    res.json({ comparison });
  });

  app.get('/api/observations', (req, res) => {
    const session = sessionFromReq(req, d);
    if (!session || !session.tokens) {
      res.status(401).json({ error: 'unauthenticated', message: 'Connect Instagram first.' });
      return;
    }
    // Defensive: strip any secret-like keys if they ever appear (they never should).
    const observations = d.observations.list(session.key).map((o) => ({
      ...o,
      data: sanitizeExport(o.data),
    }));
    res.json({ observations });
  });

  return { store: d.store, observations: d.observations };
}

function sanitizeExport(data: unknown): unknown {
  // Shallow redaction of known secret keys; observations never store tokens,
  // but this guards export if provider echoes unexpected fields.
  if (typeof data !== 'object' || data === null) return data;
  if (Array.isArray(data)) return data.map(sanitizeExport);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
    if (/^(access_token|client_secret|code|cookie|authorization)$/i.test(k)) {
      out[k] = '[REDACTED]';
    } else {
      out[k] = typeof v === 'object' && v !== null ? sanitizeExport(v) : v;
    }
  }
  void sanitizeGraphUrl;
  return out;
}
