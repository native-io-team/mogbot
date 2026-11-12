/**
 * Linking a Mac to an account (docs/relay.md, "Accounts"). The Mac makes a
 * one-time code `<fingerprint>.<b64url 32 random bytes>`: the fingerprint lets
 * the Worker find the Mac's Durable Object (it isn't secret, it's in every
 * pairing QR); the random half is the secret. Only its SHA-256 is stored.
 */
import { FINGERPRINT_RE, fromB64url, toB64url } from './auth';

/** A pending code lives this long. */
export const LINK_TTL_MS = 10 * 60_000;

const CODE_RE = /^([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{43})$/;

/** The code's fingerprint, or null when it isn't a well-formed code. */
export function parseLinkCode(code: unknown): { fingerprint: string } | null {
  if (typeof code !== 'string') return null;
  const m = CODE_RE.exec(code);
  if (!m || !FINGERPRINT_RE.test(m[1])) return null;
  if (fromB64url(m[2])?.length !== 32) return null;
  return { fingerprint: m[1] };
}

export async function hashCode(code: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(code));
  return toB64url(new Uint8Array(digest));
}

/** Constant-time comparison of two hashes. */
export function sameHash(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  return x.length === y.length && crypto.subtle.timingSafeEqual(x, y);
}

/** What `/v1/link` answers with, in plain words for the page. */
export const LINK_MESSAGES = {
  accounts_off: 'Accounts aren’t set up on this relay.',
  bad_request: 'Something went wrong. Start again from Sign in on your Mac.',
  code_invalid: 'This sign-in link isn’t valid. Start again from Sign in on your Mac.',
  code_unknown:
    'This sign-in link was already used or replaced by a newer one. Start again from Sign in on your Mac.',
  code_expired: 'This sign-in link has expired. Start again from Sign in on your Mac.',
  token_invalid: 'Your sign-in couldn’t be checked. Sign out here and try again.',
  token_expired: 'Your sign-in expired before it reached us. Reload this page to try again.',
  keys_unavailable: 'The sign-in service couldn’t be reached. Try again in a minute.',
  slow_down: 'Too many tries. Wait a minute and try again.',
} as const;

export type LinkReason = keyof typeof LINK_MESSAGES;

export function linkError(reason: LinkReason, status: number): Response {
  return Response.json({ ok: false, reason, message: LINK_MESSAGES[reason] }, { status });
}

/** The frontend API host encoded in a Clerk publishable key (`pk_test_…` / `pk_live_…`), or null. */
export function frontendApiOf(publishableKey: string | undefined): string | null {
  const m = /^pk_(test|live)_([A-Za-z0-9+/=_-]+)$/.exec(publishableKey?.trim() ?? '');
  if (!m) return null;
  let decoded: string;
  try {
    decoded = atob(m[2].replace(/-/g, '+').replace(/_/g, '/'));
  } catch {
    return null;
  }
  if (!decoded.endsWith('$')) return null;
  const host = decoded.slice(0, -1);
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(host) ? host : null;
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const PAGE_HEADERS = {
  'content-type': 'text/html; charset=utf-8',
  'cache-control': 'no-store',
  // The code is in this page's address: never send it on to Clerk's script host.
  'referrer-policy': 'no-referrer',
  'content-security-policy': "frame-ancestors 'none'",
  'x-content-type-options': 'nosniff',
};

const STYLE = `
:root{color-scheme:light dark;--bg:#fff;--fg:#111;--muted:#666;--line:#e5e5e5;--err:#111}
@media (prefers-color-scheme:dark){:root{--bg:#111;--fg:#f2f2f2;--muted:#9a9a9a;--line:#2a2a2a;--err:#f2f2f2}}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
background:var(--bg);color:var(--fg);font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;padding:24px 16px}
main{width:100%;max-width:420px;display:flex;flex-direction:column;align-items:center;gap:16px;text-align:center}
h1{font-size:20px;font-weight:600;margin:0}
p{margin:0;color:var(--muted)}
#status:empty{display:none}
#status.done{color:var(--fg);font-weight:600}
#status.error{color:var(--err);border:1px solid var(--line);border-radius:8px;padding:12px 16px}
#sign-in{width:100%;display:flex;justify-content:center}
#confirm{display:flex;flex-direction:column;gap:16px;align-items:center}
#confirm[hidden]{display:none}
#link{font:inherit;font-weight:600;padding:10px 20px;border-radius:8px;border:1px solid var(--line);background:var(--fg);color:var(--bg);cursor:pointer}
`;

function page(body: string, scripts = ''): Response {
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>Sign in</title>
<style>${STYLE}</style>
${scripts}
</head>
<body>
<main>
${body}
</main>
</body>
</html>`;
  return new Response(html, { headers: PAGE_HEADERS });
}

/** A page that says one thing and does nothing. */
function notice(title: string, text: string): Response {
  return page(`<h1>${title}</h1>\n<p>${text}</p>`);
}

/**
 * The script that signs in and sends the code. It reads the code from the
 * address, keeps it in this tab's sessionStorage and takes it out of the
 * address at once, so a sign-in that leaves for Google and comes back never
 * carries it through anyone else's redirects or logs. Signed in, it still
 * waits for a click: a link someone else sent can't bind *their* Mac to a
 * signed-in visitor's account on its own.
 */
const LINK_SCRIPT = `
(function () {
  var KEY = 'relay.linkCode';
  var status = document.getElementById('status');
  var box = document.getElementById('sign-in');
  var confirmBox = document.getElementById('confirm');
  var button = document.getElementById('link');
  var code = new URLSearchParams(location.search).get('code') || '';
  var kept = false;
  try {
    if (code) { sessionStorage.setItem(KEY, code); kept = true; }
    else { code = sessionStorage.getItem(KEY) || ''; kept = !!code; }
  } catch (e) {}
  if (kept) history.replaceState(null, '', '/link');
  var back = kept ? location.origin + '/link' : location.href;
  var sending = false, done = false;
  function say(text, kind) { status.textContent = text; status.className = kind || ''; }
  function forget() { try { sessionStorage.removeItem(KEY); } catch (e) {} }
  async function link() {
    if (sending || done) return;
    sending = true;
    confirmBox.hidden = true;
    say('Linking your Mac…');
    try {
      var token = await Clerk.session.getToken();
      var res = await fetch('/v1/link', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code: code, token: token })
      });
      var body = await res.json().catch(function () { return null; });
      if (body && body.ok) {
        done = true;
        forget();
        say('You’re signed in. Go back to the app.', 'done');
      } else {
        if (body && /^code_/.test(body.reason || '')) forget();
        say((body && body.message) || 'That didn’t work. Start again from Sign in on your Mac.', 'error');
      }
    } catch (e) {
      say('Couldn’t reach the relay. Check your connection and reload this page.', 'error');
    }
    sending = false;
  }
  function ask() {
    if (done) return;
    box.hidden = true;
    say('');
    confirmBox.hidden = false;
  }
  button.addEventListener('click', link);
  window.addEventListener('load', async function () {
    if (!/^[A-Za-z0-9_-]{22}\\.[A-Za-z0-9_-]{43}$/.test(code)) {
      say('This sign-in link isn’t valid. Start again from Sign in on your Mac.', 'error');
      return;
    }
    if (typeof Clerk === 'undefined') {
      say('Couldn’t load sign-in. Check your connection and reload this page.', 'error');
      return;
    }
    try {
      await Clerk.load({ ui: { ClerkUI: window.__internal_ClerkUICtor } });
    } catch (e) {
      say('Couldn’t load sign-in. Reload this page to try again.', 'error');
      return;
    }
    say('');
    if (Clerk.isSignedIn) return ask();
    Clerk.mountSignIn(box, {
      withSignUp: true,
      forceRedirectUrl: back,
      signUpForceRedirectUrl: back
    });
    Clerk.addListener(function (state) { if (state.session) ask(); });
  });
})();
`;

/** `GET /link?code=…`: sign in with Clerk, then hand the code and the session token to `/v1/link`. */
export function linkPage(url: URL, publishableKey: string | undefined, accounts: boolean): Response {
  const host = frontendApiOf(publishableKey);
  if (!accounts || !host || !publishableKey) {
    return notice('Accounts aren’t set up', 'This relay doesn’t have accounts turned on.');
  }
  // No code: a sign-in coming back from Google, its code kept in the tab.
  const given = url.searchParams.get('code');
  if (given !== null && !parseLinkCode(given)) {
    return notice('This link isn’t valid', 'Start again from Sign in on your Mac.');
  }
  const key = escapeAttr(publishableKey.trim());
  const base = `https://${escapeAttr(host)}/npm`;
  // Clerk's documented script-tag setup: the UI bundle, then clerk-js with the key.
  const scripts = `<script defer crossorigin="anonymous" src="${base}/@clerk/ui@1/dist/ui.browser.js" type="text/javascript"></script>
<script defer crossorigin="anonymous" data-clerk-publishable-key="${key}" src="${base}/@clerk/clerk-js@6/dist/clerk.browser.js" type="text/javascript"></script>
<script>${LINK_SCRIPT}</script>`;
  return page(
    `<h1>Sign in to use the relay</h1>
<p>This links your Mac to your account.</p>
<div id="status">Loading…</div>
<div id="sign-in"></div>
<div id="confirm" hidden>
<p>Only continue if you just chose Sign in on your own Mac. If someone sent you this link, close this page.</p>
<button id="link" type="button">Link my Mac</button>
</div>`,
    scripts
  );
}
