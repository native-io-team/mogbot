// Generated from brand.json by scripts/check-brand.mjs --write. Do not edit.
//
// The phone can't read the repo's brand.json at run time, and the Mac reads
// it at build time (src-tauri/build.rs), so both sides take these from one
// file and `pnpm check:brand` fails if this copy drifts.

/** The app's display name, for copy that genuinely needs it. */
export const APP_NAME = "Mogbot";

/** The pairing link's custom URL scheme (`<scheme>://pair?d=…`). */
export const PAIRING_SCHEME = "mogbot-companion";

/**
 * The pairing scheme before the last rename (`previous.companionScheme`), or
 * null. A code from a Mac still on the old build is recognised, so the phone
 * says to update that app instead of "that isn't a pairing code".
 */
export const PREVIOUS_PAIRING_SCHEME: string | null = "dashbot-companion";

/** The HTTPS port `tailscale serve` publishes the Mac's companion server on. */
export const TAILNET_HTTPS_PORT = 47463;

/** The app's source repository, or null when it has none to link to. */
export const SOURCE_URL: string | null = "https://github.com/native-io-team/mogbot";

/** Where someone with only the phone gets the Mac app, or null when nowhere public. */
export const MAC_DOWNLOAD_URL: string | null = "https://mogbot.app/start";

/**
 * The phone relay (`links.relay`, `wss://<host>`), or null for Tailscale only.
 * The phone accepts a relay route only on this host (docs/relay.md).
 */
export const RELAY_URL: string | null = "wss://mogbot-relay.mogbot-relay.workers.dev";
