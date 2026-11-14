import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import svgr from 'vite-plugin-svgr';
import path from 'path';
import { readFileSync } from 'fs';
// Implementation and tests live in scripts/ so the transform can be checked
// by `pnpm test:scripts` without running a build.
// @ts-expect-error - plain ESM helper, no type declarations
import { stripStylesheetCrossorigin } from './scripts/strip-stylesheet-crossorigin.mjs';

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

/**
 * Dev server port, overridable for parallel checkouts.
 *
 * `strictPort` below means a busy port is a hard failure rather than a silent
 * bump — which is correct, because Tauri is pointed at a fixed URL and a
 * silently-moved Vite would leave the window on the static boot fallback. But
 * it also means two worktrees cannot run at once on the default.
 *
 * `SHIPSTUDIO_DEV_PORT` moves both this and the HMR socket together. Whatever
 * launches Tauri has to point `build.devUrl` at the same port:
 *
 *   SHIPSTUDIO_DEV_PORT=1445 pnpm tauri dev \
 *     --config '{"build":{"devUrl":"http://127.0.0.1:1445"}}'
 */
// @ts-expect-error process is a nodejs global
const devPort = Number(process.env.SHIPSTUDIO_DEV_PORT ?? 1420);

const pkg = JSON.parse(readFileSync(path.resolve(__dirname, 'package.json'), 'utf-8')) as {
  version: string;
};

/**
 * Vite marks the emitted stylesheet `<link rel="stylesheet" crossorigin>`. That
 * attribute puts the fetch in CORS mode, which means the response has to carry
 * `Access-Control-Allow-Origin` or WebKit drops the stylesheet — and in a Tauri
 * build this asset is served by a custom scheme handler, not a normal HTTP
 * origin. When that check fails there is no error anyone sees: React mounts,
 * clears `#root`, and paints an app with none of its rules, which is black text
 * on a dark body. It is indistinguishable from the app never starting, and it
 * is the shape of the report behind #173.
 *
 * The attribute buys nothing here. These assets are same-origin, so removing it
 * only relaxes a requirement — there is no case that works with it and breaks
 * without it. The module script keeps its attribute because the HTML spec
 * fetches module scripts in CORS mode regardless of what the tag says, so
 * stripping it there would be cosmetic and would imply a fix that isn't one.
 *
 * This is a mitigation, not a diagnosis: nobody has yet reproduced the failing
 * fetch. The two boot watchdogs in index.html are what make it speak up if it
 * still happens.
 */
function stripStylesheetCrossoriginPlugin() {
  return {
    name: 'strip-stylesheet-crossorigin',
    enforce: 'post' as const,
    transformIndexHtml(html: string) {
      return stripStylesheetCrossorigin(html);
    },
  };
}

/**
 * Outside the app shell, the dev server's main page goes to the harness.
 *
 * Opening this repo as a project in the app runs plain `vite` in the preview
 * pane, where `/` has no Tauri side and crashes on
 * `window.__TAURI_INTERNALS__`. The same server already serves
 * `/harness.html` (the UI against fixtures), so the page goes there instead.
 * Dev server only (`apply: 'serve'`), only `index.html`, and only when the
 * Tauri internals are missing, so `pnpm tauri dev` and every build are as
 * they were.
 */
function devHarnessRedirectPlugin() {
  return {
    name: 'dev-harness-redirect',
    apply: 'serve' as const,
    transformIndexHtml(html: string, ctx: { path: string }) {
      if (ctx.path !== '/index.html') return html;
      const script =
        "<script>if (!('__TAURI_INTERNALS__' in window)) location.replace('/harness.html' + location.search);</script>";
      return html.replace('<head>', '<head>\n    ' + script);
    },
  };
}

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [
    svgr({
      include: '**/*.svg?react',
      esbuildOptions: {
        jsx: 'automatic',
      },
      svgrOptions: {
        plugins: ['@svgr/plugin-svgo', '@svgr/plugin-jsx'],
        jsxRuntime: 'automatic',
        dimensions: false,
        expandProps: 'end',
        ref: true,
        titleProp: true,
        replaceAttrValues: {
          '#979797': 'currentColor',
        },
        svgProps: {
          focusable: 'false',
        },
        svgoConfig: {
          plugins: ['prefixIds'],
        },
      },
    }),
    react(),
    stripStylesheetCrossoriginPlugin(),
    devHarnessRedirectPlugin(),
  ],

  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },

  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },

  build: {
    chunkSizeWarningLimit: 1000,
    // Explicit transpile floor. Vite 7's implicit default is safari16, which
    // excludes macOS 12 (Safari 15) — a bundle its WebKit can't parse throws
    // before React mounts and the user sees a black window (issue #173).
    // safari15 keeps macOS 12 parseable for a few KB of extra transpilation.
    // Note esbuild only down-levels syntax, not runtime APIs — don't use
    // Safari-16+-only APIs at module scope. Raising this floor is a product
    // decision tied to the minimum supported macOS version, not a routine
    // dependency chore.
    target: ['chrome107', 'edge107', 'firefox104', 'safari15'],
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: devPort,
    strictPort: true,
    // Bind local development explicitly to IPv4. WebKit can resolve
    // `localhost` to 127.0.0.1 before trying ::1, while Node/Vite's default
    // listener may only bind ::1 on macOS. That leaves Tauri showing the
    // static boot fallback even though the Vite server appears healthy.
    host: host || '127.0.0.1',
    hmr: host
      ? {
          protocol: 'ws',
          host,
          port: devPort,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ['**/src-tauri/**'],
    },
  },
}));
