/**
 * In-memory browser sessions, OAuth state tokens, and token storage.
 *
 * Instagram token model (Business Login):
 * - Short-lived Instagram User token: 1 hour.
 * - Long-lived Instagram User token: 60 days, obtained via ig_exchange_token.
 * - Refresh: GET /refresh_access_token extends a long-lived token another 60
 *   days (allowed only when >=24h old, still valid, has basic permission).
 * - No separate refresh_token string: the access token value itself rotates.
 *   Concurrent extend clicks piggyback on one in-flight request; on ambiguous
 *   transient failure the previous token is preserved.
 */

import { randomBytes, timingSafeEqual } from 'node:crypto';

export interface TokenSet {
  accessToken: string;
  /** Stable Instagram professional account ID (user_id, numeric string). */
  userId: string;
  /** Granted permissions string as returned by provider (comma-separated). */
  scope: string;
  tokenType: string;
  /** Absolute expiry (epoch ms). */
  expiresAt: number;
  /** When we obtained this token set. */
  obtainedAt: number;
  /** True when this is a long-lived (60d) token. */
  isLongLived: boolean;
}

export interface OAuthFailure {
  category: string;
  detail: string;
  at: number;
}

export interface SessionRecord {
  key: string;
  createdAt: number;
  tokens: TokenSet | null;
  pendingState: PendingOAuthState | null;
  lastConsumedState: { state: string; consumedAt: number } | null;
  authFailure: OAuthFailure | null;
  refreshFailure: OAuthFailure | null;
  refreshInFlight: Promise<RefreshResult> | null;
  accountInfo: { data: unknown; fields: string[]; observedAt: number } | null;
}

export interface PendingOAuthState {
  state: string;
  createdAt: number;
  expiresAt: number;
  redirectUri: string;
}

export type RefreshResult =
  | { ok: true; tokens: TokenSet; rotated: boolean }
  | { ok: false; category: string; detail: string };

export type StateConsumeResult =
  | { ok: true; redirectUri: string }
  | { ok: false; reason: 'missing' | 'mismatched' | 'expired' | 'replayed' | 'ambiguous' };

export const DEFAULT_STATE_TTL_MS = 10 * 60 * 1000;

function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('hex');
}

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export interface SessionStoreOptions {
  now?: () => number;
  stateTtlMs?: number;
}

export class SessionStore {
  private sessions = new Map<string, SessionRecord>();
  private states = new Map<string, PendingOAuthState>();
  private readonly now: () => number;
  private readonly stateTtlMs: number;

  constructor(opts: SessionStoreOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.stateTtlMs = opts.stateTtlMs ?? DEFAULT_STATE_TTL_MS;
  }

  createSession(): SessionRecord {
    const record: SessionRecord = {
      key: randomToken(),
      createdAt: this.now(),
      tokens: null,
      pendingState: null,
      lastConsumedState: null,
      authFailure: null,
      refreshFailure: null,
      refreshInFlight: null,
      accountInfo: null,
    };
    this.sessions.set(record.key, record);
    return record;
  }

  getSession(key: string | undefined | null): SessionRecord | null {
    if (!key) return null;
    return this.sessions.get(key) ?? null;
  }

  destroySession(key: string): void {
    const record = this.sessions.get(key);
    if (record?.pendingState) this.states.delete(record.pendingState.state);
    this.sessions.delete(key);
  }

  issueOAuthState(sessionKey: string, redirectUri: string): string {
    const record = this.sessions.get(sessionKey);
    if (!record) throw new Error('unknown session');
    if (record.pendingState) this.states.delete(record.pendingState.state);
    const state = randomToken(24);
    const pending: PendingOAuthState = {
      state,
      createdAt: this.now(),
      expiresAt: this.now() + this.stateTtlMs,
      redirectUri,
    };
    record.pendingState = pending;
    this.states.set(state, pending);
    return state;
  }

  consumeOAuthState(sessionKey: string | undefined | null, state: unknown): StateConsumeResult {
    if (!sessionKey || typeof state !== 'string' || state.length === 0) {
      return { ok: false, reason: 'missing' };
    }
    const record = this.sessions.get(sessionKey);
    if (!record) return { ok: false, reason: 'mismatched' };
    const pending = this.states.get(state);
    if (!pending) {
      if (
        (record.pendingState && safeEqual(record.pendingState.state, state)) ||
        (record.lastConsumedState && safeEqual(record.lastConsumedState.state, state))
      ) {
        return { ok: false, reason: 'replayed' };
      }
      return { ok: false, reason: 'mismatched' };
    }
    if (!record.pendingState || !safeEqual(record.pendingState.state, state)) {
      return { ok: false, reason: 'mismatched' };
    }
    if (this.now() >= pending.expiresAt) {
      this.states.delete(state);
      record.pendingState = null;
      return { ok: false, reason: 'expired' };
    }
    this.states.delete(state);
    record.pendingState = null;
    record.lastConsumedState = { state, consumedAt: this.now() };
    return { ok: true, redirectUri: pending.redirectUri };
  }

  invalidatePendingStates(): number {
    let count = 0;
    for (const record of this.sessions.values()) {
      if (record.pendingState) {
        this.states.delete(record.pendingState.state);
        record.pendingState = null;
        count += 1;
      }
    }
    this.states.clear();
    return count;
  }

  storeTokens(sessionKey: string, tokens: TokenSet): void {
    const record = this.sessions.get(sessionKey);
    if (!record) throw new Error('unknown session');
    record.tokens = tokens;
    record.authFailure = null;
  }

  recordAuthFailure(sessionKey: string, category: string, detail: string): void {
    const record = this.sessions.get(sessionKey);
    if (!record) return;
    record.authFailure = { category, detail: detail.slice(0, 300), at: this.now() };
  }

  getAuthFailure(sessionKey: string): OAuthFailure | null {
    return this.sessions.get(sessionKey)?.authFailure ?? null;
  }

  recordRefreshFailure(sessionKey: string, category: string, detail: string): void {
    const record = this.sessions.get(sessionKey);
    if (!record) return;
    record.refreshFailure = { category, detail: detail.slice(0, 300), at: this.now() };
  }

  getRefreshFailure(sessionKey: string): OAuthFailure | null {
    return this.sessions.get(sessionKey)?.refreshFailure ?? null;
  }

  clearRefreshInFlight(sessionKey: string): void {
    const record = this.sessions.get(sessionKey);
    if (record) record.refreshInFlight = null;
  }
}
