/**
 * Links the system opens the app with, before the router reads them. The
 * share extension opens `<scheme>://dataUrl=…`, which is no screen: the
 * app lands at home and `ShareIntentBridge` opens "Send to agent…" once it
 * has read what was shared. Everything else passes through untouched.
 */

export function redirectSystemPath({ path }: { path: string; initial: boolean }): string {
  return path.includes('dataUrl=') ? '/' : path;
}
