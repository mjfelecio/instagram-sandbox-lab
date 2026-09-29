/**
 * ngrok lifecycle manager for the lab's dedicated tunnel.
 *
 * Design rules (from the brief):
 * - Never kill, repoint, or modify unrelated tunnels; clean up only the child
 *   process this module spawned.
 * - Discover this app's public origin from the local agent API bound to OUR
 *   own apiPort, matching the tunnel by its local upstream port — never by
 *   "first tunnel returned".
 * - Reuse an explicitly available suitable endpoint when possible.
 * - Disable HTTP inspection with `--inspect=false` (verified ngrok 3.34 flag).
 * - Never overwrite global ngrok config; pass a scoped --config merged with
 *   the user's own config file so the authtoken is honored (ngrok skips the
 *   default config whenever --config is supplied).
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

export interface NgrokOptions {
  /** Local port this app listens on (loopback). */
  port: number;
  /** Optional reserved ngrok domain for a fixed URL. */
  domain?: string | null;
  /** Local agent API port to bind for THIS tunnel. Default: auto 4040-4049. */
  apiPort?: number | null;
  /** Where ngrok CLI lives. Default: ngrok on PATH. */
  bin?: string;
  now?: () => number;
}

export interface NgrokHandle {
  /** Public HTTPS origin, e.g. https://xxxx.ngrok-free.app */
  publicOrigin: string;
  apiPort: number;
  stop: () => Promise<void>;
}

interface AgentApiTunnel {
  name?: string;
  public_url?: string;
  proto?: string;
  config?: { addr?: string };
}

/** Find a free loopback TCP port in a range (best effort). */
async function findFreePort(start: number, end: number): Promise<number | null> {
  const net = await import('node:net');
  for (let port = start; port <= end; port += 1) {
    const free = await new Promise<boolean>((resolve) => {
      const server = net.createServer();
      server.once('error', () => resolve(false));
      server.once('listening', () => {
        server.close(() => resolve(true));
      });
      server.listen(port, '127.0.0.1');
    });
    if (free) return port;
  }
  return null;
}

/** Query a local ngrok agent API and return the http tunnel for `upstreamPort`. */
export async function queryTunnelForPort(
  apiPort: number,
  upstreamPort: number,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 4000,
): Promise<AgentApiTunnel | null> {
  try {
    const response = await fetchImpl(`http://127.0.0.1:${apiPort}/api/tunnels`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return null;
    const body = (await response.json()) as { tunnels?: AgentApiTunnel[] };
    const tunnels = Array.isArray(body.tunnels) ? body.tunnels : [];
    const suffix = `://127.0.0.1:${upstreamPort}`;
    const suffixAlt = `://localhost:${upstreamPort}`;
    return (
      tunnels.find((tunnel) => {
        const addr = tunnel.config?.addr ?? '';
        return addr.endsWith(suffix) || addr.endsWith(suffixAlt);
      }) ?? null
    );
  } catch {
    return null;
  }
}

function extractPublicOrigin(publicUrl: string | undefined): string | null {
  if (!publicUrl) return null;
  try {
    const url = new URL(publicUrl);
    if (url.protocol !== 'https:') return null;
    return url.origin;
  } catch {
    return null;
  }
}

function summarize(text: string): string {
  const line = text
    .split(/\r?\n/)
    .filter((l) => l.trim().length > 0)
    .pop();
  return (line ?? text).slice(0, 300);
}

/** Run a short ngrok subcommand and capture combined output. */
function runNgrokCapture(bin: string, args: string[], timeoutMs = 5000): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout?.on('data', (chunk) => (out += String(chunk)));
    child.stderr?.on('data', (chunk) => (out += String(chunk)));
    const timer = setTimeout(() => {
      if (child.pid && !child.killed) child.kill();
    }, timeoutMs);
    child.on('error', () => {
      clearTimeout(timer);
      resolve('');
    });
    child.on('close', () => {
      clearTimeout(timer);
      resolve(out.trim());
    });
  });
}

export interface NgrokStartResult {
  ok: boolean;
  handle?: NgrokHandle;
  error?: string;
  /** True when ngrok authentication/limits are the blocker. */
  authProblem?: boolean;
}

export async function startNgrok(opts: NgrokOptions): Promise<NgrokStartResult> {
  const bin = opts.bin ?? 'ngrok';
  const now = opts.now ?? Date.now;

  // 1. CLI present?
  const version = await runNgrokCapture(bin, ['version']);
  if (!version.includes('ngrok version')) {
    return {
      ok: false,
      error: 'ngrok CLI not found on PATH. Install it from https://ngrok.com/download.',
      authProblem: false,
    };
  }

  // 2. Authentication configured? (Uses ngrok's own check; never prints tokens.)
  //    Also discover the default config path from ngrok's own output — when
  //    --config is supplied, ngrok skips the default config entirely, so the
  //    user's own config (holding the authtoken) must join the merge list.
  const configCheck = await runNgrokCapture(bin, ['config', 'check']);
  if (!configCheck.includes('Valid configuration')) {
    return {
      ok: false,
      error:
        'ngrok authentication missing or config invalid. Run `ngrok config add-authtoken <token>` (token from the ngrok dashboard). Nothing was started.',
      authProblem: true,
    };
  }
  const pathMatch = /Valid configuration file at\s+(.+)/.exec(configCheck);
  const defaultConfigPath = pathMatch
    ? pathMatch[1].trim()
    : path.join(os.homedir(), '.config/ngrok/ngrok.yml');
  if (!existsSync(defaultConfigPath)) {
    return {
      ok: false,
      error: `ngrok default config not found at ${defaultConfigPath}. Run \`ngrok config add-authtoken <token>\` first. Nothing was started.`,
      authProblem: true,
    };
  }

  // 3. Dedicated agent API port for this tunnel.
  const apiPort = opts.apiPort ?? (await findFreePort(4040, 4049));
  if (apiPort === null) {
    return { ok: false, error: 'No free local port in 4040-4049 for the ngrok agent API.' };
  }

  // 4. Scoped config: only sets our agent API bind address under `agent:`
  //    (ngrok config v3). Merged with the user's own config file (authtoken) —
  //    ngrok reads the token itself; this module never touches its value.
  //    Never touches the global file.
  const scopedDir = mkdtempSync(path.join(os.tmpdir(), 'isl-ngrok-'));
  const scopedConfig = path.join(scopedDir, 'ngrok-scoped.yml');
  writeFileSync(scopedConfig, `version: "3"\nagent:\n  web_addr: 127.0.0.1:${apiPort}\n`);

  // 5. Spawn the dedicated tunnel (inspection disabled).
  const args = [
    'http',
    String(opts.port),
    '--inspect=false',
    '--log=stdout',
    '--log-format=term',
    `--config=${defaultConfigPath},${scopedConfig}`,
  ];
  if (opts.domain) args.push(`--url=https://${opts.domain}`);
  const child: ChildProcess = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  const stderrChunks: string[] = [];
  child.stderr?.on('data', (chunk) => {
    stderrChunks.push(String(chunk));
    if (stderrChunks.length > 50) stderrChunks.splice(0, stderrChunks.length - 20);
  });

  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    if (child.pid && !child.killed) {
      child.kill('SIGTERM');
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          if (child.pid && !child.killed) child.kill('SIGKILL');
          resolve();
        }, 3000);
        child.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    rmSync(scopedDir, { recursive: true, force: true });
  };

  // 6. Wait for tunnel establishment; discover HTTPS origin via OUR apiPort,
  //    matched by upstream port.
  const deadline = now() + 30_000;
  while (now() < deadline) {
    if (child.exitCode !== null) {
      const tail = stderrChunks.join('').slice(-800);
      await stop();
      return {
        ok: false,
        error: `ngrok exited during startup. ${tail || 'No stderr.'}`,
        authProblem: /authtoken|authentication|ERR_NGROK_10\d/.test(tail),
      };
    }
    const tunnel = await queryTunnelForPort(apiPort, opts.port);
    const origin = extractPublicOrigin(tunnel?.public_url);
    if (origin) {
      return { ok: true, handle: { publicOrigin: origin, apiPort, stop } };
    }
    const errTail = stderrChunks.join('').slice(-500);
    const codeMatch = /ERR_NGROK_\d+/.exec(errTail);
    if (codeMatch) {
      const code = codeMatch[0];
      const isAuthish = /ERR_NGROK_10\d/.test(code) || /authtoken|authentication|account/i.test(errTail);
      const isSessionLimit = /ERR_NGROK_32[07-9]/.test(code) || /session|endpoint limit/i.test(errTail);
      if (isAuthish || isSessionLimit) {
        await stop();
        return {
          ok: false,
          error: `ngrok refused the tunnel (${code}). ${summarize(errTail)}`,
          authProblem: isAuthish,
        };
      }
    }
    await sleep(400);
  }
  await stop();
  return { ok: false, error: 'ngrok tunnel did not come up within 30s.' };
}

export type { AgentApiTunnel };