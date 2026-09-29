/**
 * Configuration assembly and validation for the Instagram lab.
 * Validation messages never include credential values — only whether set.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyEnv, loadEnvFromDir } from './env.js';
import { parseScopes } from '../shared/scopes.js';

export const EXPERIMENT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const CLIENT_ROOT = path.join(EXPERIMENT_ROOT, 'client');
export const DIST_CLIENT_ROOT = path.join(EXPERIMENT_ROOT, 'dist', 'client');
export const CALLBACK_PATH = '/auth/instagram/callback';
export const DEFAULT_PORT = 5180;
export const DEFAULT_API_VERSION = 'v25.0';

export interface AppConfig {
  port: number;
  publicOrigin: string | null;
  ngrok: { domain: string | null; apiPort: number | null };
  instagram: {
    appId: string | null;
    appSecret: string | null;
    scopes: string[];
    unknownScopes: string[];
    apiVersion: string;
  };
  devMode: boolean;
}

export interface ConfigIssue {
  level: 'error' | 'warn';
  message: string;
}

export function isHttpOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === 'https:' || url.protocol === 'http:') && url.pathname === '/' && !url.search && !url.hash;
  } catch {
    return false;
  }
}

export function isValidHostname(value: string): boolean {
  return /^[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?$/.test(value) && value.length <= 253;
}

export function isValidApiVersion(value: string): boolean {
  return /^v\d+\.\d+$/.test(value);
}

function intFromEnv(name: string): number | null {
  const raw = process.env[name];
  if (!raw) return null;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

export function buildConfig(): { config: AppConfig; issues: ConfigIssue[] } {
  applyEnv(loadEnvFromDir(EXPERIMENT_ROOT));
  const issues: ConfigIssue[] = [];
  const devMode = process.env.NODE_ENV !== 'production';

  let port = intFromEnv('PORT') ?? DEFAULT_PORT;
  if (port < 1024 || port > 65535) {
    issues.push({ level: 'error', message: `PORT ${port} is outside 1024-65535.` });
    port = DEFAULT_PORT;
  }

  let publicOrigin: string | null = null;
  const rawOrigin = process.env.INSTAGRAM_PUBLIC_ORIGIN;
  if (rawOrigin) {
    if (isHttpOrigin(rawOrigin)) {
      publicOrigin = new URL(rawOrigin).origin;
    } else {
      issues.push({
        level: 'error',
        message: 'INSTAGRAM_PUBLIC_ORIGIN must be an absolute origin like https://example.ngrok.app (no path).',
      });
    }
  }

  let ngrokDomain: string | null = null;
  const rawDomain = process.env.NGROK_DOMAIN;
  if (rawDomain) {
    if (isValidHostname(rawDomain)) ngrokDomain = rawDomain;
    else issues.push({ level: 'error', message: 'NGROK_DOMAIN must be a plain hostname.' });
  }
  const ngrokApiPort = intFromEnv('NGROK_API_PORT');

  const appId = process.env.INSTAGRAM_APP_ID?.trim() || null;
  const appSecret = process.env.INSTAGRAM_APP_SECRET?.trim() || null;
  if (!appId || !appSecret) {
    issues.push({
      level: 'warn',
      message: 'Instagram App ID/Secret missing. Fill .env.local (ignored) before connecting.',
    });
  }
  const { scopes, unknown } = parseScopes(process.env.INSTAGRAM_SCOPES);
  if (unknown.length > 0) {
    issues.push({ level: 'warn', message: `Unknown scope token(s) ignored: ${unknown.join(', ')}.` });
  }

  let apiVersion = (process.env.INSTAGRAM_API_VERSION ?? '').trim() || DEFAULT_API_VERSION;
  if (!isValidApiVersion(apiVersion)) {
    issues.push({ level: 'error', message: `INSTAGRAM_API_VERSION must look like v25.0 (got ${apiVersion}).` });
    apiVersion = DEFAULT_API_VERSION;
  }

  return {
    config: {
      port,
      publicOrigin,
      ngrok: { domain: ngrokDomain, apiPort: ngrokApiPort },
      instagram: { appId, appSecret, scopes, unknownScopes: unknown, apiVersion },
      devMode,
    },
    issues,
  };
}

export function redirectUriForOrigin(publicOrigin: string): string {
  return `${publicOrigin}${CALLBACK_PATH}`;
}

export function localOrigin(port: number): string {
  return `http://localhost:${port}`;
}
