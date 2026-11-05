/**
 * Vite config for the browser harness.
 *
 * Extends the production config and swaps the modules that require a native
 * Tauri side for inert stubs — the browser equivalent of the `vi.mock` calls
 * in `src/test/setup.ts`. Kept as its own config so nothing here can leak into
 * a shipped build.
 */

import { defineConfig, mergeConfig, type Plugin, type UserConfig } from 'vite';
import { execSync } from 'child_process';
import fs from 'fs';
import http from 'http';
import path from 'path';
import base from './vite.config';

/**
 * The harness announces which checkout it is serving.
 *
 * Without this, `harness-capture.mjs` could only ask "is something listening on
 * the harness port". On a machine running several worktrees that is a different
 * question from "is *my* harness listening", and answering the easy one meant a
 * capture could attach to another worktree's server and write a full set of
 * confidently-labelled screenshots of a tree it was never pointed at. Every
 * other failure in the capture path is loud; that one wrote green checkmarks.
 */
function identityPlugin(): Plugin {
  const root = process.cwd();
  let head = 'unknown';
  try {
    head = execSync('git rev-parse HEAD', { cwd: root, encoding: 'utf-8' }).trim();
  } catch {
    // Not a git checkout, or git is unavailable. The root comparison is the
    // load-bearing half; HEAD is only there to make a mismatch legible.
  }

  return {
    name: 'shipstudio-harness-identity',
    configureServer(server) {
      server.middlewares.use('/__harness/identity', (_req, res) => {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ root, head }));
      });
    },
  };
}

/**
 * Serve the migration fixtures, which deliberately do not live in `public/`.
 *
 * They are full-page screenshots of a real site — megabytes of them — and
 * anything under `public/` is copied into the shipped app. A reviewer needs
 * them to look at the comparison viewer; a user has no use for them at all,
 * and would be downloading them with every release.
 */
function migrationFixturesPlugin(): Plugin {
  const dir = path.resolve(__dirname, './harness/migration-demo');

  return {
    name: 'shipstudio-harness-migration-fixtures',
    configureServer(server) {
      server.middlewares.use('/migration-demo', (req, res, next) => {
        const rel = decodeURIComponent((req.url ?? '/').split('?')[0]);
        const file = path.join(dir, rel);
        // Nothing outside the fixture directory, whatever the URL claims.
        if (!file.startsWith(dir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
          next();
          return;
        }
        res.setHeader('Content-Type', file.endsWith('.json') ? 'application/json' : 'image/png');
        res.end(fs.readFileSync(file));
      });
    },
  };
}

/**
 * `vite preview` of a perf build has no repo root to serve from, so the
 * agents' demo home (attachment images) is mounted explicitly. The dev server
 * serves it from the checkout as-is.
 */
function agentsDemoPreviewPlugin(): Plugin {
  const dir = path.resolve(__dirname, './harness/agents-demo');

  return {
    name: 'shipstudio-harness-agents-demo-preview',
    configurePreviewServer(server) {
      server.middlewares.use('/harness/agents-demo', (req, res, next) => {
        const rel = decodeURIComponent((req.url ?? '/').split('?')[0]);
        const file = path.join(dir, rel);
        if (!file.startsWith(dir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
          next();
          return;
        }
        res.setHeader('Content-Type', file.endsWith('.png') ? 'image/png' : 'image/jpeg');
        res.end(fs.readFileSync(file));
      });
    },
  };
}

/**
 * A fictional site for the Agents preview pane's shots, on the harness port
 * + 1: the pane loads a dev server by port at `/`, so it can't be a path on
 * the harness itself (that would load the app inside its own preview). Only
 * the files in `harness/preview-site/`; loopback only; a busy port just
 * leaves the pane showing "Loading the site…".
 */
function previewSitePlugin(port: number): Plugin {
  const dir = path.resolve(__dirname, './harness/preview-site');
  return {
    name: 'shipstudio-harness-preview-site',
    configureServer(server) {
      const handle: http.RequestListener = (req, res) => {
        const raw = decodeURIComponent((req.url ?? '/').split('?')[0]);
        const rel = raw === '/' ? '/index.html' : path.extname(raw) ? raw : `${raw}.html`;
        const file = path.join(dir, rel);
        if (!file.startsWith(dir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
          res.statusCode = 404;
          res.setHeader('Content-Type', 'text/html; charset=utf-8');
          res.end('<!doctype html><title>Not found</title><p>This page doesn’t exist yet.</p>');
          return;
        }
        res.setHeader(
          'Content-Type',
          file.endsWith('.css') ? 'text/css' : 'text/html; charset=utf-8'
        );
        res.end(fs.readFileSync(file));
      };
      // `localhost` may resolve to either loopback: serve both, nothing else.
      const sites = ['127.0.0.1', '::1'].map((host) => {
        const site = http.createServer(handle);
        site.on('error', (e) =>
          console.warn(`[harness] preview site not on ${host}: ${e.message}`)
        );
        site.listen(port, host);
        return site;
      });
      server.httpServer?.on('close', () => sites.forEach((site) => site.close()));
    },
  };
}

/**
 * Worktrees would otherwise serialise on one port — `strictPort` means the
 * second harness fails to start, and with four sessions live that is a real
 * cost. Overriding the port lets them run side by side.
 */
const PORT = Number(process.env.SHIPSTUDIO_HARNESS_PORT ?? 1425);

export default defineConfig(async (env) => {
  const resolved = (await (base as unknown as (e: typeof env) => Promise<UserConfig>)(
    env
  )) as UserConfig;

  return mergeConfig(resolved, {
    plugins: [
      identityPlugin(),
      migrationFixturesPlugin(),
      agentsDemoPreviewPlugin(),
      previewSitePlugin(PORT + 1),
    ],
    resolve: {
      alias: {
        'tauri-pty': path.resolve(__dirname, './src/harness/stubs/tauri-pty.ts'),
        'tauri-plugin-screenshots-api': path.resolve(
          __dirname,
          './src/harness/stubs/screenshots.ts'
        ),
        '@tauri-apps/plugin-updater': path.resolve(__dirname, './src/harness/stubs/updater.ts'),
      },
    },
    server: { port: PORT, strictPort: true, host: '127.0.0.1' },
    preview: { port: PORT, strictPort: true, host: '127.0.0.1' },
    // `vite build --config vite.harness.config.ts` is the perf build that
    // `scripts/perf-agents.mjs` measures: production React, the harness entry,
    // and unminified so CPU profiles keep function names. Never shipped.
    build: {
      outDir: 'harness/perf-build',
      emptyOutDir: true,
      minify: false,
      rollupOptions: { input: path.resolve(__dirname, 'harness.html') },
    },
    // Own dependency cache: the harness aliases Tauri modules to stubs, so a
    // shared `node_modules/.vite` let it overwrite the dev server's pre-bundles
    // and the real app failed to load main.tsx (504 "outdated optimize dep").
    cacheDir: 'node_modules/.vite-harness',
  } satisfies UserConfig);
});
