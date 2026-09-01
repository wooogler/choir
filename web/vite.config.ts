import react from '@vitejs/plugin-react';
import { type Plugin, defineConfig } from 'vite';

/**
 * The CHOIR node app that owns every API and auth route. `pnpm dev:socket`
 * takes its port from `.env.development` (PORT=3031); `pnpm dev:oauth` pins
 * 3030. `scripts/dev-local.sh` exports the right one.
 */
const APP_ORIGIN = process.env.CHOIR_DEV_ORIGIN || 'http://127.0.0.1:3031';

/**
 * Set to an ngrok hostname (no scheme) when the dev server is reached through
 * a tunnel, so Vite accepts the forwarded Host header and points the HMR
 * websocket at the tunnel instead of at localhost.
 */
const TUNNEL_HOST = process.env.CHOIR_DEV_TUNNEL_HOST || '';

const DEV_PORT = Number(process.env.CHOIR_DEV_WEB_PORT || 5173);

/**
 * Paths the node app owns. Everything else is the SPA. `/docs/auth` must be
 * listed before the SPA fallback below — it is a server route that lives under
 * the same prefix as the viewer's own URLs.
 */
const PROXY_PREFIXES = ['/api', '/docs/auth', '/assets', '/healthz', '/readyz', '/slack'];

/**
 * The viewer's routes are `/docs/:workspaceId/:filePath`, read straight off
 * `window.location.pathname`. In a production build the node app serves the
 * built index.html for those paths; the dev server has to do the same, or
 * every URL the app actually uses 404s. `/docs/auth/*` is excluded: the proxy
 * has already claimed it.
 */
function docsSpaFallback(): Plugin {
  return {
    name: 'choir-docs-spa-fallback',
    configureServer(server) {
      server.middlewares.use((req, _res, next) => {
        const url = req.url || '';
        if (url.startsWith('/docs/') && !url.startsWith('/docs/auth/')) {
          req.url = '/index.html';
        }
        next();
      });
    },
  };
}

export default defineConfig(({ mode }) => ({
  plugins: [react(), docsSpaFallback()],
  // Built assets are served from /docs-app/ by the node app, but the dev
  // server answers on the same origin as the app itself, so it has no prefix.
  base: mode === 'production' ? '/docs-app/' : '/',
  build: {
    outDir: '../public/docs-app',
    emptyOutDir: true,
  },
  server: {
    port: DEV_PORT,
    strictPort: true,
    proxy: Object.fromEntries(PROXY_PREFIXES.map((prefix) => [prefix, APP_ORIGIN])),
    // Vite serves arbitrary files under /@fs/. Without this, anything that can
    // reach the dev server can read data/**: the docs-session signing key
    // (forgeable manager cookies), the DB encryption key, and the SQLite
    // databases themselves. Vite's default deny only covers .env files.
    fs: {
      strict: true,
      deny: ['**/.env*', '**/data/**', '**/*.db', '**/.choir-*key*', '**/*.{pem,key,crt}'],
    },
    ...(TUNNEL_HOST
      ? {
          allowedHosts: [TUNNEL_HOST],
          hmr: { protocol: 'wss', host: TUNNEL_HOST, clientPort: 443 },
        }
      : {}),
  },
}));
