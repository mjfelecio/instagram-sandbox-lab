#!/usr/bin/env node
/**
 * `npm run dev` for the Instagram Sandbox Lab.
 *
 * Responsibilities:
 * - Validate configuration without printing credential values.
 * - Start the app server (which owns the dedicated ngrok tunnel in-process so
 *   the discovered origin configures OAuth, cookies, and Vite allowedHosts).
 * - Forward signals; the server cleans up only its own child processes.
 */

import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function loadLocalEnv() {
  for (const name of ['.env', '.env.local']) {
    const file = path.join(ROOT, name);
    if (!existsSync(file)) continue;
    for (const rawLine of readFileSync(file, 'utf8').split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq <= 0) continue;
      const key = line.slice(0, eq).trim();
      let value = line.slice(eq + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
        (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
      ) {
        value = value.slice(1, -1);
      }
      if (key && process.env[key] === undefined && value !== '') process.env[key] = value;
    }
  }
}
loadLocalEnv();

const PORT = Number.parseInt(process.env.PORT ?? '5180', 10) || 5180;

const children = [];

function info(message) {
  console.log(`[lab] ${message}`);
}
function fail(message) {
  console.error(`[lab] ERROR: ${message}`);
}

function portIsFree(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen(port, host);
  });
}

function validateConfig() {
  const problems = [];
  const appId = (process.env.INSTAGRAM_APP_ID || '').trim();
  const secret = (process.env.INSTAGRAM_APP_SECRET || '').trim();
  if (!appId) problems.push('INSTAGRAM_APP_ID is not set (fill .env.local).');
  if (!secret) problems.push('INSTAGRAM_APP_SECRET is not set (fill .env.local).');
  const scopes = (process.env.INSTAGRAM_SCOPES || 'instagram_business_basic,instagram_business_manage_insights')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (PUBLIC_ORIGIN_SET() && !/^https?:\/\/[^\s/]+$/.test(process.env.INSTAGRAM_PUBLIC_ORIGIN)) {
    problems.push('INSTAGRAM_PUBLIC_ORIGIN must be an absolute origin like https://xyz.ngrok-app (no path).');
  }
  const apiVersion = (process.env.INSTAGRAM_API_VERSION || 'v25.0').trim();
  if (!/^v\d+\.\d+$/.test(apiVersion)) problems.push(`INSTAGRAM_API_VERSION must look like v25.0 (got ${apiVersion}).`);
  return { problems, scopes, apiVersion };
}

function PUBLIC_ORIGIN_SET() {
  return Boolean((process.env.INSTAGRAM_PUBLIC_ORIGIN || '').trim());
}

async function main() {
  const { problems, scopes, apiVersion } = validateConfig();
  info(`Port ${PORT} (loopback). Scopes: ${scopes.join(', ') || '(none)'}. API ${apiVersion}.`);
  for (const problem of problems) warn(problem);
  if (problems.some((p) => p.includes('is not set'))) {
    info('You can still start the app to explore the UI; connecting requires credentials.');
  }

  if (!(await portIsFree(PORT))) {
    fail(`Port ${PORT} is already in use. Free it or set PORT in .env.local.`);
    process.exit(1);
  }

  const serverProcess = spawn(process.execPath, ['--import', 'tsx', 'src/server/index.ts'], {
    cwd: ROOT,
    env: { ...process.env, NODE_ENV: 'development', INSTAGRAM_LAB_WITH_NGROK: '1' },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  children.push(serverProcess);

  const upDeadline = Date.now() + 45_000;
  let serverUp = false;
  while (Date.now() < upDeadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/healthz`, { signal: AbortSignal.timeout(1500) });
      if (res.ok) {
        serverUp = true;
        break;
      }
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  if (serverUp) {
    info(`App server ready on http://localhost:${PORT}`);
  } else {
    fail('App server did not become healthy on the loopback port. Check output above.');
  }

  const shutdown = (code) => {
    for (const child of children) {
      if (child.pid && !child.killed) {
        child.kill('SIGTERM');
        setTimeout(() => {
          if (child.pid && !child.killed) child.kill('SIGKILL');
        }, 3000).unref();
      }
    }
    process.exit(code);
  };

  process.on('SIGINT', () => shutdown(0));
  process.on('SIGTERM', () => shutdown(0));
  serverProcess.on('exit', (code) => {
    info(`App server exited (${code}). Shutting down.`);
    shutdown(code ?? 0);
  });
}

function warn(message) {
  console.warn(`[lab] WARN: ${message}`);
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
