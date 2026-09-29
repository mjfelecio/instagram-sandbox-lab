import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { registerRoutes } from '../src/server/routes';
import { SessionStore } from '../src/server/session';
import { ObservationStore } from '../src/server/observations';

const PUBLIC_ORIGIN = 'https://lab.ngrok.test';

function jsonFetchFor(handler: (url: string) => { status: number; body: unknown } | null) {
  return (async (url: string | URL) => {
    const spec = handler(String(url)) ?? { status: 500, body: {} };
    return new Response(JSON.stringify(spec.body), {
      status: spec.status,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
}

const SHORT_EXCHANGE = {
  data: [{ access_token: 'short.1', user_id: '179100', permissions: 'instagram_business_basic,instagram_business_manage_insights' }],
};
const LONG_EXCHANGE = { access_token: 'long.1', token_type: 'bearer', expires_in: 5184000 };
const REFRESH_OK = { access_token: 'long.2', token_type: 'bearer', expires_in: 5184000 };

function defaultFetch(): typeof fetch {
  return jsonFetchFor((url) => {
    if (url.includes('refresh_access_token')) return { status: 200, body: REFRESH_OK };
    if (url.includes('graph.instagram.com/access_token')) return { status: 200, body: LONG_EXCHANGE };
    if (url.includes('oauth/access_token')) return { status: 200, body: SHORT_EXCHANGE };
    return null;
  });
}

interface Harness {
  app: express.Express;
  store: SessionStore;
}

function buildHarness(opts: {
  fetchImpl: typeof fetch;
  publicOrigin?: string | null;
  extraAllowedOrigins?: string[];
  appId?: string | null;
  appSecret?: string | null;
  scopes?: string[];
  apiVersion?: string;
}): Harness {
  const app = express();
  app.use(express.json({ limit: '256kb' }));
  app.use(cookieParser());
  const store = new SessionStore();
  const observations = new ObservationStore();
  registerRoutes(app, {
    store,
    observations,
    getPublicOrigin: () => (opts.publicOrigin === undefined ? PUBLIC_ORIGIN : opts.publicOrigin),
    fetchImpl: opts.fetchImpl,
    extraAllowedOrigins: opts.extraAllowedOrigins,
    appId: opts.appId === undefined ? 'test-app-id' : opts.appId,
    appSecret: opts.appSecret === undefined ? 'test-app-secret' : opts.appSecret,
    scopes: opts.scopes ?? ['instagram_business_basic', 'instagram_business_manage_insights'],
    apiVersion: opts.apiVersion ?? 'v25.0',
    port: 5180,
  });
  return { app, store };
}

const CSRF_HEADERS = {
  Origin: PUBLIC_ORIGIN,
  'X-Requested-With': 'instagram-sandbox-lab',
  'Content-Type': 'application/json',
};

async function connectSession(harness: Harness): Promise<string> {
  const jar: string[] = [];
  const start = await request(harness.app)
    .get('/auth/instagram/start')
    .expect(302)
    .expect((res) => {
      const raw = res.headers['set-cookie'];
      if (raw) jar.push(...(Array.isArray(raw) ? raw : [raw]));
    });
  expect(start.headers.location).toContain('instagram.com/oauth/authorize');
  const cookie = jar[0].split(';')[0];
  const state = /state=([0-9a-f]+)/.exec(start.headers.location)![1];
  // Allow async long-lived upgrade to settle.
  await request(harness.app).get(`/auth/instagram/callback?code=AUTHCODE&state=${state}`).set('Cookie', cookie).expect(303);
  await new Promise((r) => setTimeout(r, 50));
  return cookie;
}

describe('OAuth', () => {
  it('valid start redirects to Instagram authorize', async () => {
    const harness = buildHarness({ fetchImpl: defaultFetch() });
    const res = await request(harness.app).get('/auth/instagram/start').expect(302);
    expect(res.headers.location).toContain('https://www.instagram.com/oauth/authorize');
    expect(res.headers.location).toContain('client_id=test-app-id');
    expect(res.headers.location).toContain('response_type=code');
  });

  it('missing configuration returns 400', async () => {
    const harness = buildHarness({ fetchImpl: defaultFetch(), appId: null, appSecret: null });
    await request(harness.app).get('/auth/instagram/start').expect(400);
  });

  it('rejects callback without session', async () => {
    const harness = buildHarness({ fetchImpl: defaultFetch() });
    const res = await request(harness.app).get('/auth/instagram/callback?code=x&state=y').expect(303);
    expect(res.headers.location).toContain('auth_error=session_missing');
  });

  it('rejects state mismatch', async () => {
    const harness = buildHarness({ fetchImpl: defaultFetch() });
    const cookie = await request(harness.app).get('/auth/instagram/start').then((r) => r.headers['set-cookie'][0].split(';')[0]);
    const res = await request(harness.app).get('/auth/instagram/callback?code=x&state=deadbeef').set('Cookie', cookie).expect(303);
    expect(res.headers.location).toContain('auth_error=state_mismatched');
  });

  it('rejects replay', async () => {
    const harness = buildHarness({ fetchImpl: defaultFetch() });
    const start1 = await request(harness.app).get('/auth/instagram/start').expect(302);
    const cookie = start1.headers['set-cookie'][0].split(';')[0];
    const start2 = await request(harness.app).get('/auth/instagram/start').set('Cookie', cookie).expect(302);
    const state = /state=([0-9a-f]+)/.exec(start2.headers.location)![1];
    const ok = await request(harness.app).get(`/auth/instagram/callback?code=A&state=${state}`).set('Cookie', cookie).expect(303);
    expect(ok.headers.location).toContain('connected=1');
    await new Promise((r) => setTimeout(r, 50));
    const replay = await request(harness.app).get(`/auth/instagram/callback?code=B&state=${state}`).set('Cookie', cookie).expect(303);
    expect(replay.headers.location).toContain('auth_error=state_replayed');
  });

  it('rejects expired state', async () => {
    const store = new SessionStore({ stateTtlMs: 1000 });
    const app = express();
    app.use(express.json());
    app.use(cookieParser());
    const observations = new ObservationStore();
    registerRoutes(app, {
      store, observations, getPublicOrigin: () => PUBLIC_ORIGIN, fetchImpl: defaultFetch(),
      appId: 'id', appSecret: 'sec', scopes: ['instagram_business_basic'], apiVersion: 'v25.0', port: 5180,
    });
    const start = await request(app).get('/auth/instagram/start').expect(302);
    const cookie = start.headers['set-cookie'][0].split(';')[0];
    const state = /state=([0-9a-f]+)/.exec(start.headers.location)![1];
    await new Promise((r) => setTimeout(r, 1100));
    const res = await request(app).get(`/auth/instagram/callback?code=x&state=${state}`).set('Cookie', cookie).expect(303);
    expect(res.headers.location).toContain('auth_error=state_expired');
  });

  it('records provider-denied consent', async () => {
    const harness = buildHarness({ fetchImpl: defaultFetch() });
    const cookie = await request(harness.app).get('/auth/instagram/start').then((r) => r.headers['set-cookie'][0].split(';')[0]);
    const res = await request(harness.app)
      .get('/auth/instagram/callback?error=access_denied&error_reason=user_denied&error_description=user+denied')
      .set('Cookie', cookie)
      .expect(303);
    expect(res.headers.location).toContain('auth_error=provider_denied');
  });

  it('exchange HTTP error surfaces exchange_failed', async () => {
    const harness = buildHarness({
      fetchImpl: jsonFetchFor((url) => {
        if (url.includes('oauth/access_token')) {
          return { status: 400, body: { error_type: 'OAuthException', code: 400, error_message: 'bad code' } };
        }
        return null;
      }),
    });
    const start = await request(harness.app).get('/auth/instagram/start').expect(302);
    const cookie = start.headers['set-cookie'][0].split(';')[0];
    const state = /state=([0-9a-f]+)/.exec(start.headers.location)![1];
    const res = await request(harness.app).get(`/auth/instagram/callback?code=BAD&state=${state}`).set('Cookie', cookie).expect(303);
    await new Promise((r) => setTimeout(r, 50));
    expect(res.headers.location).toContain('auth_error=exchange_failed');
  });

  it('successful exchange becomes connected with long-lived token', async () => {
    const harness = buildHarness({ fetchImpl: defaultFetch() });
    const cookie = await connectSession(harness);
    const status = await request(harness.app).get('/api/status').set('Cookie', cookie);
    expect(status.body.connected).toBe(true);
    expect(status.body.isLongLived).toBe(true);
    expect(status.body.providerUserId).toBe('179100');
  });

  it('secret/code excluded from browser-visible responses', async () => {
    const harness = buildHarness({ fetchImpl: defaultFetch() });
    const cookie = await connectSession(harness);
    const raw = JSON.stringify(await request(harness.app).get('/api/status').set('Cookie', cookie).then((r) => r.body));
    expect(raw).not.toContain('short.1');
    expect(raw).not.toContain('long.1');
    expect(raw).not.toContain('test-app-secret');
  });
});

describe('token lifecycle', () => {
  it('refresh success extends expiry', async () => {
    const harness = buildHarness({ fetchImpl: defaultFetch() });
    const cookie = await connectSession(harness);
    const before = await request(harness.app).get('/api/status').set('Cookie', cookie);
    const res = await request(harness.app).post('/api/instagram/refresh').set(CSRF_HEADERS).set('Cookie', cookie).send({}).expect(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.expiresAt).toBeGreaterThan(before.body.accessTokenExpiresAt - 1000);
  });

  it('concurrent refresh piggybacks (one provider call)', async () => {
    let calls = 0;
    const fetchImpl = jsonFetchFor((url) => {
      if (url.includes('refresh_access_token')) {
        calls += 1;
        return { status: 200, body: { access_token: 'long.N', token_type: 'bearer', expires_in: 5184000 } };
      }
      if (url.includes('graph.instagram.com/access_token')) return { status: 200, body: LONG_EXCHANGE };
      if (url.includes('oauth/access_token')) return { status: 200, body: SHORT_EXCHANGE };
      return null;
    });
    // Delay refresh response so two clicks overlap.
    const slowFetch = (async (url: string | URL, init?: RequestInit) => {
      if (String(url).includes('refresh_access_token')) await new Promise((r) => setTimeout(r, 100));
      return (fetchImpl as unknown as (u: string | URL, i?: RequestInit) => Promise<Response>)(url, init);
    }) as unknown as typeof fetch;
    const harness = buildHarness({ fetchImpl: slowFetch });
    const cookie = await connectSession(harness);
    const [a, b] = await Promise.all([
      request(harness.app).post('/api/instagram/refresh').set(CSRF_HEADERS).set('Cookie', cookie).send({}),
      request(harness.app).post('/api/instagram/refresh').set(CSRF_HEADERS).set('Cookie', cookie).send({}),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(calls).toBe(1);
  });

  it('transient failure preserves previous token', async () => {
    const harness = buildHarness({
      fetchImpl: jsonFetchFor((url) => {
        if (url.includes('refresh_access_token')) throw new Error('unreachable');
        if (url.includes('graph.instagram.com/access_token')) return { status: 200, body: LONG_EXCHANGE };
        if (url.includes('oauth/access_token')) return { status: 200, body: SHORT_EXCHANGE };
        return null;
      }),
    });
    // jsonFetchFor cannot throw via return; build manual failing fetch for refresh only.
    void harness;
    const failingRefresh = (async (url: string | URL, init?: RequestInit) => {
      const s = String(url);
      if (s.includes('refresh_access_token')) throw new Error('network down');
      if (s.includes('graph.instagram.com/access_token')) {
        return new Response(JSON.stringify(LONG_EXCHANGE), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (s.includes('oauth/access_token')) {
        return new Response(JSON.stringify(SHORT_EXCHANGE), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response('{}', { status: 500 });
    }) as unknown as typeof fetch;
    const h2 = buildHarness({ fetchImpl: failingRefresh });
    const cookie = await connectSession(h2);
    const before = await request(h2.app).get('/api/status').set('Cookie', cookie);
    await request(h2.app).post('/api/instagram/refresh').set(CSRF_HEADERS).set('Cookie', cookie).send({}).expect(400);
    const after = await request(h2.app).get('/api/status').set('Cookie', cookie);
    expect(after.body.connected).toBe(true);
    expect(after.body.accessTokenExpiresAt).toBe(before.body.accessTokenExpiresAt);
  });

  it('authorization-expired failure categorized', async () => {
    const fetchImpl = jsonFetchFor((url) => {
      if (url.includes('refresh_access_token')) {
        return { status: 400, body: { error: { message: 'Error validating access token', type: 'OAuthException', code: 190 } } };
      }
      if (url.includes('graph.instagram.com/access_token')) return { status: 200, body: LONG_EXCHANGE };
      if (url.includes('oauth/access_token')) return { status: 200, body: SHORT_EXCHANGE };
      return null;
    });
    const harness = buildHarness({ fetchImpl });
    const cookie = await connectSession(harness);
    const res = await request(harness.app).post('/api/instagram/refresh').set(CSRF_HEADERS).set('Cookie', cookie).send({}).expect(400);
    expect(res.body.category).toBe('authorization_expired');
  });
});

describe('account and media', () => {
  function mediaHarness() {
    return buildHarness({
      fetchImpl: jsonFetchFor((url) => {
        if (url.includes('refresh_access_token')) return { status: 200, body: REFRESH_OK };
        if (url.includes('graph.instagram.com/access_token')) return { status: 200, body: LONG_EXCHANGE };
        if (url.includes('oauth/access_token')) return { status: 200, body: SHORT_EXCHANGE };
        if (url.includes('/insights')) {
          return {
            status: 200,
            body: {
              data: [
                { name: 'views', values: [{ value: 123456 }] },
                { name: 'reach', values: [{ value: 100000 }] },
                { name: 'likes', values: [{ value: 1200 }] },
                { name: 'comments', values: [{ value: 50 }] },
                { name: 'shares', values: [{ value: 30 }] },
                { name: 'saved', values: [{ value: 25 }] },
                { name: 'total_interactions', values: [{ value: 1305 }] },
              ],
            },
          };
        }
        if (url.includes('/me?')) {
          return { status: 200, body: { user_id: '179100', username: 'creator', account_type: 'Media_Creator', followers_count: 100 } };
        }
        if (url.includes('/179100/media')) {
          return {
            status: 200,
            body: { data: [{ id: '179111' }, { id: '179112' }], paging: { cursors: { after: 'AFTER1' } } },
          };
        }
        if (url.includes('/179111?') || url.includes('/179111/')) {
          return { status: 200, body: { id: '179111', media_type: 'VIDEO', permalink: 'https://www.instagram.com/reel/ABC123/', shortcode: 'ABC123', timestamp: '2026-01-01T00:00:00+0000', like_count: 10, comments_count: 2 } };
        }
        if (url.includes('/179112')) {
          return { status: 200, body: { id: '179112', media_type: 'IMAGE', permalink: 'https://www.instagram.com/p/XYZ789/', shortcode: 'XYZ789', timestamp: '2026-01-02T00:00:00+0000', like_count: 5, comments_count: 1 } };
        }
        return null;
      }),
    });
  }

  it('account fetch records observation with timestamps', async () => {
    const harness = mediaHarness();
    const cookie = await connectSession(harness);
    const res = await request(harness.app).post('/api/instagram/account').set(CSRF_HEADERS).set('Cookie', cookie).send({}).expect(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.observationId).toBeDefined();
    expect(res.body.startedAt).toBeLessThanOrEqual(res.body.receivedAt);
  });

  it('owned media pagination returns IDs and cursor', async () => {
    const harness = mediaHarness();
    const cookie = await connectSession(harness);
    const res = await request(harness.app).post('/api/instagram/media').set(CSRF_HEADERS).set('Cookie', cookie).send({}).expect(200);
    expect(res.body.ids).toEqual(['179111', '179112']);
    expect(res.body.after).toBe('AFTER1');
    expect(res.body.hasMore).toBe(true);
  });

  it('media fetch keeps IDs as strings; wrong-owner reported as notReturned', async () => {
    const harness = buildHarness({
      fetchImpl: jsonFetchFor((url) => {
        if (url.includes('refresh_access_token')) return { status: 200, body: REFRESH_OK };
        if (url.includes('graph.instagram.com/access_token')) return { status: 200, body: LONG_EXCHANGE };
        if (url.includes('oauth/access_token')) return { status: 200, body: SHORT_EXCHANGE };
        if (url.includes('/179111')) return { status: 200, body: { id: '179111', media_type: 'VIDEO' } };
        return { status: 400, body: { error: { message: 'Unsupported get request', type: 'GraphMethodException', code: 100 } } };
      }),
    });
    const cookie = await connectSession(harness);
    const res = await request(harness.app)
      .post('/api/instagram/media/fetch')
      .set(CSRF_HEADERS)
      .set('Cookie', cookie)
      .send({ ids: ['179111', '179999'] })
      .expect(200);
    expect(res.body.medias).toHaveLength(1);
    expect(typeof res.body.medias[0].id).toBe('string');
    expect(res.body.notReturned).toEqual(['179999']);
  });

  it('resolve finds Reel after first page via permalink walk', async () => {
    const harness = mediaHarness();
    const cookie = await connectSession(harness);
    const res = await request(harness.app)
      .post('/api/instagram/resolve')
      .set(CSRF_HEADERS)
      .set('Cookie', cookie)
      .send({ input: 'https://www.instagram.com/reel/ABC123/' })
      .expect(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.matched.id).toBe('179111');
    expect(res.body.pagesWalked).toBeGreaterThanOrEqual(1);
  });

  it('insights return full integers; missing metrics are null', async () => {
    const harness = mediaHarness();
    const cookie = await connectSession(harness);
    const res = await request(harness.app)
      .post('/api/instagram/insights')
      .set(CSRF_HEADERS)
      .set('Cookie', cookie)
      .send({ mediaId: '179111', metrics: ['views', 'reach', 'likes', 'comments', 'shares', 'saved', 'total_interactions', 'follows'] })
      .expect(200);
    expect(res.body.insights.views).toBe(123456);
    expect(res.body.insights.follows).toBeNull();
  });

  it('insights require manage_insights scope', async () => {
    const harness = buildHarness({
      fetchImpl: defaultFetch(),
      scopes: ['instagram_business_basic'],
    });
    // Manually craft a basic-only session: exchange returns basic-only permissions.
    const basicFetch = jsonFetchFor((url) => {
      if (url.includes('oauth/access_token')) {
        return { status: 200, body: { data: [{ access_token: 's', user_id: '1791', permissions: 'instagram_business_basic' }] } };
      }
      if (url.includes('graph.instagram.com/access_token')) return { status: 200, body: LONG_EXCHANGE };
      return null;
    });
    const h2 = buildHarness({ fetchImpl: basicFetch, scopes: ['instagram_business_basic'] });
    const cookie = await connectSession(h2);
    const res = await request(h2.app)
      .post('/api/instagram/insights')
      .set(CSRF_HEADERS)
      .set('Cookie', cookie)
      .send({ mediaId: '179111' })
      .expect(403);
    expect(res.body.error).toBe('scope_missing');
    void harness;
  });
});

describe('security', () => {
  it('unauthenticated routes return 401', async () => {
    const harness = buildHarness({ fetchImpl: defaultFetch() });
    await request(harness.app).post('/api/instagram/account').set(CSRF_HEADERS).send({}).expect(401);
    await request(harness.app).post('/api/instagram/media').set(CSRF_HEADERS).send({}).expect(401);
    await request(harness.app).post('/api/instagram/insights').set(CSRF_HEADERS).send({ mediaId: '1' }).expect(401);
    await request(harness.app).get('/api/observations').expect(401);
  });

  it('CSRF/origin block', async () => {
    const harness = buildHarness({ fetchImpl: defaultFetch() });
    const cookie = await connectSession(harness);
    await request(harness.app).post('/api/session/clear').set('Cookie', cookie).set('Origin', PUBLIC_ORIGIN).send({}).expect(403);
    await request(harness.app)
      .post('/api/session/clear')
      .set('Cookie', cookie)
      .set('Origin', 'https://evil.example')
      .set('X-Requested-With', 'instagram-sandbox-lab')
      .send({})
      .expect(403);
  });

  it('no secrets in status or observations', async () => {
    const harness = buildHarness({ fetchImpl: defaultFetch() });
    const cookie = await connectSession(harness);
    await request(harness.app).post('/api/instagram/account').set(CSRF_HEADERS).set('Cookie', cookie).send({});
    const status = await request(harness.app).get('/api/status').set('Cookie', cookie).expect(200);
    expect(JSON.stringify(status.body)).not.toContain('long.1');
    const obs = await request(harness.app).get('/api/observations').set('Cookie', cookie).expect(200);
    expect(JSON.stringify(obs.body)).not.toContain('long.1');
    expect(JSON.stringify(obs.body)).not.toContain('test-app-secret');
    // Sanitized URLs redact tokens.
    expect(JSON.stringify(obs.body)).not.toContain('access_token=long');
  });

  it('cross-session isolation', async () => {
    const harness = buildHarness({ fetchImpl: defaultFetch() });
    const cookieA = await connectSession(harness);
    await request(harness.app).post('/api/instagram/account').set(CSRF_HEADERS).set('Cookie', cookieA).send({});
    const startB = await request(harness.app).get('/auth/instagram/start').expect(302);
    const cookieB = startB.headers['set-cookie'][0].split(';')[0];
    await request(harness.app).get('/api/observations').set('Cookie', cookieB).expect(401);
  });
});

describe('comparison', () => {
  it('computes diff and rejects mismatch', async () => {
    const harness = buildHarness({ fetchImpl: defaultFetch() });
    const cookie = await connectSession(harness);
    const officialMedia = { id: '179111', like_count: 1200, comments_count: 50, insights: { views: 123456, shares: 30, saved: 25 } };
    const ok = await request(harness.app)
      .post('/api/compare')
      .set(CSRF_HEADERS)
      .set('Cookie', cookie)
      .send({
        officialMedia,
        officialObservedAt: '2026-09-28T10:00:00.000Z',
        baselineJson: JSON.stringify({ mediaId: '179111', views: 120000, likes: 1100, observedAt: '2026-09-28T09:00:00.000Z' }),
      })
      .expect(200);
    expect(ok.body.comparison.rows.find((r: { metric: string }) => r.metric === 'views').diff).toBe(3456);
    await request(harness.app)
      .post('/api/compare')
      .set(CSRF_HEADERS)
      .set('Cookie', cookie)
      .send({ officialMedia, baselineJson: JSON.stringify({ mediaId: 'other', views: 1 }) })
      .expect(400);
  });
});

describe('secret exclusion', () => {
  it('observation export never contains tokens', async () => {
    const harness = buildHarness({ fetchImpl: defaultFetch() });
    const cookie = await connectSession(harness);
    const fetchSpy = vi.fn();
    void fetchSpy;
    const obs = await request(harness.app).get('/api/observations').set('Cookie', cookie).expect(200);
    expect(JSON.stringify(obs.body)).not.toContain('short.1');
  });
});
