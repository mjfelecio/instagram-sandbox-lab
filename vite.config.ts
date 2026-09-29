import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

// Vite runs in middleware mode under src/server/index.ts. This config is the
// shared base; the server overrides root/allowedHosts/fs at runtime.
export default defineConfig({
  root: path.resolve(here, 'client'),
  plugins: [react()],
  build: {
    outDir: path.resolve(here, 'dist/client'),
    emptyOutDir: true,
  },
  server: {
    // Never blanket-allow hosts; the server sets the explicit tunnel hostname.
    allowedHosts: [],
    fs: {
      allow: [path.resolve(here, 'client'), path.resolve(here, 'node_modules')],
      deny: ['.env', '.env.*', '*.{pem,p12,key}', '**/.git/**'],
    },
  },
});
