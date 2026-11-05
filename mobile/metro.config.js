// The wire types live in ../packages/companion-protocol (linked, not published),
// and the product's name in ../brand.json (src/lib/brand.ts), so Metro has to
// see outside mobile/. It watches the repo root for brand.json, with
// everything else up there blocked: the desktop's own node_modules (a second
// React would break the app), its Rust build, and the other apps' sources.
const path = require('path');
const { getDefaultConfig } = require('expo/metro-config');

const root = path.resolve(__dirname, '..');
const escape = (p) => p.replace(/[/\\^$.*+?()[\]{}|-]/g, '\\$&');
const outside = (dir) => new RegExp(`^${escape(path.join(root, dir))}([/\\\\].*)?$`);

const config = getDefaultConfig(__dirname);
config.watchFolders = [root];
config.resolver.blockList = [
  ...[].concat(config.resolver.blockList ?? []),
  outside('node_modules'),
  outside('src-tauri'),
  outside('src'),
  outside('services'),
  outside('harness'),
  outside('prototypes'),
  outside('test-plugins'),
  outside('public'),
  outside('docs'),
  outside('scripts'),
  outside('plans'),
  outside('.claude'),
  outside('.git'),
];
module.exports = config;
