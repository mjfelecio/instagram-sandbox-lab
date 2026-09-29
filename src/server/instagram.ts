/**
 * Instagram API client for the lab (Instagram API with Instagram Login).
 * Server-side native fetch only, with request timeouts and bounded bodies.
 *
 * Official endpoints (Meta docs, validated 2026-09-29, API v25.0):
 * - Authorize:        https://www.instagram.com/oauth/authorize
 * - Code exchange:    POST https://api.instagram.com/oauth/access_token
 *                     (form: client_id, client_secret, grant_type=authorization_code,
 *                      redirect_uri, code) -> { data: [{ access_token, user_id, permissions }] }
 * - Long-lived:       GET https://graph.instagram.com/access_token
 *                     ?grant_type=ig_exchange_token&client_secret&access_token
 * - Refresh:          GET https://graph.instagram.com/refresh_access_token
 *                     ?grant_type=ig_refresh_token&access_token
 * - Account:          GET https://graph.instagram.com/<ver>/me?fields=...&access_token=...
 * - Owned media:      GET https://graph.instagram.com/<ver>/<IG_ID>/media?limit&after&access_token=...
 * - Single media:     GET https://graph.instagram.com/<ver>/<MEDIA_ID>?fields=...&access_token=...
 * - Media Insights:   GET https://graph.instagram.com/<ver>/<MEDIA_ID>/insights?metric=...&access_token=...
 *
 * Notes:
 * - No PKCE in Business Login docs; CSRF protection is via `state`.
 * - Graph endpoints take access_token as a query param; URLs are sanitized
 *   (token redacted) before logging/exporting.
 * - An HTTP 200 carrying { error: {...} } is NOT success.
 * - Never logs tokens, secrets, codes, or authorization headers.
 */

import type { TokenSet } from './session.js';

export const INSTAGRAM_AUTHORIZE_URL = 'https://www.instagram.com/oauth/authorize';
export const INSTAGRAM_CODE_TOKEN_URL = 'https://api.instagram.com/oauth/access_token';
export const INSTAGRAM_GRAPH_HOST = 'https://graph.instagram.com';

const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 20_000;

export interface ProviderError {
  code: string;
  message: string;
  type?: string;
}

export interface ApiCallResult {
  ok: boolean;
  httpStatus: number;
  providerError: ProviderError | null;
  data: unknown;
  rawBody: string;
  /** Sanitized endpoint description with secrets redacted (safe for UI/export). */
  sanitizedUrl: string;
  precisionWarnings: string[];
  transportError?: string;
  startedAt: number;
  receivedAt: number;
}

export type FetchImpl = typeof fetch;

export function sanitizeGraphUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.searchParams.has('access_token')) parsed.searchParams.set('access_token', '[REDACTED]');
    if (parsed.searchParams.has('client_secret')) parsed.searchParams.set('client_secret', '[REDACTED]');
    return parsed.toString();
  } catch {
    return url.replace(/access_token=[^&\s]+/g, 'access_token=[REDACTED]');
  }
}

/** Parse Graph error envelope { error: { message, type, code, ... } }. */
export function parseProviderError(body: unknown): ProviderError | null {
  if (typeof body !== 'object' || body === null) return null;
  const err = (body as Record<string, unknown>).error;
  if (typeof err !== 'object' || err === null) return null;
  const e = err as Record<string, unknown>;
  const message = typeof e.message === 'string' ? e.message : '';
  if (!message && e.code === undefined) return null;
  const code =
    typeof e.code === 'number' || typeof e.code === 'string'
      ? String(e.code)
      : typeof e.error_subcode === 'number'
        ? String(e.error_subcode)
        : 'provider_error';
  const type = typeof e.type === 'string' ? e.type : undefined;
  return { code, message: message || `Provider error ${code}`, type };
}

/** Parse token-exchange error shapes ({error_type,...} or {error,...}). */
export function parseTokenError(body: unknown): ProviderError | null {
  if (typeof body !== 'object' || body === null) return null;
  const obj = body as Record<string, unknown>;
  if (typeof obj.error_type === 'string') {
    const msg = typeof obj.error_message === 'string' ? obj.error_message : obj.error_type;
    const code = obj.code !== undefined ? String(obj.code) : obj.error_type;
    return { code, message: msg, type: obj.error_type };
  }
  if (typeof obj.error === 'string') {
    const desc = typeof obj.error_description === 'string' ? obj.error_description : '';
    return { code: obj.error, message: desc ? `${obj.error}: ${desc}` : obj.error, type: 'oauth' };
  }
  return parseProviderError(body);
}

const COUNT_FIELD_PATTERN =
  /"(views|reach|likes|comments|shares|saved|saves|total_interactions|like_count|comments_count|followers_count|follows_count|media_count|value)"\s*:\s*(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g;

export function scanCountPrecision(rawBody: string): string[] {
  const warnings: string[] = [];
  let match: RegExpExecArray | null;
  const seen = new Set<string>();
  COUNT_FIELD_PATTERN.lastIndex = 0;
  while ((match = COUNT_FIELD_PATTERN.exec(rawBody)) !== null) {
    const field = match[1];
    const rawNumber = match[2];
    const key = `${field}:${rawNumber}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (!/^-?\d+$/.test(rawNumber)) {
      warnings.push(`${field}: unsupported numeric format "${rawNumber}" (not a plain integer).`);
      continue;
    }
    const value = Number(rawNumber);
    if (!Number.isSafeInteger(value)) {
      warnings.push(`${field}: value ${rawNumber} exceeds safe integer precision; exact digits preserved in raw response.`);
    }
  }
  return warnings;
}

async function boundedRead(response: Response, maxBytes = MAX_RESPONSE_BYTES): Promise<string> {
  const contentLength = response.headers.get('content-length');
  if (contentLength) {
    const declared = Number(contentLength);
    if (Number.isFinite(declared) && declared > maxBytes) {
      throw new Error(`Response too large (${declared} bytes, limit ${maxBytes}).`);
    }
  }
  const body = response.body;
  if (!body) return '';
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let received = 0;
  let text = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      received += value.byteLength;
      if (received > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error(`Response too large (> ${maxBytes} bytes).`);
      }
      text += decoder.decode(value, { stream: true });
    }
  }
  text += decoder.decode();
  return text;
}

interface CommonCallOptions {
  fetchImpl?: FetchImpl;
  timeoutMs?: number;
}

async function callGraphApi(sanitizedDescription: string, url: string, init: RequestInit, opts: CommonCallOptions): Promise<ApiCallResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const sanitizedUrl = sanitizeGraphUrl(url);
  void sanitizedDescription;
  const startedAt = Date.now();
  let response: Response;
  try {
    response = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const category =
      message.includes('TimeoutError') || message.includes('timed out')
        ? 'Request timed out.'
        : `Network error: ${message.slice(0, 200)}`;
    return {
      ok: false, httpStatus: 0, providerError: null, data: null, rawBody: '',
      sanitizedUrl, precisionWarnings: [], transportError: category, startedAt, receivedAt: Date.now(),
    };
  }
  const receivedAt = Date.now();
  let rawBody = '';
  let parsed: unknown = null;
  let malformed: string | undefined;
  try {
    rawBody = await boundedRead(response);
    if (rawBody.trim().length > 0) parsed = JSON.parse(rawBody);
  } catch (error) {
    malformed = error instanceof Error ? error.message : String(error);
  }
  const providerError = parsed ? parseProviderError(parsed) : null;
  // Graph success shapes: bare object, { data: [...] }, or { data: {...} }.
  const data = parsed;
  let ok = response.status >= 200 && response.status < 300;
  if (ok && malformed) ok = false;
  if (ok && providerError) ok = false;
  return {
    ok, httpStatus: response.status, providerError, data,
    rawBody: rawBody.slice(0, MAX_RESPONSE_BYTES), sanitizedUrl,
    precisionWarnings: rawBody ? scanCountPrecision(rawBody) : [],
    transportError: malformed ? `Malformed response: ${malformed.slice(0, 200)}` : undefined,
    startedAt, receivedAt,
  };
}

function formBody(fields: Record<string, string>): string {
  return new URLSearchParams(fields).toString();
}

export interface TokenCallResult {
  ok: boolean;
  httpStatus: number;
  tokens: TokenSet | null;
  providerError: ProviderError | null;
  transportError?: string;
  startedAt: number;
  receivedAt: number;
}

interface ExchangePayload {
  accessToken: string;
  userId: string;
  permissions: string;
}

function exchangePayloadFromBody(parsed: unknown): ExchangePayload | null {
  if (typeof parsed !== 'object' || parsed === null) return null;
  const obj = parsed as Record<string, unknown>;
  // Documented shape: { data: [{ access_token, user_id, permissions }] }
  const data = obj.data;
  const candidate =
    Array.isArray(data) && data.length > 0 && typeof data[0] === 'object' && data[0] !== null
      ? (data[0] as Record<string, unknown>)
      : obj;
  const accessToken = typeof candidate.access_token === 'string' ? candidate.access_token : null;
  const userId =
    typeof candidate.user_id === 'string'
      ? candidate.user_id
      : typeof candidate.userId === 'string'
        ? candidate.userId
        : null;
  if (!accessToken || !userId) return null;
  const permissions =
    typeof candidate.permissions === 'string'
      ? candidate.permissions
      : Array.isArray(candidate.permissions)
        ? candidate.permissions.filter((p): p is string => typeof p === 'string').join(',')
        : typeof candidate.scope === 'string'
          ? candidate.scope
          : '';
  return { accessToken, userId, permissions };
}

function longLivedPayloadFromBody(parsed: unknown): { accessToken: string; expiresIn: number; tokenType: string } | null {
  if (typeof parsed !== 'object' || parsed === null) return null;
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.access_token !== 'string') return null;
  const expiresIn = typeof obj.expires_in === 'number' ? obj.expires_in : 0;
  return {
    accessToken: obj.access_token,
    expiresIn,
    tokenType: typeof obj.token_type === 'string' ? obj.token_type : 'bearer',
  };
}

export function buildAuthorizeUrl(params: {
  appId: string;
  redirectUri: string;
  scopes: string[];
  state: string;
}): string {
  const search = new URLSearchParams({
    client_id: params.appId,
    redirect_uri: params.redirectUri,
    response_type: 'code',
    scope: params.scopes.join(','),
    state: params.state,
  });
  return `${INSTAGRAM_AUTHORIZE_URL}?${search.toString()}`;
}

/** Exchange authorization code for short-lived token (1h). */
export async function exchangeAuthorizationCode(
  creds: { appId: string; appSecret: string },
  params: { code: string; redirectUri: string },
  opts: CommonCallOptions = {},
): Promise<TokenCallResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const startedAt = Date.now();
  let response: Response;
  try {
    response = await fetchImpl(INSTAGRAM_CODE_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: formBody({
        client_id: creds.appId,
        client_secret: creds.appSecret,
        code: params.code,
        grant_type: 'authorization_code',
        redirect_uri: params.redirectUri,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false, httpStatus: 0, tokens: null, providerError: null,
      transportError: `Network error: ${message.slice(0, 200)}`, startedAt, receivedAt: Date.now(),
    };
  }
  const receivedAt = Date.now();
  let parsed: unknown = null;
  try {
    const text = await boundedRead(response);
    parsed = text.trim() ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }
  const payload = parsed ? exchangePayloadFromBody(parsed) : null;
  const providerError = parsed ? parseTokenError(parsed) : null;
  // Short-lived lifetime is 1h per docs when expires_in absent.
  const SHORT_LIVED_SECONDS = 3600;
  const tokens: TokenSet | null = payload
    ? {
        accessToken: payload.accessToken,
        userId: payload.userId,
        scope: payload.permissions,
        tokenType: 'bearer',
        expiresAt: receivedAt + SHORT_LIVED_SECONDS * 1000,
        obtainedAt: receivedAt,
        isLongLived: false,
      }
    : null;
  const ok = response.status === 200 && tokens !== null;
  return { ok, httpStatus: response.status, tokens, providerError: ok ? null : providerError, startedAt, receivedAt };
}

/** Exchange short-lived token for long-lived (60d). Requires app secret, server-side. */
export async function exchangeForLongLivedToken(
  params: { appSecret: string; shortLivedToken: string; userId: string; scope: string },
  opts: CommonCallOptions = {},
): Promise<TokenCallResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const startedAt = Date.now();
  const url =
    `${INSTAGRAM_GRAPH_HOST}/access_token?grant_type=ig_exchange_token` +
    `&client_secret=${encodeURIComponent(params.appSecret)}` +
    `&access_token=${encodeURIComponent(params.shortLivedToken)}`;
  let response: Response;
  try {
    response = await fetchImpl(url, { method: 'GET', signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false, httpStatus: 0, tokens: null, providerError: null,
      transportError: `Network error: ${message.slice(0, 200)}`, startedAt, receivedAt: Date.now(),
    };
  }
  const receivedAt = Date.now();
  let parsed: unknown = null;
  try {
    const text = await boundedRead(response);
    parsed = text.trim() ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }
  const payload = parsed ? longLivedPayloadFromBody(parsed) : null;
  const providerError = parsed ? parseTokenError(parsed) : null;
  const tokens: TokenSet | null = payload
    ? {
        accessToken: payload.accessToken,
        userId: params.userId,
        scope: params.scope,
        tokenType: payload.tokenType,
        expiresAt: receivedAt + (payload.expiresIn > 0 ? payload.expiresIn : 60 * 24 * 3600) * 1000,
        obtainedAt: receivedAt,
        isLongLived: true,
      }
    : null;
  const ok = response.status === 200 && tokens !== null;
  return { ok, httpStatus: response.status, tokens, providerError: ok ? null : providerError, startedAt, receivedAt };
}

/** Refresh/extend a long-lived token for another 60 days. */
export async function extendLongLivedToken(
  params: { accessToken: string; userId: string; scope: string },
  opts: CommonCallOptions = {},
): Promise<TokenCallResult & { rotated: boolean }> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const startedAt = Date.now();
  const url =
    `${INSTAGRAM_GRAPH_HOST}/refresh_access_token?grant_type=ig_refresh_token` +
    `&access_token=${encodeURIComponent(params.accessToken)}`;
  let response: Response;
  try {
    response = await fetchImpl(url, { method: 'GET', signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false, httpStatus: 0, tokens: null, providerError: null, rotated: false,
      transportError: `Network error: ${message.slice(0, 200)}`, startedAt, receivedAt: Date.now(),
    };
  }
  const receivedAt = Date.now();
  let parsed: unknown = null;
  try {
    const text = await boundedRead(response);
    parsed = text.trim() ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }
  const payload = parsed ? longLivedPayloadFromBody(parsed) : null;
  const providerError = parsed ? parseTokenError(parsed) : null;
  const tokens: TokenSet | null = payload
    ? {
        accessToken: payload.accessToken,
        userId: params.userId,
        scope: params.scope,
        tokenType: payload.tokenType,
        expiresAt: receivedAt + (payload.expiresIn > 0 ? payload.expiresIn : 60 * 24 * 3600) * 1000,
        obtainedAt: receivedAt,
        isLongLived: true,
      }
    : null;
  const ok = response.status === 200 && tokens !== null;
  return {
    ok, httpStatus: response.status, tokens, providerError: ok ? null : providerError,
    rotated: ok && tokens !== null && tokens.accessToken !== params.accessToken,
    startedAt, receivedAt,
  };
}

export function graphUrl(apiVersion: string, path: string, query: Record<string, string>): string {
  const search = new URLSearchParams(query);
  return `${INSTAGRAM_GRAPH_HOST}/${apiVersion}${path}?${search.toString()}`;
}

/** GET /me — account identity + profile fields. */
export async function fetchAccountInfo(
  accessToken: string,
  fields: string[],
  apiVersion: string,
  opts: CommonCallOptions = {},
): Promise<ApiCallResult> {
  const url = graphUrl(apiVersion, '/me', { fields: fields.join(','), access_token: accessToken });
  return callGraphApi('GET /me', url, { method: 'GET' }, opts);
}

/** GET /<IG_ID>/media — one page of owned media IDs (+ paging cursors). */
export async function fetchOwnedMediaPage(
  accessToken: string,
  igUserId: string,
  params: { limit: number; after?: string },
  apiVersion: string,
  opts: CommonCallOptions = {},
): Promise<ApiCallResult> {
  const query: Record<string, string> = {
    limit: String(params.limit),
    access_token: accessToken,
  };
  if (params.after) query.after = params.after;
  const url = graphUrl(apiVersion, `/${igUserId}/media`, query);
  return callGraphApi(`GET /${igUserId}/media`, url, { method: 'GET' }, opts);
}

/** GET /<MEDIA_ID> — single media object with explicit fields. */
export async function fetchMedia(
  accessToken: string,
  mediaId: string,
  fields: string[],
  apiVersion: string,
  opts: CommonCallOptions = {},
): Promise<ApiCallResult> {
  const url = graphUrl(apiVersion, `/${mediaId}`, { fields: fields.join(','), access_token: accessToken });
  return callGraphApi(`GET /${mediaId}`, url, { method: 'GET' }, opts);
}

/** GET /<MEDIA_ID>/insights — explicit metric list. */
export async function fetchMediaInsights(
  accessToken: string,
  mediaId: string,
  metrics: string[],
  apiVersion: string,
  opts: CommonCallOptions = {},
): Promise<ApiCallResult> {
  const url = graphUrl(apiVersion, `/${mediaId}/insights`, {
    metric: metrics.join(','),
    access_token: accessToken,
  });
  return callGraphApi(`GET /${mediaId}/insights`, url, { method: 'GET' }, opts);
}

/** Extract media ID list + paging cursors from an owned-media page body. */
export function extractMediaPage(data: unknown): { ids: string[]; after: string | null; hasMore: boolean } {
  if (typeof data !== 'object' || data === null) return { ids: [], after: null, hasMore: false };
  const obj = data as Record<string, unknown>;
  const rawList = Array.isArray(obj.data) ? obj.data : [];
  const ids: string[] = [];
  for (const item of rawList) {
    if (typeof item === 'object' && item !== null && typeof (item as Record<string, unknown>).id === 'string') {
      ids.push((item as Record<string, unknown>).id as string);
    } else if (typeof item === 'string') {
      ids.push(item);
    }
  }
  const paging = obj.paging && typeof obj.paging === 'object' ? (obj.paging as Record<string, unknown>) : null;
  const cursors =
    paging && typeof paging.cursors === 'object' && paging.cursors !== null
      ? (paging.cursors as Record<string, unknown>)
      : null;
  const after = cursors && typeof cursors.after === 'string' ? cursors.after : null;
  const hasMore = Boolean(after);
  return { ids, after, hasMore };
}

/** Normalize Insights response data array into metric->value map (values stay unknown when missing). */
export function insightsToMap(data: unknown): Record<string, number | null> {
  const out: Record<string, number | null> = {};
  if (typeof data !== 'object' || data === null) return out;
  const obj = data as Record<string, unknown>;
  const list = Array.isArray(obj.data) ? obj.data : [];
  for (const entry of list) {
    if (typeof entry !== 'object' || entry === null) continue;
    const e = entry as Record<string, unknown>;
    const name = typeof e.name === 'string' ? e.name : null;
    if (!name) continue;
    // Preferred: values[0].value ; fallback: total_value.value
    let value: unknown = null;
    if (Array.isArray(e.values) && e.values.length > 0) {
      const first = e.values[0];
      if (typeof first === 'object' && first !== null) value = (first as Record<string, unknown>).value;
    }
    if (value === null && typeof e.total_value === 'object' && e.total_value !== null) {
      value = (e.total_value as Record<string, unknown>).value;
    }
    if (typeof value === 'number' && Number.isFinite(value)) out[name] = value;
    else out[name] = null;
  }
  return out;
}
