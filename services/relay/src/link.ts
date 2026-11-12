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
:root{color-scheme:light;--bg:#efebe3;--tray:#ddd6c9;--tray-2:#cfc7b8;--card:#faf8f4;--field:#ffffff;--ink:#1d1c1a;--ink-2:#55524b;--ink-3:#6b675f;
--hair:#1d1c1a17;--key-face:#4A4E55;--key-skirt:#34373C;--key-depth:#131417;--key-legend:#F2EEE4;
--dark-top:#3a3835;--dark-bot:#22201e;--dark-side:#0f0e0d}
@media (prefers-color-scheme:dark){:root{color-scheme:dark;--bg:#1b1a18;--tray:#141312;--tray-2:#100f0e;--card:#252421;--field:#1b1a18;--ink:#f1ece2;--ink-2:#b9b3a7;
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
.step{width:100%;display:flex;flex-direction:column;gap:12px;align-items:stretch;margin-top:6px}
.step[hidden],[hidden]{display:none!important}
#confirm{align-items:center;gap:18px}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}
label{text-align:left;font-size:14px;font-weight:500;color:var(--ink-2);margin-bottom:-6px}
input{font:inherit;font-size:16px;color:var(--ink);background:var(--field);border:0;border-radius:12px;padding:12px 14px;width:100%;
box-shadow:inset 0 0 0 1px var(--hair),inset 0 2px 4px #00000012}
input:focus{outline:2px solid var(--ink);outline-offset:1px}
input::placeholder{color:var(--ink-3)}
.handle{display:flex;align-items:center;background:var(--field);border-radius:12px;padding-left:14px;box-shadow:inset 0 0 0 1px var(--hair),inset 0 2px 4px #00000012}
.handle:focus-within{outline:2px solid var(--ink);outline-offset:1px}
.handle span{font-size:20px;font-weight:600;color:var(--ink-3)}
.handle input{font-size:20px;font-weight:600;letter-spacing:-.02em;padding-left:2px;background:none;box-shadow:none;border:0;border-radius:0 12px 12px 0}
.handle input:focus{outline:0}
.ideas{display:flex;flex-wrap:wrap;gap:8px;justify-content:center}
.idea{font:inherit;font-size:14px;font-weight:500;color:var(--ink-2);background:none;border:0;border-radius:999px;padding:6px 12px;
cursor:pointer;box-shadow:0 0 0 1px var(--hair)}
.idea:hover{color:var(--ink)}
.idea:focus-visible{outline:2px solid var(--ink);outline-offset:2px}
.otp{text-align:center;font-size:22px;letter-spacing:.3em;font-variant-numeric:tabular-nums}
.or{display:flex;align-items:center;gap:12px;color:var(--ink-3);font-size:13px}
.or:before,.or:after{content:"";flex:1;height:1px;background:var(--hair)}
.alt{display:flex;align-items:center;justify-content:center;gap:10px;font:inherit;font-weight:600;font-size:16px;color:var(--ink);cursor:pointer;
background:var(--field);border:0;border-radius:12px;padding:12px 16px;box-shadow:0 0 0 1px var(--hair),0 3px 0 var(--hair),0 8px 14px -8px #00000030;
transition:transform 70ms cubic-bezier(.3,.7,.4,1),box-shadow 70ms cubic-bezier(.3,.7,.4,1)}
.alt:active{transform:translateY(2px);box-shadow:0 0 0 1px var(--hair),0 1px 0 var(--hair)}
.alt svg{width:18px;height:18px}
.alt:focus-visible,.text:focus-visible{outline:2px solid var(--ink);outline-offset:3px}
.text{font:inherit;color:var(--ink-2);background:none;border:0;padding:0;cursor:pointer;text-decoration:underline;text-underline-offset:3px}
.small{font-size:14px;color:var(--ink-3)}
button:disabled{opacity:.6;cursor:default}
.key{font:inherit;font-weight:600;font-size:16px;letter-spacing:-.01em;padding:12px 24px 13px;border:0;border-radius:12px;cursor:pointer;
color:var(--bg);background:linear-gradient(var(--dark-top),var(--dark-bot));
box-shadow:inset 0 1px 0 #ffffff26,0 0 0 1px #000,0 5px 0 var(--dark-side),0 14px 22px -6px #00000059;
transition:transform 70ms cubic-bezier(.3,.7,.4,1),box-shadow 70ms cubic-bezier(.3,.7,.4,1)}
.key:active{transform:translateY(4px);box-shadow:inset 0 1px 0 #ffffff1a,0 0 0 1px #000,0 1px 0 var(--dark-side),0 4px 8px -4px #00000059}
.key:focus-visible{outline:2px solid var(--ink);outline-offset:4px}
.foot{font-size:13px;color:var(--ink-3)}
.foot a{color:inherit}
`;

/** The mark (the m face), as on the site. */
const MARK = `<span class="mark" aria-hidden="true"><i><svg viewBox="0 0 96 96"><path fill-rule="evenodd" d="M39,12 H57 C75.6,12 87,23.4 87,42 V75 C87,80.58 83.58,84 78,84 H18 C12.42,84 9,80.58 9,75 V42 C9,23.4 20.4,12 39,12 Z M27,75 V39 A6,6 0 0 1 39,39 V75 Z M57,75 V39 A6,6 0 0 1 69,39 V75 Z"/></svg></i></span>`;

/** Google's G, in its own colours (their sign-in button guidelines). */
const GOOGLE = `<svg viewBox="0 0 48 48" aria-hidden="true"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 13 4 4 13 4 24s9 20 20 20 20-9 20-20c0-1.3-.1-2.4-.4-3.5z"/><path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z"/></svg>`;

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
 * The script that signs in and sends the code, with our own form on Clerk's
 * headless API (no Clerk UI): Continue with Google, or an emailed code. It
 * reads the code from the address, keeps it in this tab's sessionStorage and
 * takes it out of the address at once, so a sign-in that leaves for Google and
 * comes back never carries it through anyone else's redirects or logs. Signed
 * in, it still waits for a click: a link someone else sent can't bind *their*
 * Mac to a signed-in visitor's account on its own.
 */
const LINK_SCRIPT = `
// In <head>, so wait for the body before looking anything up.
document.addEventListener('DOMContentLoaded', function () {
  var KEY = 'relay.linkCode';
  function $(id) { return document.getElementById(id); }
  var status = $('status');
  var params = new URLSearchParams(location.search);
  var code = params.get('code') || '';
  var fromGoogle = params.get('sso') === '1';
  var kept = false;
  try {
    if (code) { sessionStorage.setItem(KEY, code); kept = true; }
    else { code = sessionStorage.getItem(KEY) || ''; kept = !!code; }
  } catch (e) {}
  if (kept || fromGoogle) history.replaceState(null, '', '/link');
  var back = location.origin + '/link';
  var sending = false, done = false, mode = 'in', email = '';
  var steps = ['choose', 'verify', 'more', 'confirm'];
  function show(step) {
    steps.forEach(function (s) { $(s).hidden = s !== step; });
    var f = step && $(step).querySelector('input:not([hidden])');
    if (f) f.focus();
  }
  function say(text, kind) { status.textContent = text; status.className = kind || ''; }
  function forget() { try { sessionStorage.removeItem(KEY); } catch (e) {} }
  function oops(e, fallback) {
    var err = e && e.errors && e.errors[0];
    say((err && (err.longMessage || err.message)) || fallback || 'That didn’t work. Try again.', 'error');
  }
  function busy(form, on) {
    var b = form.querySelector('button[type=submit]');
    if (b) b.disabled = on;
  }
  // Clerk's bot check: invisible for most people; when it wants a challenge,
  // Clerk's UI shows just that challenge, then the sign-in carries on.
  async function guard(res) {
    var needs = res && (res.protectCheck || res.status === 'needs_protect_check' ||
      (res.missingFields || []).indexOf('protect_check') >= 0);
    if (!needs || !res.protectCheck) return res;
    say('One quick check…');
    await Clerk.__internal_openProtectCheckModal({ resource: res });
    await res.reload();
    say('');
    return res;
  }
  async function finish(sessionId) {
    await Clerk.setActive({ session: sessionId });
    ask();
  }
  function ask() {
    if (done) return;
    say('');
    var u = Clerk.user;
    var who = u && (u.username ? '@' + u.username : u.primaryEmailAddress && u.primaryEmailAddress.emailAddress);
    $('who').textContent = who ? 'Signed in as ' + who + '.' : '';
    $('title').textContent = u && u.username ? 'Hey, @' + u.username : 'Sign in to Mogbot';
    $('lede').textContent = 'One last step: link this account to your Mac.';
    show('confirm');
  }
  async function link() {
    if (sending || done) return;
    sending = true;
    show(null);
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
        $('lede').hidden = true;
        var name = Clerk.user && Clerk.user.username;
        $('title').textContent = name ? 'You’re in, @' + name : 'You’re signed in';
        say('Go back to the app. You can close this page.', 'done');
      } else {
        if (body && /^code_/.test(body.reason || '')) forget();
        say((body && body.message) || 'That didn’t work. Start again from Sign in on your Mac.', 'error');
      }
    } catch (e) {
      say('Couldn’t reach the relay. Check your connection and reload this page.', 'error');
    }
    sending = false;
  }
  async function google() {
    say('');
    try {
      await Clerk.client.signIn.authenticateWithRedirect({
        strategy: 'oauth_google',
        redirectUrl: back + '?sso=1',
        redirectUrlComplete: back
      });
    } catch (e) { oops(e); }
  }
  async function sendCode(again) {
    if (mode === 'in') {
      var si = Clerk.client.signIn;
      var factor = (si.supportedFirstFactors || []).filter(function (f) { return f.strategy === 'email_code'; })[0];
      if (!factor) throw { errors: [{ message: 'This account can’t get a sign-in code. Try Continue with Google.' }] };
      await si.prepareFirstFactor({ strategy: 'email_code', emailAddressId: factor.emailAddressId });
    } else {
      await Clerk.client.signUp.prepareEmailAddressVerification({ strategy: 'email_code' });
    }
    $('sent').textContent = (again ? 'We sent a new code to ' : 'We sent a code to ') + email + '.';
  }
  async function start(e) {
    e.preventDefault();
    var form = e.target;
    email = $('email').value.trim();
    if (!email) return;
    busy(form, true);
    say('');
    try {
      try {
        await guard(await Clerk.client.signIn.create({ identifier: email }));
        mode = 'in';
      } catch (err) {
        var c = err && err.errors && err.errors[0] && err.errors[0].code;
        if (c !== 'form_identifier_not_found') throw err;
        await guard(await Clerk.client.signUp.create({ emailAddress: email }));
        mode = 'up';
      }
      await sendCode(false);
      $('otp').value = '';
      show('verify');
    } catch (err) { oops(err); }
    busy(form, false);
  }
  // The @handle: lower case, letters, digits, _ and -, as Clerk takes them.
  function handle(v) { return (v || '').toLowerCase().replace(/^@+/, '').replace(/[^a-z0-9_-]/g, ''); }
  var taken = [];
  function ideas(su) {
    var local = (su.emailAddress || email || '').split('@')[0].split(/[._+-]/);
    var first = handle(su.firstName) || handle(local[0]);
    var full = handle((su.firstName || '') + (su.lastName || '')) || handle(local.join(''));
    if (!first) return [];
    var all = [first, full, first + 'bot', 'the' + first, first + 'hq', full + 'bot'];
    return all.filter(function (h, i) {
      return h.length >= 4 && h.length <= 32 && all.indexOf(h) === i && taken.indexOf(h) < 0;
    }).slice(0, 4);
  }
  function drawIdeas(su) {
    var box = $('ideas');
    box.textContent = '';
    ideas(su).forEach(function (h) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'idea';
      b.textContent = '@' + h;
      b.addEventListener('click', function () { $('username').value = h; $('username').focus(); });
      box.appendChild(b);
    });
    box.hidden = !box.firstChild;
  }
  var pendingSignUp = null;
  function more(su) {
    pendingSignUp = su;
    var need = su.missingFields || [];
    var wantsName = need.indexOf('username') >= 0, wantsPass = need.indexOf('password') >= 0;
    $('handle').hidden = !wantsName; $('username').required = wantsName; $('username-label').hidden = !wantsName;
    $('password').hidden = !wantsPass; $('password').required = wantsPass; $('password-label').hidden = !wantsPass;
    if (!wantsName && !wantsPass && need.indexOf('protect_check') >= 0) return say('Clerk’s bot check didn’t pass. Reload this page and try again.', 'error');
    if (!wantsName && !wantsPass) return say('Something else is needed to finish signing up. Try Continue with Google.', 'error');
    if (wantsName) {
      $('title').textContent = 'Claim your @handle';
      $('lede').textContent = 'First come, first served. Pick a good one.';
      $('password-label').textContent = 'And a password';
      $('finish').textContent = 'Claim it';
      drawIdeas(su);
    } else {
      $('title').textContent = 'One more thing';
      $('lede').textContent = 'Pick a password to finish your account.';
      $('password-label').textContent = 'Password';
      $('finish').textContent = 'Finish';
      $('ideas').hidden = true;
    }
    show('more');
  }
  async function verify(e) {
    e.preventDefault();
    var form = e.target;
    var otp = $('otp').value.replace(/\\s/g, '');
    if (!otp) return;
    busy(form, true);
    say('');
    try {
      if (mode === 'in') {
        var si = await guard(await Clerk.client.signIn.attemptFirstFactor({ strategy: 'email_code', code: otp }));
        if (si.status === 'complete') await finish(si.createdSessionId);
        else say('That didn’t finish signing in. Try Continue with Google.', 'error');
      } else {
        var su = await guard(await Clerk.client.signUp.attemptEmailAddressVerification({ code: otp }));
        if (su.status === 'complete') await finish(su.createdSessionId);
        else more(su);
      }
    } catch (err) { oops(err, 'That code didn’t work. Check it and try again.'); }
    busy(form, false);
  }
  async function complete(e) {
    e.preventDefault();
    var form = e.target;
    busy(form, true);
    say('');
    try {
      var fields = {};
      if (!$('handle').hidden) {
        fields.username = handle($('username').value);
        if (fields.username.length < 4) {
          busy(form, false);
          return say('At least 4 letters or numbers.', 'error');
        }
      }
      if (!$('password').hidden) fields.password = $('password').value;
      var su = await guard(await Clerk.client.signUp.update(fields));
      if (su.status === 'complete') await finish(su.createdSessionId);
      else more(su);
    } catch (err) {
      var c = err && err.errors && err.errors[0] && err.errors[0].code;
      if (c === 'form_identifier_exists' && fields.username) {
        taken.push(fields.username);
        if (pendingSignUp) drawIdeas(pendingSignUp);
        say('@' + fields.username + ' is taken. Try another.', 'error');
      } else oops(err);
    }
    busy(form, false);
  }
  $('google').addEventListener('click', google);
  $('choose').addEventListener('submit', start);
  $('verify').addEventListener('submit', verify);
  $('more').addEventListener('submit', complete);
  $('username').addEventListener('input', function () {
    var v = handle(this.value);
    if (v !== this.value) this.value = v;
  });
  $('resend').addEventListener('click', async function () {
    say('');
    try { await sendCode(true); } catch (err) { oops(err); }
  });
  $('restart').addEventListener('click', function () { say(''); show('choose'); });
  $('link').addEventListener('click', link);
  $('switch').addEventListener('click', async function () {
    try { await Clerk.signOut(); } catch (e) {}
    show('choose');
  });
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
    if (fromGoogle && !Clerk.isSignedIn) {
      try {
        await Clerk.handleRedirectCallback({
          signInForceRedirectUrl: back,
          signUpForceRedirectUrl: back,
          continueSignUpUrl: back + '?more=1'
        });
      } catch (e) { oops(e, 'Google sign-in didn’t finish. Try again.'); }
      if (!Clerk.isSignedIn) {
        var su = Clerk.client && Clerk.client.signUp;
        say('');
        if (su && su.status === 'missing_requirements') return more(su);
        return show('choose');
      }
    }
    say('');
    if (Clerk.isSignedIn) return ask();
    var pending = Clerk.client && Clerk.client.signUp;
    if (params.get('more') === '1' && pending && pending.status === 'missing_requirements') return more(pending);
    show('choose');
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
  // The form is ours. Clerk's UI bundle is loaded only so its bot check
  // (protect_check) can run when Clerk asks for one; no Clerk box is mounted.
  const scripts = `<script defer crossorigin="anonymous" src="${base}/@clerk/ui@1/dist/ui.browser.js" type="text/javascript"></script>
<script defer crossorigin="anonymous" data-clerk-publishable-key="${key}" src="${base}/@clerk/clerk-js@6/dist/clerk.browser.js" type="text/javascript"></script>
<script>${LINK_SCRIPT}</script>`;
  return page(
    `<h1 id="title">Sign in to Mogbot</h1>
<p id="lede">So your phone reaches your Mac from anywhere. Free, no card.</p>
<div id="status">Loading…</div>
<form id="choose" class="step" hidden novalidate>
<button id="google" class="alt" type="button">${GOOGLE}Continue with Google</button>
<div class="or"><span>or</span></div>
<label for="email" class="sr">Email</label>
<input id="email" type="email" autocomplete="email" inputmode="email" placeholder="you@example.com" required>
<button class="key" type="submit">Email me a code</button>
<div id="clerk-captcha"></div>
</form>
<form id="verify" class="step" hidden novalidate>
<p id="sent"></p>
<label for="otp" class="sr">Code</label>
<input id="otp" class="otp" type="text" autocomplete="one-time-code" inputmode="numeric" maxlength="8" placeholder="Code" required>
<button class="key" type="submit">Continue</button>
<p class="small"><button id="resend" class="text" type="button">Send a new code</button> · <button id="restart" class="text" type="button">Use another email</button></p>
</form>
<form id="more" class="step" hidden novalidate>
<label id="username-label" for="username" class="sr">Your @handle</label>
<div id="handle" class="handle" hidden><span aria-hidden="true">@</span><input id="username" type="text" autocomplete="username" autocapitalize="none" autocorrect="off" spellcheck="false" maxlength="32" placeholder="yourname"></div>
<div id="ideas" class="ideas" hidden></div>
<label id="password-label" for="password">Password</label>
<input id="password" type="password" autocomplete="new-password" hidden>
<button id="finish" class="key" type="submit">Finish</button>
</form>
<div id="confirm" class="step" hidden>
<p>Only continue if you just chose Sign in on your own Mac. If someone sent you this link, close this page.</p>
<button id="link" class="key" type="button">Link my Mac</button>
<p class="small"><span id="who"></span> <button id="switch" class="text" type="button">Use another account</button></p>
</div>`,
    scripts
  );
}
