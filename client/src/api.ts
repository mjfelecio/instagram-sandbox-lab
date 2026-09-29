/**
 * Fetch helper for the Instagram lab UI. All state-changing requests carry the
 * custom CSRF-resistance header; responses are JSON. No tokens beyond the
 * HttpOnly session cookie.
 */

export interface ApiError {
  error: string;
  message: string;
  status: number;
}

async function request<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Requested-With': 'instagram-sandbox-lab',
    },
    credentials: 'same-origin',
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch {
    /* empty or non-JSON body */
  }
  if (!response.ok) {
    const obj = (payload ?? {}) as Record<string, unknown>;
    const error: ApiError = {
      error: typeof obj.error === 'string' ? obj.error : 'request_failed',
      message: typeof obj.message === 'string' ? obj.message : `HTTP ${response.status}`,
      status: response.status,
    };
    throw error;
  }
  return payload as T;
}

export interface StatusResponse {
  connected: boolean;
  publicOrigin: string | null;
  callbackUrl: string | null;
  configuredScopes: string[];
  grantedScopes: string[];
  accessTokenExpiresAt: number | null;
  isLongLived: boolean | null;
  providerUserId: string | null;
  apiVersion: string;
  authFailure: { category: string; detail: string; at: number } | null;
  refreshFailure: { category: string; detail: string; at: number } | null;
  credentialsConfigured: boolean;
}

export interface ApiCallPayload {
  ok: boolean;
  httpStatus: number;
  providerError: { code: string; message: string; type?: string } | null;
  data: unknown;
  rawBody: string;
  sanitizedUrl?: string;
  precisionWarnings: string[];
  transportError?: string;
  startedAt: number;
  receivedAt: number;
  requestedFields: string[];
  requestedMetrics?: string[];
}

export interface AccountPayload extends ApiCallPayload {}

export interface MediaListPayload extends ApiCallPayload {
  ids: string[];
  after: string | null;
  hasMore: boolean;
}

export interface MediaFetchPayload {
  observationId: string;
  ok: boolean;
  medias: Array<Record<string, unknown>>;
  requestedIds: string[];
  notReturned: string[];
  note?: string;
}

export interface ResolvePayload extends ApiCallPayload {
  matched: Record<string, unknown> | null;
  pagesWalked: number;
  method: string;
  requested: { shortcode: string | null; canonicalUrl: string | null };
  note?: string;
}

export interface InsightsPayload extends ApiCallPayload {
  insights: Record<string, number | null>;
  mediaId: string;
}

export interface ComparePayload {
  comparison: {
    mediaId: string;
    rows: Array<{
      metric: string;
      official: number | null;
      baseline: number | null;
      diff: number | null;
      percentDiff: number | null;
    }>;
    officialObservedAt: string | null;
    baselineObservedAt: string | null;
    observationGapMs: number | null;
  };
}

export const api = {
  status: () => request<StatusResponse>('/api/status'),
  clearSession: () => request<{ ok: true; note: string }>('/api/session/clear', {}),
  account: () => request<AccountPayload & { observationId: string }>('/api/instagram/account', {}),
  mediaList: (after?: string | null, limit?: number) =>
    request<MediaListPayload>('/api/instagram/media', { after: after ?? undefined, limit }),
  mediaFetch: (ids: string[]) =>
    request<MediaFetchPayload>('/api/instagram/media/fetch', { ids }),
  resolve: (input: string, maxPages?: number) =>
    request<ResolvePayload>('/api/instagram/resolve', { input, maxPages }),
  insights: (mediaId: string, metrics?: string[]) =>
    request<InsightsPayload>('/api/instagram/insights', { mediaId, metrics }),
  refresh: () => request<{ ok: true; expiresAt: number; isLongLived: boolean }>('/api/instagram/refresh', {}),
  compare: (officialMedia: Record<string, unknown>, officialObservedAt: string | null, baselineJson: string) =>
    request<ComparePayload>('/api/compare', { officialMedia, officialObservedAt, baselineJson }),
  observations: () => request<{ observations: unknown[] }>('/api/observations'),
};
