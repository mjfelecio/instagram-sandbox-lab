import { describe, expect, it } from 'vitest';
import { SessionStore } from '../src/server/session';

function makeStore(ttlMs = 10 * 60 * 1000, now: () => number = Date.now) {
  return new SessionStore({ now, stateTtlMs: ttlMs });
}

describe('OAuth state lifecycle', () => {
  it('issues and consumes state bound to the issuing session', () => {
    const store = makeStore();
    const session = store.createSession();
    const state = store.issueOAuthState(session.key, 'https://lab.example/auth/instagram/callback');
    expect(store.consumeOAuthState(session.key, state)).toEqual({
      ok: true,
      redirectUri: 'https://lab.example/auth/instagram/callback',
    });
  });

  it('rejects missing state', () => {
    const store = makeStore();
    const session = store.createSession();
    expect(store.consumeOAuthState(session.key, null).ok).toBe(false);
    expect(store.consumeOAuthState(session.key, '').ok).toBe(false);
  });

  it('rejects foreign state', () => {
    const store = makeStore();
    const a = store.createSession();
    const b = store.createSession();
    const stateA = store.issueOAuthState(a.key, 'https://lab.example/cb');
    expect(store.consumeOAuthState(b.key, stateA).ok).toBe(false);
  });

  it('rejects replayed state', () => {
    const store = makeStore();
    const session = store.createSession();
    const state = store.issueOAuthState(session.key, 'https://lab.example/cb');
    expect(store.consumeOAuthState(session.key, state).ok).toBe(true);
    const replay = store.consumeOAuthState(session.key, state);
    expect(replay.ok).toBe(false);
    if (!replay.ok) expect(replay.reason).toBe('replayed');
  });

  it('rejects expired state', () => {
    let t = 1_000_000;
    const store = makeStore(60_000, () => t);
    const session = store.createSession();
    const state = store.issueOAuthState(session.key, 'https://lab.example/cb');
    t += 61_000;
    const result = store.consumeOAuthState(session.key, state);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('expired');
  });

  it('new state invalidates old pending state', () => {
    const store = makeStore();
    const session = store.createSession();
    const first = store.issueOAuthState(session.key, 'https://lab.example/cb');
    store.issueOAuthState(session.key, 'https://lab.example/cb');
    expect(store.consumeOAuthState(session.key, first).ok).toBe(false);
  });

  it('invalidatePendingStates clears everything', () => {
    const store = makeStore();
    const session = store.createSession();
    const state = store.issueOAuthState(session.key, 'https://lab.example/cb');
    expect(store.invalidatePendingStates()).toBe(1);
    expect(store.consumeOAuthState(session.key, state).ok).toBe(false);
  });
});

describe('session isolation', () => {
  it('destroying a session drops tokens', () => {
    const store = makeStore();
    const session = store.createSession();
    store.storeTokens(session.key, {
      accessToken: 'at',
      userId: '1791',
      scope: 'instagram_business_basic',
      tokenType: 'bearer',
      expiresAt: Date.now() + 1000,
      obtainedAt: Date.now(),
      isLongLived: true,
    });
    expect(store.getSession(session.key)?.tokens?.accessToken).toBe('at');
    store.destroySession(session.key);
    expect(store.getSession(session.key)).toBeNull();
  });

  it('session keys are unique and unguessable', () => {
    const store = makeStore();
    const a = store.createSession();
    const b = store.createSession();
    expect(a.key).not.toEqual(b.key);
    expect(a.key).toMatch(/^[0-9a-f]{64}$/);
  });
});
