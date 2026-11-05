/**
 * The app's name, identity and external links — read from the repo-root
 * `brand.json`, the only place they live. The Rust side reads the same file
 * at build time (`src-tauri/build.rs` → `src-tauri/src/brand.rs`).
 *
 * Every link is nullable. A null link means the feature behind it is off,
 * and the UI hides it rather than pointing somewhere that isn't ours.
 *
 * Not here on purpose: the shared compat names (`~/ShipStudio`, the
 * in-project `.shipstudio/` folder, the plugin ABI `__SHIPSTUDIO_*` /
 * `@shipstudio/plugin-sdk` / `os-theme-shipstudio`). Those stay as they are so
 * this app and Ship Studio can open each other's projects and plugins.
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
  pluginRegistry: string | null;
  templateApi: string | null;
  /** GitHub org/user the project starter templates are cloned from. */
  starterRepoBase: string | null;
  /** Git repo the phone app is built from on the user's Mac. */
  companionSource: string | null;
  pushRelay: string | null;
}

export interface Brand {
  name: string;
  slug: string;
  identifier: string;
  urlScheme: string;
  appDirName: string;
  repository: string | null;
  companion: { scheme: string; bundleId: string; tailnetPort: number };
  links: BrandLinks;
  telemetry: {
    posthogKey: string | null;
    posthogHost: string | null;
    sentryDsn: string | null;
  };
}

export const BRAND: Brand = brandJson as Brand;

export const BRAND_LINKS: BrandLinks = BRAND.links;

/** A name for something of ours in a shared namespace: `<slug>-<what>`. */
export function brandScoped(what: string): string {
  return `${BRAND.slug}-${what}`;
}
