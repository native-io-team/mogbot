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
:root{color-scheme:light;--bg:#efebe3;--tray:#ddd6c9;--tray-2:#cfc7b8;--card:#faf8f4;--ink:#1d1c1a;--ink-2:#55524b;--ink-3:#6b675f;
--hair:#1d1c1a17;--key-face:#4A4E55;--key-skirt:#34373C;--key-depth:#131417;--key-legend:#F2EEE4;
--dark-top:#3a3835;--dark-bot:#22201e;--dark-side:#0f0e0d}
@media (prefers-color-scheme:dark){:root{color-scheme:dark;--bg:#1b1a18;--tray:#141312;--tray-2:#100f0e;--card:#252421;--ink:#f1ece2;--ink-2:#b9b3a7;
--ink-3:#9a948a;--hair:#f1ece21a;--key-face:#F1ECE2;--key-skirt:#D9D1C1;--key-depth:#8F8672;--key-legend:#1d1c1a;
--dark-top:#f1ece2;--dark-bot:#ddd6c9;--dark-side:#8f8672}}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:28px;
background:var(--bg);color:var(--ink);font:16px/1.5 Geist,system-ui,-apple-system,sans-serif;-webkit-font-smoothing:antialiased;padding:32px 16px}
.brand{display:flex;align-items:center;gap:10px;font-weight:600;font-size:18px;letter-spacing:-.03em;color:var(--ink);text-decoration:none}
.mark{position:relative;width:32px;height:32px;border-radius:7px;background:linear-gradient(180deg,var(--key-skirt),var(--key-skirt));
box-shadow:0 2px 0 var(--key-depth),0 6px 10px -4px #00000040}
.mark i{position:absolute;inset:2px 2px 4px;border-radius:5px;background:var(--key-face);display:grid;place-items:center}
.mark svg{width:20px;height:20px;fill:var(--key-legend)}
main{width:100%;max-width:440px;display:flex;flex-direction:column;align-items:center;gap:14px;text-align:center;
background:var(--card);border-radius:22px;padding:32px 24px 28px;
box-shadow:0 0 0 1px var(--hair),0 24px 40px -22px #00000050,0 6px 12px -8px #00000026}
h1{font-size:26px;line-height:1.1;font-weight:600;letter-spacing:-.045em;margin:0;text-wrap:balance}
p{margin:0;color:var(--ink-2);text-wrap:pretty}
#status:empty{display:none}
#status{color:var(--ink-3);font-size:15px}
#status.done{color:var(--ink);font-weight:600;font-size:17px}
#status.error{color:var(--ink);background:var(--bg);border-radius:12px;padding:12px 16px;box-shadow:inset 0 2px 5px #00000020}
#sign-in{width:100%;display:flex;justify-content:center}
#sign-in:empty{display:none}
#confirm{display:flex;flex-direction:column;gap:18px;align-items:center}
#confirm[hidden]{display:none}
#link{font:inherit;font-weight:600;font-size:16px;letter-spacing:-.01em;padding:12px 24px 13px;border:0;border-radius:12px;cursor:pointer;
color:var(--bg);background:linear-gradient(var(--dark-top),var(--dark-bot));
box-shadow:inset 0 1px 0 #ffffff26,0 0 0 1px #000,0 5px 0 var(--dark-side),0 14px 22px -6px #00000059;
transition:transform 70ms cubic-bezier(.3,.7,.4,1),box-shadow 70ms cubic-bezier(.3,.7,.4,1)}
#link:active{transform:translateY(4px);box-shadow:inset 0 1px 0 #ffffff1a,0 0 0 1px #000,0 1px 0 var(--dark-side),0 4px 8px -4px #00000059}
#link:focus-visible{outline:2px solid var(--ink);outline-offset:4px}
.foot{font-size:13px;color:var(--ink-3)}
.foot a{color:inherit}
`;

/** The mark (the m face), as on the site. */
const MARK = `<span class="mark" aria-hidden="true"><i><svg viewBox="0 0 96 96"><path fill-rule="evenodd" d="M39,12 H57 C75.6,12 87,23.4 87,42 V75 C87,80.58 83.58,84 78,84 H18 C12.42,84 9,80.58 9,75 V42 C9,23.4 20.4,12 39,12 Z M27,75 V39 A6,6 0 0 1 39,39 V75 Z M57,75 V39 A6,6 0 0 1 69,39 V75 Z"/></svg></i></span>`;

function page(body: string, scripts = ''): Response {
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>Sign in · Mogbot</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600&display=swap" rel="stylesheet">
<style>${STYLE}</style>
${scripts}
</head>
<body>
<a class="brand" href="https://mogbot.app">${MARK}Mogbot</a>
<main>
${body}
</main>
<p class="foot"><a href="https://mogbot.app/privacy">Privacy</a> · <a href="https://mogbot.app/terms">Terms</a></p>
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
// In <head>, so wait for the body before looking anything up.
document.addEventListener('DOMContentLoaded', function () {
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
    var dark = window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches;
    Clerk.mountSignIn(box, {
      withSignUp: true,
      appearance: {
        variables: {
          fontFamily: 'Geist, system-ui, sans-serif',
          borderRadius: '12px',
          colorPrimary: dark ? '#f1ece2' : '#1d1c1a',
          colorText: dark ? '#f1ece2' : '#1d1c1a',
          colorTextSecondary: dark ? '#b9b3a7' : '#55524b',
          colorBackground: dark ? '#252421' : '#faf8f4',
          colorInputBackground: dark ? '#1b1a18' : '#ffffff',
          colorInputText: dark ? '#f1ece2' : '#1d1c1a'
        },
        elements: {
          rootBox: { width: '100%' },
          cardBox: { boxShadow: 'none', border: '0', width: '100%' },
          card: { boxShadow: 'none', background: 'transparent', padding: '8px 0 0' },
          header: { display: 'none' },
          footer: { background: 'transparent' }
        }
      },
      forceRedirectUrl: back,
      signUpForceRedirectUrl: back
    });
    Clerk.addListener(function (state) { if (state.session) ask(); });
  });
});
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
    `<h1>Sign in to Mogbot</h1>
<p>So your phone reaches your Mac from anywhere. Free, no card.</p>
<div id="status">Loading…</div>
<div id="sign-in"></div>
<div id="confirm" hidden>
<p>Only continue if you just chose Sign in on your own Mac. If someone sent you this link, close this page.</p>
<button id="link" type="button">Link my Mac</button>
</div>`,
    scripts
  );
}
