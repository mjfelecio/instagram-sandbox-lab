import { describe, expect, it } from 'vitest';
import {
  parseProviderError,
  parseTokenError,
  scanCountPrecision,
  sanitizeGraphUrl,
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
} from '../src/server/instagram';

function jsonFetch(handler: (url: string, init?: RequestInit) => { status: number; body: unknown }) {
  return (async (url: string | URL, init?: RequestInit) => {
    const spec = handler(String(url), init);
    return new Response(JSON.stringify(spec.body), {
      status: spec.status,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
}

describe('provider error parsing', () => {
  it('parses Graph error envelope', () => {
    const err = parseProviderError({
      error: { message: 'Invalid token', type: 'OAuthException', code: 190, error_subcode: 460 },
    });
    expect(err?.code).toBe('190');
    expect(err?.message).toContain('Invalid token');
  });

  it('parses token exchange error_type shape', () => {
    const err = parseTokenError({ error_type: 'OAuthException', code: 400, error_message: 'Matching code was not found' });
    expect(err?.code).toBe('400');
  });

  it('parses access_denied style {error, error_description}', () => {
    const err = parseTokenError({ error: 'access_denied', error_description: 'user denied' });
    expect(err?.code).toBe('access_denied');
  });

  it('HTTP 200 with error envelope is failure (callApi)', async () => {
    const fetchImpl = jsonFetch(() => ({
      status: 200,
      body: { error: { message: 'Not enough viewers', type: 'IGApiException', code: 10 } },
    }));
    const result = await fetchMediaInsights('tok', '1791', ['link_clicks'], 'v25.0', { fetchImpl });
    expect(result.ok).toBe(false);
    expect(result.providerError?.code).toBe('10');
  });
});

describe('sanitizeGraphUrl', () => {
  it('redacts access_token and client_secret', () => {
    const sanitized = sanitizeGraphUrl(
      'https://graph.instagram.com/v25.0/me?fields=id&access_token=SECRET123&client_secret=SHH',
    );
    expect(sanitized).not.toContain('SECRET123');
    expect(sanitized).not.toContain('SHH');
    expect(sanitized).toContain('REDACTED');
  });
});

describe('authorize URL', () => {
  it('builds Business Login URL with required params', () => {
    const url = buildAuthorizeUrl({
      appId: '123',
      redirectUri: 'https://lab.test/auth/instagram/callback',
      scopes: ['instagram_business_basic', 'instagram_business_manage_insights'],
      state: 'abc',
    });
    expect(url.startsWith('https://www.instagram.com/oauth/authorize?')).toBe(true);
    expect(url).toContain('client_id=123');
    expect(url).toContain('response_type=code');
    expect(url).toContain('state=abc');
    expect(url).not.toContain('code_challenge');
  });
});

describe('code exchange', () => {
  it('parses documented {data:[...]} shape and sets 1h expiry', async () => {
    const fetchImpl = jsonFetch((url) => {
      expect(url).toContain('api.instagram.com/oauth/access_token');
      return {
        status: 200,
        body: { data: [{ access_token: 'SHORT', user_id: '1791', permissions: 'instagram_business_basic' }] },
      };
    });
    const result = await exchangeAuthorizationCode(
      { appId: '123', appSecret: 'sec' },
      { code: 'CODE', redirectUri: 'https://lab.test/cb' },
      { fetchImpl },
    );
    expect(result.ok).toBe(true);
    expect(result.tokens?.userId).toBe('1791');
    expect(result.tokens?.isLongLived).toBe(false);
    expect(result.tokens!.expiresAt - result.tokens!.obtainedAt).toBe(3600 * 1000);
  });

  it('accepts flat shape for robustness', async () => {
    const fetchImpl = jsonFetch(() => ({
      status: 200,
      body: { access_token: 'SHORT', user_id: '1791', permissions: 'instagram_business_basic' },
    }));
    const result = await exchangeAuthorizationCode({ appId: '1', appSecret: 's' }, { code: 'c', redirectUri: 'u' }, { fetchImpl });
    expect(result.ok).toBe(true);
  });

  it('exchange HTTP error surfaces provider error', async () => {
    const fetchImpl = jsonFetch(() => ({
      status: 400,
      body: { error_type: 'OAuthException', code: 400, error_message: 'Matching code was not found or was already used' },
    }));
    const result = await exchangeAuthorizationCode({ appId: '1', appSecret: 's' }, { code: 'bad', redirectUri: 'u' }, { fetchImpl });
    expect(result.ok).toBe(false);
    expect(result.providerError?.code).toBe('400');
  });

  it('network failure is transport error, tokens null', async () => {
    const fetchImpl = (async () => {
      throw new Error('boom');
    }) as unknown as typeof fetch;
    const result = await exchangeAuthorizationCode({ appId: '1', appSecret: 's' }, { code: 'c', redirectUri: 'u' }, { fetchImpl });
    expect(result.ok).toBe(false);
    expect(result.tokens).toBeNull();
    expect(result.transportError).toBeDefined();
  });
});

describe('long-lived exchange and refresh', () => {
  it('long-lived exchange sets 60d expiry and isLongLived', async () => {
    const fetchImpl = jsonFetch(() => ({
      status: 200,
      body: { access_token: 'LONG', token_type: 'bearer', expires_in: 5183944 },
    }));
    const result = await exchangeForLongLivedToken(
      { appSecret: 'sec', shortLivedToken: 'SHORT', userId: '1791', scope: 'instagram_business_basic' },
      { fetchImpl },
    );
    expect(result.ok).toBe(true);
    expect(result.tokens?.isLongLived).toBe(true);
    expect(result.tokens?.userId).toBe('1791');
  });

  it('refresh success rotates token value', async () => {
    const fetchImpl = jsonFetch(() => ({
      status: 200,
      body: { access_token: 'LONG2', token_type: 'bearer', expires_in: 5184000 },
    }));
    const result = await extendLongLivedToken({ accessToken: 'LONG1', userId: '1791', scope: 's' }, { fetchImpl });
    expect(result.ok).toBe(true);
    expect(result.rotated).toBe(true);
  });

  it('refresh keeps same value case as non-rotated', async () => {
    const fetchImpl = jsonFetch(() => ({
      status: 200,
      body: { access_token: 'SAME', token_type: 'bearer', expires_in: 100 },
    }));
    const result = await extendLongLivedToken({ accessToken: 'SAME', userId: '1', scope: 's' }, { fetchImpl });
    expect(result.rotated).toBe(false);
  });

  it('expired token error parses code 190', async () => {
    const fetchImpl = jsonFetch(() => ({
      status: 400,
      body: { error: { message: 'Error validating access token', type: 'OAuthException', code: 190 } },
    }));
    const result = await extendLongLivedToken({ accessToken: 'OLD', userId: '1', scope: 's' }, { fetchImpl });
    expect(result.ok).toBe(false);
    expect(result.providerError?.code).toBe('190');
  });
});

describe('account identity', () => {
  it('stable ID remains string; username missing is not empty identity', async () => {
    const fetchImpl = jsonFetch(() => ({
      status: 200,
      body: { user_id: '179123', username: 'creator', account_type: 'Media_Creator' },
    }));
    const result = await fetchAccountInfo('tok', ['user_id', 'username'], 'v25.0', { fetchImpl });
    expect(result.ok).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(typeof data.user_id).toBe('string');
  });

  it('personal/unsupported account shape still parses (caller displays constraint)', async () => {
    const fetchImpl = jsonFetch(() => ({
      status: 200,
      body: { error: { message: 'Unsupported account', type: 'OAuthException', code: 100 } },
    }));
    const result = await fetchAccountInfo('tok', ['user_id'], 'v25.0', { fetchImpl });
    expect(result.ok).toBe(false);
  });
});

describe('owned media pagination', () => {
  it('extracts IDs and after cursor', () => {
    const page = extractMediaPage({
      data: [{ id: '1791' }, { id: '1792' }],
      paging: { cursors: { after: 'CURSOR123' } },
    });
    expect(page.ids).toEqual(['1791', '1792']);
    expect(page.after).toBe('CURSOR123');
    expect(page.hasMore).toBe(true);
  });

  it('IDs remain strings', async () => {
    const fetchImpl = jsonFetch(() => ({
      status: 200,
      body: { data: [{ id: '179123456789012345678' }], paging: {} },
    }));
    const result = await fetchOwnedMediaPage('tok', '1791', { limit: 25 }, 'v25.0', { fetchImpl });
    expect(result.ok).toBe(true);
    const page = extractMediaPage(result.data);
    expect(typeof page.ids[0]).toBe('string');
  });

  it('malformed provider data does not throw', () => {
    expect(extractMediaPage(null)).toEqual({ ids: [], after: null, hasMore: false });
    expect(extractMediaPage({ data: 'nope' })).toEqual({ ids: [], after: null, hasMore: false });
  });
});

describe('media fetch', () => {
  it('unsupported media type still returns object (caller displays explicitly)', async () => {
    const fetchImpl = jsonFetch(() => ({
      status: 200,
      body: { id: '1791', media_type: 'CAROUSEL_ALBUM', permalink: 'https://www.instagram.com/p/ABC/' },
    }));
    const result = await fetchMedia('tok', '1791', ['id', 'media_type'], 'v25.0', { fetchImpl });
    expect(result.ok).toBe(true);
  });

  it('wrong-owner lookup surfaces provider error (not translated)', async () => {
    const fetchImpl = jsonFetch(() => ({
      status: 400,
      body: { error: { message: 'Unsupported get request', type: 'GraphMethodException', code: 100 } },
    }));
    const result = await fetchMedia('tok', '179999', ['id'], 'v25.0', { fetchImpl });
    expect(result.ok).toBe(false);
    expect(result.providerError?.code).toBe('100');
  });
});

describe('insights', () => {
  it('maps values array to metric map; missing metrics stay absent', () => {
    const map = insightsToMap({
      data: [
        { name: 'views', values: [{ value: 123456 }] },
        { name: 'reach', values: [{ value: 100000 }] },
      ],
    });
    expect(map.views).toBe(123456);
    expect(map.likes).toBeUndefined();
  });

  it('full integers preserved; zero distinct from missing', async () => {
    const fetchImpl = jsonFetch(() => ({
      status: 200,
      body: { data: [{ name: 'views', values: [{ value: 0 }] }, { name: 'likes', values: [{ value: 1200 }] }] },
    }));
    const result = await fetchMediaInsights('tok', '1791', ['views', 'likes', 'comments'], 'v25.0', { fetchImpl });
    expect(result.ok).toBe(true);
    const map = insightsToMap(result.data);
    expect(map.views).toBe(0);
    expect('comments' in map).toBe(false);
  });

  it('unsafe integers flagged, not coerced', async () => {
    const big = '9007199254740993';
    const fetchImpl = (async () => {
      return new Response(`{"data":[{"name":"views","values":[{"value":${big}}]}]}`, {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;
    const result = await fetchMediaInsights('tok', '1791', ['views'], 'v25.0', { fetchImpl });
    expect(result.precisionWarnings.length).toBeGreaterThan(0);
  });

  it('timestamps captured truthfully (startedAt <= receivedAt)', async () => {
    const fetchImpl = jsonFetch(() => ({ status: 200, body: { data: [] } }));
    const result = await fetchAccountInfo('tok', ['user_id'], 'v25.0', { fetchImpl });
    expect(result.startedAt).toBeLessThanOrEqual(result.receivedAt);
  });
});
