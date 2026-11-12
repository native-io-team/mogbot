/**
 * The app's name, identity and external links — read from the repo-root
 * `brand.json`, the only place they live. The Rust side reads the same file
 * at build time (`src-tauri/build.rs` → `src-tauri/src/brand.rs`).
 *
 * Every link is nullable. A null link means the feature behind it is off,
 * and the UI hides it rather than pointing somewhere that isn't ours.
 *
 * Not here on purpose: the shared compat names (`~/ShipStudio`, the
 * in-project `.shipstudio/` folder). Those stay as they are so this app and
 * Ship Studio can open each other's projects.
 */
import brandJson from '../../brand.json';

export interface BrandLinks {
  /** `owner/repo` that in-app issue reports are filed against. */
  issueRepo: string | null;
  securityAdvisories: string | null;
  discussions: string | null;
  /** Community chat invite (the old "Join us on Slack" CTAs). */
  community: string | null;
  /** Public website, e.g. for a PR footer credit. */
  website: string | null;
  /** Automatic error-report endpoint (Rust only). */
  errorReports: string | null;
  /** Release downloads, for installing a specific version ("rewind"). */
  releases: string | null;
  /** Auto-update feed. Null: no update channel, the updater stays silent. */
  updates: string | null;
  templateApi: string | null;
  /** GitHub org/user the project starter templates are cloned from. */
  starterRepoBase: string | null;
  /** Git repo the phone app is built from on the user's Mac. */
  companionSource: string | null;
  /**
   * The phone app's App Store page. Null until it is live there: the app
   * never links to a store page that may not exist yet.
   */
  appStore: string | null;
  /**
   * The phone app's public TestFlight link (the beta). Offered when there is
   * no App Store page yet.
   */
  testFlight: string | null;
  /**
   * The phone app's Google Play page. Absent or null while the phone app is
   * iPhone only: Android isn't offered anywhere (not even Tailscale's
   * Android link on the pairing steps).
   */
  playStore?: string | null;
  pushRelay: string | null;
  /**
   * The relay phones reach this Mac through without Tailscale (`wss://host`,
   * docs/relay.md). Null (a fork, or a build without one): Tailscale only.
   */
  relay?: string | null;
  /** Where the Mac app is downloaded from (the phone's pairing screen links it). */
  macDownload: string | null;
}

export interface Brand {
  name: string;
  slug: string;
  identifier: string;
  urlScheme: string;
  appDirName: string;
  repository: string | null;
  companion: { scheme: string; bundleId: string; tailnetPort: number };
  /**
   * The app's identity before its last rename, read only by the Rust-side
   * one-time migration that carries old state over. Never shown.
   */
  previous?: {
    name: string | null;
    slug: string | null;
    identifier: string | null;
    appDirName: string | null;
  };
  links: BrandLinks;
  /** The app's Chrome extension: its Web Store id once listed, else null. */
  chromeExtension?: { webStoreId: string | null };
  telemetry: {
    posthogKey: string | null;
    posthogHost: string | null;
    sentryDsn: string | null;
  };
}

export const BRAND: Brand = brandJson as Brand;

export const BRAND_LINKS: BrandLinks = BRAND.links;

let relayOverride: boolean | null = null;

/**
 * This build has our hosted relay (docs/relay.md): signing in to an account
 * lets phones reach this Mac without Tailscale, so the phone's two Tailscale
 * screens are passed over (Tailscale stays a fallback route once it's on).
 * False in a fork or any build with `links.relay` null: no account, no
 * relay, nothing about either is shown.
 *
 * A function rather than a constant so the UI harness, whose brand.json has
 * no relay, can draw a relay build's screens (`overrideRelayForHarness`).
 */
export function relayOn(): boolean {
  return relayOverride ?? !!BRAND_LINKS.relay;
}

/**
 * The UI harness only (`src/harness/resetStorage.ts`, a scenario's
 * `relay: true`): draw this build as one with a relay. Nothing in the app
 * calls it, so a real build always follows brand.json.
 */
export function overrideRelayForHarness(on: boolean | null) {
  relayOverride = on;
}

/** A name for something of ours in a shared namespace: `<slug>-<what>`. */
export function brandScoped(what: string): string {
  return `${BRAND.slug}-${what}`;
}
