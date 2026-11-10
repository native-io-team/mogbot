// Generated from brand.json by scripts/check-brand.mjs --write. Do not edit.
//
// The phone can't read the repo's brand.json at run time, and the Mac reads
// it at build time (src-tauri/build.rs), so both sides take these from one
// file and `pnpm check:brand` fails if this copy drifts.

/** The app's display name, for copy that genuinely needs it. */
export const APP_NAME = 'Mogbot';

/** The pairing link's custom URL scheme (`<scheme>://pair?d=…`). */
export const PAIRING_SCHEME = 'mogbot-companion';

/** The HTTPS port `tailscale serve` publishes the Mac's companion server on. */
export const TAILNET_HTTPS_PORT = 47463;

/** The app's source repository, or null when it has none to link to. */
export const SOURCE_URL: string | null = 'https://github.com/native-io-team/mogbot';
