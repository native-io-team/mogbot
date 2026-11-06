type SentryModule = typeof import('@sentry/react');
import { BRAND } from './lib/brand';

declare const __APP_VERSION__: string;

// Crash reporting is off unless brand.json names a Sentry DSN of our own.
const DSN = BRAND.telemetry.sentryDsn;

// Paths, project names, and branch names appear in error messages, breadcrumbs,
// and `tracing` spans. Strip anything that looks like a home dir so we don't
// ship local filesystem layout (usernames, project folders) to Sentry.
function scrub<T>(value: T): T {
  if (typeof value === 'string') {
    return value
      .replace(/\/Users\/[^/\s"']+/g, '/Users/<redacted>')
      .replace(/\/home\/[^/\s"']+/g, '/home/<redacted>')
      .replace(/C:\\Users\\[^\\"'\s]+/g, 'C:\\Users\\<redacted>') as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map(scrub) as unknown as T;
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = scrub(v);
    }
    return out as unknown as T;
  }
  return value;
}

const forceEnabled = import.meta.env.VITE_SENTRY_FORCE === '1';

// The SDK is ~600 kB of JavaScript the window would parse before painting, so
// it is only fetched when there is a DSN to report to (none, in a build whose
// brand.json names no Sentry project). React's error hooks route through
// `reactErrorHandler` below, which is a no-op until the SDK has loaded.
let sentry: SentryModule | null = null;

/** `Sentry.reactErrorHandler()` that works before (or without) the SDK. */
export function lazyReactErrorHandler(): (
  error: unknown,
  errorInfo: { componentStack?: string }
) => void {
  return (error, errorInfo) => {
    if (!sentry) return;
    sentry.reactErrorHandler()(error, errorInfo as never);
  };
}

// Boot-path guard: instrument.ts is the first module main.tsx evaluates, so a
// throw here means a black window (#173) — crash reporting must never be the
// thing that crashes the app.
try {
  if (DSN && (import.meta.env.PROD || forceEnabled)) {
    void import('@sentry/react')
      .then((Sentry) => {
        Sentry.init({
          dsn: DSN,
          environment: import.meta.env.PROD ? 'production' : 'development',
          release: `${BRAND.slug}@${__APP_VERSION__}`,

          sendDefaultPii: false,

          integrations: [Sentry.browserTracingIntegration()],

          tracesSampleRate: 0.1,

          beforeSend(event) {
            return scrub(event);
          },
          beforeBreadcrumb(breadcrumb) {
            return scrub(breadcrumb);
          },
        });
        sentry = Sentry;
      })
      .catch((err) => console.error('[instrument] Sentry init failed', err));
  }
} catch (err) {
  console.error('[instrument] Sentry init failed', err);
}
