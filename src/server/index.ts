/**
 * Instagram Sandbox Lab server entrypoint.
 *
 * One Node process hosts the Express API and (in dev) Vite middleware for the
 * React UI. Binds loopback only; the only public exposure is the dedicated
 * ngrok tunnel this process owns when started by `npm run dev` (which sets
 * INSTAGRAM_LAB_WITH_NGROK=1). Owning the tunnel in-process means the discovered
 * public origin is known here: OAuth, cookie flags, and Vite's allowedHosts
 * are all configured from it.
 */

import { createServer, request as httpRequest } from 'node:http';
import path from 'node:path';
import express from 'express';
import cookieParser from 'cookie-parser';

import { buildConfig, DIST_CLIENT_ROOT, CLIENT_ROOT } from './config.js';
import { SessionStore } from './session.js';
import { ObservationStore } from './observations.js';
import { registerRoutes } from './routes.js';
import { startNgrok, type NgrokHandle } from './ngrok.js';
import type { ViteDevServer } from 'vite';

export interface LabServerOptions {
  withNgrok?: boolean;
  fetchImpl?: typeof fetch;
  log?: (line: string) => void;
}

export interface LabServer {
  app: import('express').Express;
  store: SessionStore;
  observations: ObservationStore;
  port: number;
  getPublicOrigin: () => string | null;
  ngrokHandle: NgrokHandle | null;
  close: () => Promise<void>;
}

export async function startLabServer(opts: LabServerOptions = {}): Promise<LabServer> {
  const log = opts.log ?? ((line: string) => console.log(line));
  const { config } = buildConfig();

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '256kb' }));
  app.use(cookieParser());

  const store = new SessionStore();
  const observations = new ObservationStore();

  let ngrokHandle: NgrokHandle | null = null;
  let publicOrigin: string | null = config.publicOrigin;
  const getPublicOrigin = () => publicOrigin;

  registerRoutes(app, {
    store,
    observations,
    getPublicOrigin,
    fetchImpl: opts.fetchImpl,
    appId: config.instagram.appId,
    appSecret: config.instagram.appSecret,
    scopes: config.instagram.scopes,
    apiVersion: config.instagram.apiVersion,
    port: config.port,
  });

  app.get('/healthz', (req, res) => {
    void req;
    res.json({ ok: true, publicOrigin, port: config.port });
  });

  const experimentRootLocal = path.resolve(CLIENT_ROOT, '..');
  const FORBIDDEN_PATH_PATTERN =
    /(^|\/)(\.env[^/]*|\.git[^/]*|.*\.pem|.*\.p12|.*\.key|package\.json|package-lock\.json|tsconfig.*\.json|vite\.config.*|vitest\.config.*|\.npmrc|\.gitignore)$/i;
  app.use((req, res, next) => {
    const rawPath = decodeURIComponent((req.originalUrl || req.url || '').split('?')[0]);
    if (FORBIDDEN_PATH_PATTERN.test(rawPath)) {
      res.status(404).type('text').send('Not found');
      return;
    }
    if (rawPath.startsWith('/@fs/')) {
      const fsPath = rawPath.slice('/@fs/'.length);
      const resolved = path.resolve(fsPath);
      if (!resolved.startsWith(experimentRootLocal + path.sep)) {
        res.status(403).type('text').send('Forbidden');
        return;
      }
      if (FORBIDDEN_PATH_PATTERN.test(resolved)) {
        res.status(404).type('text').send('Not found');
        return;
      }
      if (fsPath.includes('/src/server/')) {
        res.status(404).type('text').send('Not found');
        return;
      }
    }
    if (rawPath.startsWith('/src/server/') || rawPath.startsWith('/scripts/')) {
      res.status(404).type('text').send('Not found');
      return;
    }
    next();
  });

  let currentVite: ViteDevServer | null = null;
  const createViteForOrigin = async (origin: string | null): Promise<void> => {
    if (currentVite) {
      await currentVite.close().catch(() => undefined);
      currentVite = null;
    }
    const { createServer: createViteServer } = await import('vite');
    currentVite = await createViteServer({
      root: CLIENT_ROOT,
      server: {
        middlewareMode: true,
        hmr: origin
          ? { protocol: 'wss', host: new URL(origin).hostname, clientPort: 443 }
          : { port: config.port + 10 },
        allowedHosts: origin ? [new URL(origin).hostname] : [],
        fs: {
          allow: [CLIENT_ROOT, 'node_modules'],
          deny: ['.env', '.env.*', '*.{pem,p12,key}', '**/.git/**'],
        },
      },
      appType: 'spa',
    });
  };

  if (config.devMode) {
    await createViteForOrigin(config.publicOrigin);
    app.use((req, res, next) => {
      if (currentVite) return currentVite.middlewares(req, res, next);
      next();
    });
  } else {
    app.use(express.static(DIST_CLIENT_ROOT));
    app.get('*', (req, res, next) => {
      if (req.path.startsWith('/api/') || req.path.startsWith('/auth/')) return next();
      res.sendFile(`${DIST_CLIENT_ROOT}/index.html`);
    });
  }

  const server = createServer(app);
  await new Promise<void>((resolve) => {
    server.listen(config.port, '127.0.0.1', resolve);
  });

  const setPublicOrigin = (origin: string | null) => {
    const previous = publicOrigin;
    publicOrigin = origin;
    if (origin && previous !== origin) {
      if (previous) {
        store.invalidatePendingStates();
        log(`Public origin changed: ${previous} -> ${origin}. Pending OAuth attempts invalidated.`);
      }
      log(`Callback URI to register in the Meta dashboard: ${origin}/auth/instagram/callback`);
    }
  };

  if (opts.withNgrok) {
    if (publicOrigin) {
      log(`Using fixed public origin from INSTAGRAM_PUBLIC_ORIGIN: ${publicOrigin}`);
    } else {
      const result = await startNgrok({
        port: config.port,
        domain: config.ngrok.domain,
        apiPort: config.ngrok.apiPort,
      });
      if (result.ok && result.handle) {
        ngrokHandle = result.handle;
        setPublicOrigin(result.handle.publicOrigin);
        if (config.devMode) {
          await createViteForOrigin(result.handle.publicOrigin);
        }
        log(`ngrok tunnel ready: ${result.handle.publicOrigin}`);
        const selfStatus = await fetch(`${result.handle.publicOrigin}/`, {
          signal: AbortSignal.timeout(8000),
        })
          .then((r) => r.status)
          .catch(() => 0);
        if (selfStatus === 200) {
          log('Public origin self-check passed: the UI is reachable through the tunnel.');
        } else {
          log(`WARNING: public origin self-check returned ${selfStatus}. The UI may be blocked; check the output above.`);
        }
        log('');
        log('================ META DASHBOARD ACTION (if callback not yet registered) ================');
        log(`  Register this EXACT redirect URI in Instagram > API setup with Instagram login:`);
        log(`    ${result.handle.publicOrigin}/auth/instagram/callback`);
        log('  Business login settings > OAuth redirect URIs, then save. The UI and OAuth callback both');
        log('  run on this same origin, so session cookies work in the tunnel flow.');
        log('==========================================================================================');
        log('');
        log(`Application URL: ${result.handle.publicOrigin}`);
      } else {
        log(`ngrok unavailable: ${result.error ?? 'unknown error'}`);
        if (result.authProblem) {
          log('Fix ngrok authentication, then run `npm run dev` again. Other tunnels were not touched.');
        }
        log('App continues on loopback only.');
      }
    }
  }

  const close = async (): Promise<void> => {
    if (ngrokHandle) await ngrokHandle.stop();
    if (currentVite) await currentVite.close().catch(() => undefined);
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  };

  return { app, store, observations, port: config.port, getPublicOrigin, ngrokHandle, close };
}

const isDirectRun =
  process.argv[1] &&
  (process.argv[1].includes('src/server/index') ||
    process.argv[1].replace(/\\/g, '/').includes('dist/server/index'));
if (isDirectRun) {
  const withNgrok = process.env.INSTAGRAM_LAB_WITH_NGROK === '1';
  startLabServer({ withNgrok })
    .then((lab) => {
      if (!withNgrok) {
        console.log(
          `Instagram Sandbox Lab API on http://localhost:${lab.port} (no tunnel; use npm run dev for ngrok).`,
        );
      }
      const shutdown = async () => {
        await lab.close();
        process.exit(0);
      };
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);
    })
    .catch((error) => {
      console.error('Failed to start:', error instanceof Error ? error.message : error);
      process.exit(1);
    });
}

export { httpRequest as _httpRequest };
