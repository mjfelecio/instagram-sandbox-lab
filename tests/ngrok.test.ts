import { describe, expect, it } from 'vitest';
import {
  queryTunnelForPort,
  type AgentApiTunnel,
} from '../src/server/ngrok';

function fetchFromTunnels(tunnels: AgentApiTunnel[], status = 200) {
  return (async (url: string | URL) => {
    void url;
    return new Response(JSON.stringify({ tunnels }), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
}

describe('queryTunnelForPort', () => {
  const ourTunnel: AgentApiTunnel = {
    name: 'isl-dedicated',
    public_url: 'https://abc123.ngrok-free.app',
    proto: 'https',
    config: { addr: 'http://127.0.0.1:5180' },
  };
  const otherTunnel: AgentApiTunnel = {
    name: 'whop-webhook',
    public_url: 'https://other.ngrok-free.app',
    proto: 'https',
    config: { addr: 'http://127.0.0.1:3000' },
  };

  it('matches OUR tunnel by upstream port, not by order', async () => {
    const fetchImpl = fetchFromTunnels([otherTunnel, ourTunnel]);
    const match = await queryTunnelForPort(4040, 5180, fetchImpl);
    expect(match?.public_url).toBe('https://abc123.ngrok-free.app');
  });

  it('returns null when no tunnel upstreams our port', async () => {
    const fetchImpl = fetchFromTunnels([otherTunnel]);
    expect(await queryTunnelForPort(4040, 5180, fetchImpl)).toBeNull();
  });

  it('also matches localhost-form upstream addresses', async () => {
    const fetchImpl = fetchFromTunnels([
      { name: 'x', public_url: 'https://x.ngrok-free.app', config: { addr: 'http://localhost:5180' } },
    ]);
    const match = await queryTunnelForPort(4040, 5180, fetchImpl);
    expect(match?.public_url).toBe('https://x.ngrok-free.app');
  });

  it('returns null on agent API failure', async () => {
    const fetchImpl = fetchFromTunnels([], 500);
    expect(await queryTunnelForPort(4040, 5180, fetchImpl)).toBeNull();
  });
});