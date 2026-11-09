/**
 * The onboarding line: its order, Back, Skip, where a launch resumes, and
 * what every check says when it passes or fails. A failed check always
 * names the one fix; nothing here is ever a silent "try again".
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  FLOW_STEPS,
  assistantCheck,
  engineItemCheck,
  engineItemCopy,
  engineScreens,
  importTalkCheck,
  isOnboardingInProgress,
  nextStep,
  pairStage,
  prevStep,
  progressOf,
  readProgress,
  remoteOnCheck,
  resumeStep,
  saveProgress,
  sectionOf,
  skipPhone,
  tailscaleMacCheck,
  tailscalePhoneCheck,
  FLOW_STORAGE_KEY,
  type CheckResult,
} from './onboardingFlow';
import type { PhoneStatus } from './companion';
import type { RemoteAccessStatus } from './remoteAccess';
import type { ImportTalk } from './agents';
import type { SetupItem } from './setup';

const failed = (r: CheckResult) => {
  expect(r.state).toBe('fail');
  return r as Extract<CheckResult, { state: 'fail' }>;
};

describe('the line', () => {
  it('walks every screen in order, with the phone ending on Ready', () => {
    const walked: string[] = ['welcome'];
    let step = nextStep('welcome');
    while (step) {
      walked.push(step);
      step = nextStep(step);
    }
    expect(walked).toEqual([
      'welcome',
      'engine',
      'accounts',
      'independence',
      'phone',
      'tailscaleMac',
      'tailscalePhone',
      'phoneApp',
      'phonePair',
      'ready',
    ]);
    // The import is a branch off Ready, and its own end.
    expect(nextStep('importRemote')).toBe('importConnect');
    expect(nextStep('importConnect')).toBe('importStart');
    expect(nextStep('importStart')).toBeNull();
  });

  it('Back goes one screen back; Ready goes back to the phone question', () => {
    expect(prevStep('welcome')).toBeNull();
    expect(prevStep('engine')).toBe('welcome');
    expect(prevStep('accounts')).toBe('engine');
    expect(prevStep('independence')).toBe('accounts');
    expect(prevStep('tailscalePhone')).toBe('tailscaleMac');
    expect(prevStep('ready')).toBe('phone');
    expect(prevStep('importRemote')).toBe('ready');
    expect(prevStep('importStart')).toBe('importConnect');
    expect(skipPhone()).toBe('ready');
  });

  it('shows five parts, and "2 of 4" inside the phone and the import', () => {
    expect(progressOf('welcome')).toEqual({ section: 1, sections: 5, sub: null });
    expect(progressOf('independence').section).toBe(3);
    // Another account is part of "Your AI", not a part of its own.
    expect(progressOf('accounts')).toEqual({ section: 2, sections: 5, sub: null });
    expect(progressOf('tailscalePhone')).toEqual({
      section: 4,
      sections: 5,
      sub: { index: 2, total: 4 },
    });
    expect(progressOf('importStart')).toEqual({
      section: 5,
      sections: 5,
      sub: { index: 3, total: 3 },
    });
    for (const step of FLOW_STEPS) expect(progressOf(step).section).toBeGreaterThan(0);
    expect(sectionOf('phonePair')).toBe('phone');
    expect(sectionOf('importConnect')).toBe('ready');
  });
});

describe('resuming', () => {
  beforeEach(() => localStorage.clear());

  it('opens where it stopped, and says onboarding is unfinished until the end', () => {
    expect(readProgress()).toBeNull();
    expect(isOnboardingInProgress()).toBe(false);
    saveProgress('tailscalePhone');
    expect(readProgress()).toEqual({ v: 1, step: 'tailscalePhone', finished: false });
    expect(isOnboardingInProgress()).toBe(true);
    expect(resumeStep(readProgress(), true)).toBe('tailscalePhone');
    saveProgress('ready', true);
    expect(isOnboardingInProgress()).toBe(false);
    expect(resumeStep(readProgress(), true)).toBe('welcome');
  });

  it('goes back to the engine when it was signed out since', () => {
    saveProgress('phonePair');
    expect(resumeStep(readProgress(), false)).toBe('engine');
    saveProgress('engine');
    expect(resumeStep(readProgress(), false)).toBe('engine');
  });

  it('only stopping past the welcome counts, and junk reads as nothing saved', () => {
    saveProgress('welcome');
    expect(isOnboardingInProgress()).toBe(false);
    localStorage.setItem(FLOW_STORAGE_KEY, '{"v":1,"step":"nowhere"}');
    expect(readProgress()).toBeNull();
    localStorage.setItem(FLOW_STORAGE_KEY, 'not json');
    expect(readProgress()).toBeNull();
  });
});

describe('the engine screens', () => {
  const item = (id: string, status: SetupItem['status'], errorMessage?: string): SetupItem => ({
    id,
    friendlyName: id === 'codex' ? 'Codex' : id,
    status,
    errorMessage,
  });

  it('Codex on a bare Mac gets the Mac ready first; Claude Code is install then sign in', () => {
    const bare = ['homebrew', 'node', 'codex', 'codex_auth', 'claude', 'claude_auth'].map((id) =>
      item(id, 'not_installed')
    );
    expect(engineScreens('codex', bare)).toEqual(['homebrew', 'node', 'codex', 'codex_auth']);
    expect(engineScreens('claude', bare)).toEqual(['claude', 'claude_auth']);
  });

  it('each screen has one title and one action; its check is the app’s own', () => {
    const codex = { binaryId: 'codex', name: 'Codex', account: 'ChatGPT Plus or Pro' };
    expect(engineItemCopy('codex', codex).action).toBe('Install Codex');
    expect(engineItemCopy('codex_auth', codex).title).toBe('Sign in to Codex');
    expect(engineItemCopy('node', codex).title).toBe('Get your Mac ready for Codex');
    expect(engineItemCheck(item('codex', 'not_installed'), false)).toBeNull();
    expect(engineItemCheck(item('codex', 'in_progress'), false)?.state).toBe('checking');
    expect(engineItemCheck(item('codex', 'ready'), false)).toEqual({
      state: 'pass',
      line: 'Codex is installed.',
    });
    const fail = failed(engineItemCheck(item('codex', 'error', 'npm failed'), false)!);
    expect(fail.line).toBe('npm failed');
    expect(fail.fix).toMatch(/Try again/);
  });
});

describe('Tailscale checks', () => {
  it('this Mac: done only when signed in and on; each failure names the fix', () => {
    expect(tailscaleMacCheck(null).state).toBe('checking');
    expect(
      tailscaleMacCheck({ state: 'connected', dnsName: 'mac.t.ts.net', login: 'sam@example.com' })
    ).toEqual({ state: 'pass', line: 'Tailscale is on, signed in as sam@example.com.' });
    const missing = failed(tailscaleMacCheck({ state: 'notInstalled' }));
    expect(missing.action?.url).toBe('https://tailscale.com/download/mac');
    expect(failed(tailscaleMacCheck({ state: 'needsLogin' })).fix).toMatch(/sign in/);
    expect(failed(tailscaleMacCheck({ state: 'unknown', detail: 'boom' })).line).toContain('boom');
  });

  it('your phone: a phone on the same account with Tailscale on', () => {
    const mac = { state: 'connected' as const, dnsName: 'mac.t.ts.net', login: 'sam@example.com' };
    expect(tailscalePhoneCheck(mac, null).state).toBe('checking');
    const none = failed(tailscalePhoneCheck(mac, []));
    expect(none.line).toBe('No phone is on your Tailscale yet.');
    expect(none.fix).toContain('sign in as sam@example.com');
    const off = failed(
      tailscalePhoneCheck(mac, [{ name: 'Sam’s iPhone', os: 'ios', online: false }])
    );
    expect(off.line).toContain('switched off');
    expect(
      tailscalePhoneCheck(mac, [
        { name: 'old-ipad', os: 'ios', online: false },
        { name: 'Sam’s iPhone', os: 'ios', online: true },
      ])
    ).toEqual({ state: 'pass', line: 'Sam’s iPhone is on your Tailscale.' });
    expect(failed(tailscalePhoneCheck({ state: 'needsLogin' }, [])).fix).toMatch(/Go back/);
  });
});

const phone = (over: Partial<PhoneStatus> = {}): PhoneStatus => ({
  enabled: true,
  running: true,
  serve: { state: 'on', url: 'https://mac.t.ts.net:47443' },
  tailscale: { state: 'connected', dnsName: 'mac.t.ts.net' },
  devices: [],
  pairing: { active: false },
  activity: {},
  methods: [],
  push: { available: false, enabled: false },
  ...over,
});

describe('pairing', () => {
  it('HTTPS certificates off: the admin page and Check again, never a silent reload', () => {
    const stage = pairStage(
      phone({ serve: { state: 'needsApproval', url: 'https://login.tailscale.com/f/serve' } }),
      []
    );
    expect(stage.kind).toBe('fix');
    if (stage.kind !== 'fix') return;
    expect(stage.retry).toBe(true);
    expect(stage.check.line).toBe('HTTPS certificates are off in your Tailscale account.');
    expect(stage.check.action).toEqual({
      label: 'Open Tailscale admin',
      url: 'https://login.tailscale.com/f/serve',
    });
  });

  it('off or starting is "starting"; on is the code; a request is Allow; a new phone is done', () => {
    expect(pairStage(null, []).kind).toBe('starting');
    expect(pairStage(phone({ enabled: false }), []).kind).toBe('starting');
    expect(pairStage(phone({ serve: { state: 'off' } }), []).kind).toBe('starting');
    expect(pairStage(phone(), []).kind).toBe('code');
    const request = {
      id: 'r1',
      device: {
        name: 'Pixel',
        platform: 'android' as const,
        appVersion: '1',
        build: 'self' as const,
      },
      requestedAt: 1,
      codeHint: 'AB12',
      replaces: [],
    };
    expect(pairStage(phone({ pairing: { active: true, request } }), []).kind).toBe('confirm');
    const device = {
      id: 'dev_new',
      name: 'Pixel',
      platform: 'android',
      appVersion: '1',
      build: 'self',
      pairedAt: 1,
      connected: true,
    } as PhoneStatus['devices'][number];
    expect(pairStage(phone({ devices: [device] }), [])).toEqual({ kind: 'paired', name: 'Pixel' });
    // One paired before this screen opened isn't this pairing.
    expect(pairStage(phone({ devices: [device] }), ['dev_new']).kind).toBe('code');
  });

  it('Tailscale trouble on this Mac or a failed route names it', () => {
    const signedOut = pairStage(phone({ tailscale: { state: 'needsLogin' } }), []);
    expect(signedOut.kind === 'fix' && signedOut.retry).toBe(false);
    const failedRoute = pairStage(
      phone({ serve: { state: 'failed', detail: 'serve: denied' } }),
      []
    );
    expect(failedRoute.kind === 'fix' && failedRoute.check.line).toContain('serve: denied');
  });
});

const remote = (over: Partial<RemoteAccessStatus> = {}): RemoteAccessStatus => ({
  supported: true,
  enabled: true,
  serverRunning: true,
  tailscale: { state: 'connected', dnsName: 'mac.t.ts.net' },
  funnelOn: true,
  funnelApprovalUrl: null,
  funnelError: null,
  linkMasked: 'https://mac.t.ts.net/mogbot/••••',
  reachability: { state: 'reachable' },
  publish: { sinceMs: null, autoRetried: false, gaveUp: false },
  power: { hasBattery: false, onAc: true, batteryPercent: null, charging: null },
  keepAwake: true,
  lidClosedMode: null,
  openAtLogin: true,
  openAtLoginAvailable: true,
  pushPin: 'notSet',
  projects: [],
  everConnected: false,
  activity: { lastRequestMs: null, lastClient: null, rejectedRequests: 0 },
  ...over,
});

describe('the import', () => {
  it('Remote access: done when the internet reached this Mac; Funnel off names the page', () => {
    expect(remoteOnCheck(null, 0).state).toBe('checking');
    expect(remoteOnCheck(remote(), 0).state).toBe('pass');
    expect(remoteOnCheck(remote({ enabled: false }), 0).state).toBe('checking');
    const funnel = failed(
      remoteOnCheck(
        remote({ linkMasked: null, funnelApprovalUrl: 'https://login.tailscale.com/f/funnel' }),
        0
      )
    );
    expect(funnel.action?.url).toBe('https://login.tailscale.com/f/funnel');
    expect(remoteOnCheck(remote({ reachability: null }), 0).state).toBe('checking');
    const stuck = remoteOnCheck(
      remote({ reachability: null, publish: { sinceMs: 0, autoRetried: true, gaveUp: true } }),
      11 * 60_000
    );
    expect(failed(stuck).fix).toMatch(/Check again/);
    expect(failed(remoteOnCheck(remote({ tailscale: { state: 'needsLogin' } }), 0)).fix).toMatch(
      /sign in/
    );
    expect(failed(remoteOnCheck(remote({ supported: false }), 0)).fix).toMatch(/Start fresh/);
  });

  it('the assistant: waits for the copy, then says plainly it hasn’t connected', () => {
    expect(assistantCheck(remote(), false).state).toBe('checking');
    expect(failed(assistantCheck(remote(), true)).fix).toMatch(/custom connector/);
    expect(
      assistantCheck(
        remote({
          everConnected: true,
          activity: { lastRequestMs: 1, lastClient: 'Grok', rejectedRequests: 0 },
        }),
        true
      )
    ).toEqual({ state: 'pass', line: 'Grok is connected.' });
  });

  it('the message: done once the assistant is talking to the Chief', () => {
    expect(importTalkCheck(null, false, false).state).toBe('checking');
    expect(importTalkCheck(null, true, false).state).toBe('checking');
    expect(failed(importTalkCheck(null, true, true)).fix).toMatch(/send it/);
    const talk = { source: 'Grok', state: 'awaiting_consent' } as ImportTalk;
    expect(importTalkCheck(talk, false, true)).toEqual({
      state: 'pass',
      line: 'Grok is talking to your Chief of Staff.',
    });
  });
});
