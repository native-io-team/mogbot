/**
 * Signing in on the Mac's Chrome from the phone: the screen's states, the
 * tap maths, and what one Type press sends. What's typed never enters the
 * view state; secure entry only marks the send.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SigninBegun, SigninFrame } from '@shipstudio/companion-protocol';
import {
  canAct,
  canFallBack,
  canHandBack,
  doneLabel,
  handedBackLine,
  isStepIn,
  ENDED_WORDS,
  frameGap,
  FRAME_GAP_MS,
  viaLabel,
  beginTimeoutMessage,
  BEGIN_TIMEOUT_MS,
  retryWays,
  withTimeout,
  endsIt,
  initialView,
  reduce,
  shownHeight,
  signinRouteProblem,
  statusLine,
  toFramePoint,
  typeInput,
  type SigninEvent,
  type SigninView,
} from '../src/lib/signinView';

const begun: SigninBegun = {
  sessionId: 'signin_1',
  domain: 'figma.com',
  title: 'Figma',
  idleSeconds: 300,
};
const page: SigninFrame = {
  state: 'live',
  host: 'www.figma.com',
  image: '/9j/2w==',
  width: 1000,
  height: 640,
};
const run = (...events: SigninEvent[]) => events.reduce(reduce, initialView);

describe('the sign-in screen', () => {
  it('starts, goes live on the first picture, and only then takes input', () => {
    expect(statusLine(initialView)).toMatch(/Opening it on your Mac/);
    const opened = run({ t: 'begun', begun });
    expect(opened.phase).toBe('live');
    expect(canAct(opened)).toBe(false);
    const live = reduce(opened, { t: 'frame', frame: page });
    expect(canAct(live)).toBe(true);
    expect(statusLine(live)).toBeNull();
  });

  it('shows nothing and allows only Back outside the sign-in', () => {
    const out = run(
      { t: 'begun', begun },
      { t: 'frame', frame: { state: 'outside', host: 'example.com', width: 0, height: 0 } }
    );
    expect(canAct(out)).toBe(false);
    expect(statusLine(out)).toMatch(/outside the sign-in \(example\.com\).*Go back/);
  });

  it('Done: checking, then still signed out, then signed in and over', () => {
    const live = run({ t: 'begun', begun }, { t: 'frame', frame: page });
    const checking = reduce(live, { t: 'checking' });
    expect(canAct(checking)).toBe(false);
    expect(statusLine(checking)).toMatch(/Checking/);
    const still = reduce(checking, { t: 'outcome', outcome: 'signed_out' });
    expect(canAct(still)).toBe(true);
    expect(statusLine(still)).toMatch(/still asking you to sign in/);
    const unsure = reduce(still, { t: 'outcome', outcome: 'unknown' });
    expect(statusLine(unsure)).toMatch(/hand it over anyway/);
    const done = reduce(reduce(unsure, { t: 'checking' }), { t: 'outcome', outcome: 'signed_in' });
    expect(done).toMatchObject({ phase: 'ended', reason: 'signed_in', domain: 'figma.com' });
    // Over is over: a late picture or answer changes nothing.
    expect(reduce(done, { t: 'frame', frame: page })).toBe(done);
    expect(reduce(done, { t: 'begun', begun })).toBe(done);
  });

  it('ends when the Mac says it has (idle, stopped there, another phone)', () => {
    for (const words of ENDED_WORDS) expect(endsIt(`Protocol: ${words}`)).toBe(true);
    expect(endsIt('That didn’t reach Chrome on your Mac.')).toBe(false);
    const ended = run(
      { t: 'begun', begun },
      { t: 'end', reason: 'ended', message: ENDED_WORDS[2] }
    );
    expect(ended).toMatchObject({ phase: 'ended', domain: 'figma.com' });
    expect(statusLine(ended)).toBe(ENDED_WORDS[2]);
  });

  it('uses the Mac’s own words for an ended sign-in', () => {
    const rust = readFileSync(
      join(__dirname, '..', '..', 'src-tauri', 'src', 'agents', 'phone_signin.rs'),
      'utf8'
    );
    for (const words of ENDED_WORDS) expect(rust).toContain(`"${words}"`);
  });

  it('a starting screen that fails ends, with the Mac’s reason', () => {
    const failed = reduce(initialView, {
      t: 'end',
      reason: 'failed',
      message: 'Chrome on your Mac isn’t answering.',
    });
    expect(failed).toEqual({
      phase: 'ended',
      reason: 'failed',
      message: 'Chrome on your Mac isn’t answering.',
      domain: undefined,
      retry: true,
    });
  });

  it('a failed start offers Try again and the agents’ browser, and starts over', () => {
    const failed = reduce(initialView, {
      t: 'end',
      reason: 'failed',
      message: "Chrome on your Mac isn't answering. It needs to be open there with Claude in Chrome on.",
    });
    expect(retryWays(failed)).toEqual([
      { label: 'Try again' },
      { label: 'Try the agents’ browser', way: 'agents_browser' },
    ]);
    expect(reduce(failed, { t: 'retry' })).toBe(initialView);
    // The Mac said the agents' browser isn't there: only Try again.
    const off = reduce(initialView, {
      t: 'end',
      reason: 'failed',
      message: "The agents' browser isn't on on this Mac (Settings → Agents), or Google Chrome isn't installed there.",
    });
    expect(retryWays(off)).toEqual([{ label: 'Try again' }]);
    // A session that ended after it was live isn't restarted from here.
    const ended = run({ t: 'begun', begun }, { t: 'end', reason: 'ended', message: 'x' });
    expect(retryWays(ended)).toEqual([]);
    expect(reduce(ended, { t: 'retry' })).toBe(ended);
    // A retry while live does nothing.
    const live = run({ t: 'begun', begun });
    expect(reduce(live, { t: 'retry' })).toBe(live);
  });

  it('starting never outlasts the phone’s own limit', async () => {
    jest.useFakeTimers();
    try {
      const never = new Promise<never>(() => {});
      const p = withTimeout(never, BEGIN_TIMEOUT_MS, beginTimeoutMessage());
      jest.advanceTimersByTime(BEGIN_TIMEOUT_MS);
      await expect(p).rejects.toThrow(beginTimeoutMessage());
      // Inside the socket's 30s, after the Mac's own 20s.
      expect(BEGIN_TIMEOUT_MS).toBeGreaterThan(20_000);
      expect(BEGIN_TIMEOUT_MS).toBeLessThan(30_000);
      await expect(withTimeout(Promise.resolve(1), 10, 'x')).resolves.toBe(1);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('step in from the phone', () => {
  const stepBegun: SigninBegun = {
    sessionId: 'signin_2',
    domain: 'okta.com',
    title: 'approve the Okta sign-in',
    idleSeconds: 300,
    via: 'agents_browser',
    stepIn: true,
  };
  const live = (frame: SigninFrame) =>
    reduce(reduce(initialView, { t: 'begun', begun: stepBegun }), { t: 'frame', frame });

  it('Done is Hand back, and it can hand back even outside the step', () => {
    expect(doneLabel(true)).toBe('Hand back');
    expect(doneLabel(false)).toBe('Done');
    const outside = live({ state: 'outside', host: 'app.example', width: 0, height: 0 });
    expect(isStepIn(outside)).toBe(true);
    expect(canAct(outside)).toBe(false);
    expect(canHandBack(outside)).toBe(true);
    expect(statusLine(outside)).toMatch(/outside this step \(app\.example\).*Hand back/);
  });

  it('hands back and ends with what the agent saw', () => {
    let v = live(page);
    v = reduce(v, { t: 'checking' });
    expect(statusLine(v)).toBe('Handing it back…');
    expect(canHandBack(v)).toBe(false);
    v = reduce(v, { t: 'outcome', outcome: 'handed_back' });
    expect(v).toMatchObject({ phase: 'ended', reason: 'handed_back', domain: 'okta.com' });
    expect(statusLine(v)).toBe(handedBackLine('okta.com'));
    expect(handedBackLine('okta.com')).toMatch(/never saw what you typed/);
  });

  it('a failed start offers only Try again: it is always the agent’s own tab', () => {
    const failed = reduce(initialView, { t: 'end', reason: 'failed', message: 'Busy.' });
    expect(retryWays(failed, true)).toEqual([{ label: 'Try again' }]);
    expect(retryWays(failed).length).toBe(2);
  });
});

describe('secure entry', () => {
  const secret = 'correct-horse-battery-staple';

  it('marks the send, and sends the text once, as it is', () => {
    expect(typeInput(secret, true)).toEqual({ kind: 'type', text: secret, secure: true });
    expect(typeInput('sam@example.com', false)).toEqual({ kind: 'type', text: 'sam@example.com' });
  });

  it('is a flag in the state, never the text', () => {
    let v: SigninView = run({ t: 'begun', begun }, { t: 'frame', frame: page });
    v = reduce(v, { t: 'secure', on: true });
    expect(v).toMatchObject({ phase: 'live', secure: true });
    // Every event the screen can send holds no text field: what's typed
    // stays in the screen's ref.
    const events: SigninEvent[] = [
      { t: 'note', message: 'That didn’t reach Chrome on your Mac.' },
      { t: 'checking' },
      { t: 'outcome', outcome: 'signed_out' },
      { t: 'secure', on: false },
    ];
    for (const e of events) v = reduce(v, e);
    expect(JSON.stringify(v)).not.toContain(secret);
  });
});

describe('taps', () => {
  it('land in the frame’s pixels whatever size the picture is shown at', () => {
    const shown = { width: 400, height: shownHeight(400, page) };
    expect(shown.height).toBe(256);
    expect(toFramePoint({ x: 200, y: 128 }, shown, page)).toEqual({ x: 500, y: 320 });
    expect(toFramePoint({ x: 0, y: 0 }, shown, page)).toEqual({ x: 0, y: 0 });
    expect(toFramePoint({ x: 401, y: 10 }, shown, page)).toBeNull();
    expect(toFramePoint({ x: -1, y: 10 }, shown, page)).toBeNull();
    expect(toFramePoint({ x: 1, y: 1 }, { width: 0, height: 0 }, page)).toBeNull();
  });
});

describe('the connection', () => {
  it('carries a sign-in only when a secret could go, said in its own words', () => {
    expect(signinRouteProblem(null, { kind: 'tailscale' })).toBeNull();
    expect(signinRouteProblem('x', null)).toMatch(/isn’t connected/);
    expect(signinRouteProblem('x', { kind: 'lan' })).toMatch(/only works over Tailscale/);
    expect(signinRouteProblem('x', { kind: 'tailscale' })).toMatch(/hasn’t proved/);
  });
});

describe('the agents’ browser', () => {
  const agents: SigninBegun = { ...begun, via: 'agents_browser', frameGapMs: 30 };

  it('names where the picture comes from, an older Mac being its Chrome', () => {
    const v = run({ t: 'begun', begun: agents });
    expect(v).toMatchObject({ phase: 'live', via: 'agents_browser' });
    expect(viaLabel('agents_browser')).toBe('The agents’ browser on your Mac');
    expect(viaLabel('chrome')).toBe('Chrome on your Mac');
    // Still opening, the Mac hasn't named a browser: none is claimed.
    expect(viaLabel(undefined)).toBe('Your Mac');
    expect(run({ t: 'begun', begun })).toMatchObject({ via: 'chrome' });
  });

  it('asks for pictures as fast as the Mac says, else about three a second', () => {
    expect(frameGap(run({ t: 'begun', begun: agents }))).toBe(30);
    expect(frameGap(run({ t: 'begun', begun }))).toBe(FRAME_GAP_MS);
    expect(frameGap(initialView)).toBe(FRAME_GAP_MS);
  });

  it('hides what’s typed while the page’s focused field is a password', () => {
    let v = run({ t: 'begun', begun: agents }, { t: 'frame', frame: { ...page, seq: 1 } });
    expect(v).toMatchObject({ secure: false });
    v = reduce(v, { t: 'frame', frame: { ...page, seq: 2, secure: true } });
    expect(v).toMatchObject({ secure: true });
    // Turning it off can't show a password field's text.
    v = reduce(v, { t: 'secure', on: false });
    expect(v).toMatchObject({ secure: true });
    // Off the field: back to what the person chose.
    v = reduce(v, { t: 'frame', frame: { ...page, seq: 3 } });
    expect(v).toMatchObject({ secure: false });
    v = reduce(v, { t: 'secure', on: true });
    v = reduce(v, { t: 'frame', frame: { ...page, seq: 4 } });
    expect(v).toMatchObject({ secure: true });
  });

  it('a site that refuses the window offers another way, and the way changes', () => {
    const blocked: SigninFrame = {
      ...page,
      state: 'blocked',
      seq: 5,
      blocked: 'Google won’t sign in to a browser the app is driving.',
    };
    const v = run({ t: 'begun', begun: agents }, { t: 'frame', frame: blocked });
    expect(canAct(v)).toBe(false);
    expect(canFallBack(v)).toBe(true);
    expect(statusLine(v)).toMatch(/Google won’t.*Sign in another way below/);
    const switching = reduce(v, { t: 'switching' });
    expect(canFallBack(switching)).toBe(false);
    expect(statusLine(switching)).toMatch(/plain Chrome window/);
    const plain = reduce(switching, {
      t: 'switched',
      begun: { ...agents, via: 'mac_window', frameGapMs: 150 },
    });
    expect(plain).toMatchObject({ via: 'mac_window', frame: null, switching: false });
    expect(frameGap(plain)).toBe(150);
    // Shown again in the plain window: input works there.
    expect(canAct(reduce(plain, { t: 'frame', frame: { ...page, seq: 1 } }))).toBe(true);
    // The Mac said it can't: its words, and the screen stays.
    const refused = reduce(switching, {
      t: 'note',
      message: 'Google needs one sign-in at the Mac.',
    });
    expect(refused).toMatchObject({ phase: 'live', switching: false });
    expect(statusLine(refused)).toMatch(/Google won’t/);
  });

  it('Chrome’s own card never offers a fallback', () => {
    const v = run({ t: 'begun', begun }, { t: 'frame', frame: { ...page, state: 'blocked' } });
    expect(canFallBack(v)).toBe(false);
  });
});
