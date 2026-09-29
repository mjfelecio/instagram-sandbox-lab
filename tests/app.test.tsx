// @vitest-environment jsdom
/**
 * Client render smoke test: App mounts, renders header, shows not-connected
 * status. Verifies no secret material is rendered.
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import App from '../client/src/App';
import * as apiModule from '../client/src/api';

vi.mock('../client/src/api', () => ({
  api: {
    status: vi.fn(async () => ({
      connected: false,
      publicOrigin: 'https://lab.ngrok.test',
      callbackUrl: 'https://lab.ngrok.test/auth/instagram/callback',
      configuredScopes: ['instagram_business_basic', 'instagram_business_manage_insights'],
      grantedScopes: [],
      accessTokenExpiresAt: null,
      isLongLived: null,
      providerUserId: null,
      apiVersion: 'v25.0',
      authFailure: null,
      refreshFailure: null,
      credentialsConfigured: true,
    })),
    clearSession: vi.fn(),
    account: vi.fn(),
    mediaList: vi.fn(),
    mediaFetch: vi.fn(),
    probe: vi.fn(),
    resolve: vi.fn(),
    insights: vi.fn(),
    refresh: vi.fn(),
    compare: vi.fn(),
    observations: vi.fn(),
  },
}));

describe('App (client)', () => {
  it('renders the header and status without exposing secrets', async () => {
    render(<App />);
    expect(screen.getByText('Instagram Sandbox Lab')).toBeTruthy();
    expect(screen.getByText('Temporary research tool')).toBeTruthy();
    await waitFor(() => {
      expect(screen.getByText(/Connection: not connected/)).toBeTruthy();
    });
    const connect = screen.getByText('Connect Instagram') as HTMLButtonElement;
    expect(connect.disabled).toBe(false);
    expect(screen.getByText('Tab A: Account')).toBeTruthy();
    expect(screen.getByText('Tab B: Owned media')).toBeTruthy();
    expect(document.body.textContent).not.toContain('EAAC');
    expect(document.body.textContent).not.toContain('access_token');
    void apiModule;
  });
});
