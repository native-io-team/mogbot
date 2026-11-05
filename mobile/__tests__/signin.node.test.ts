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
  ENDED_WORDS,
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
    expect(statusLine(initialView)).toMatch(/Opening it in Chrome on your Mac/);
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
    });
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
