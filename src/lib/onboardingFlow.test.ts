/**
 * The onboarding line: its order, Back, where a launch resumes, and what
 * every check says when it passes or fails. A failed check always
 * names the one fix; nothing here is ever a silent "try again".
 */
import { beforeEach, describe, expect, it, afterEach } from 'vitest';
import { overrideRelayForHarness } from './brand';
import {
  FLOW_SECTIONS,
  FLOW_STEPS,
  engineItemCheck,
  engineItemCopy,
  engineScreens,
  isOnboardingInProgress,
  nextStep,
  prevStep,
  progressOf,
  readProgress,
  resumeStep,
  saveProgress,
  sectionOf,
  skipPart,
  FLOW_STORAGE_KEY,
  assistantConnected,
  firstAgentsStep,
  linkCheckFor,
  linkIsOn,
  readAssistantChoice,
  saveAssistantChoice,
  type CheckResult,
} from './onboardingFlow';
import type { SetupItem } from './setup';
import { remoteProblem, type RemoteAccessStatus } from './remoteAccess';

// These tests read the Tailscale path (a build with no relay); the relay's own tests opt in.
beforeEach(() => overrideRelayForHarness(false));
afterEach(() => overrideRelayForHarness(null));

const remote = (over: Partial<RemoteAccessStatus> = {}): RemoteAccessStatus => ({
  supported: true,
  enabled: true,
  serverRunning: true,
  tailscale: { state: 'connected', dnsName: 'm.tail1.ts.net' },
  funnelOn: true,
  funnelApprovalUrl: null,
  funnelError: null,
  linkMasked: 'https://m.tail1.ts.net/mogbot/mcp/3f9c••••',
  reachability: { state: 'reachable' },
  publish: { sinceMs: null, autoRetried: false, gaveUp: false },
  power: { hasBattery: false, onAc: true, batteryPercent: null, charging: null },
  keepAwake: true,
  lidClosedMode: null,
  openAtLogin: false,
  openAtLoginAvailable: true,
  pushPin: 'notSet',
  projects: [],
  everConnected: false,
  activity: { lastRequestMs: null, lastClient: null, rejectedRequests: 0 },
  ...over,
});

describe('Your agents', () => {
  beforeEach(() => window.localStorage.clear());

  it('remembers which assistant was picked, and nothing else', () => {
    expect(readAssistantChoice()).toBeNull();
    saveAssistantChoice('grok');
    expect(readAssistantChoice()).toBe('grok');
    window.localStorage.setItem('shipstudio.onboarding.assistant', 'gemini');
    expect(readAssistantChoice()).toBeNull();
  });

  it('a pick goes straight past what is already true', () => {
    const now = Date.now();
    expect(firstAgentsStep(null, now)).toBe('agentsTailscale');
    expect(firstAgentsStep(remote({ tailscale: { state: 'notInstalled' } }), now)).toBe(
      'agentsTailscale'
    );
    expect(firstAgentsStep(remote({ enabled: false, linkMasked: null }), now)).toBe('agentsLink');
    expect(firstAgentsStep(remote(), now)).toBe('agentsConnect');
    expect(firstAgentsStep(remote({ everConnected: true }), now, 'claude')).toBe('agentsStart');
    // Grok connected before, Claude picked now: Claude's steps still show.
    const grokWas = remote({
      everConnected: true,
      activity: { lastRequestMs: now, lastClient: 'grok', rejectedRequests: 0 },
    });
    expect(firstAgentsStep(grokWas, now, 'claude')).toBe('agentsConnect');
    expect(firstAgentsStep(grokWas, now, 'grok')).toBe('agentsStart');
  });

  it('an unrecognised client never holds the tick back', () => {
    const s = remote({
      everConnected: true,
      activity: { lastRequestMs: 1, lastClient: 'my-custom-client', rejectedRequests: 0 },
    });
    expect(assistantConnected(s, 'chatgpt')).toBe(true);
    expect(assistantConnected(remote(), 'chatgpt')).toBe(false);
  });

  it('a link still going public is enough to add it; a stuck one is not', () => {
    const now = Date.now();
    const going = remote({
      reachability: { state: 'noPublicDns' },
      publish: { sinceMs: now - 30_000, autoRetried: false, gaveUp: false },
    });
    expect(linkIsOn(going, now)).toBe(true);
    expect(linkIsOn({ ...going, publish: { ...going.publish, gaveUp: true } }, now)).toBe(false);
  });

  it('Tailscale’s one-time approval is the user’s move: neutral, never “Not done yet”', () => {
    const s = remote({
      linkMasked: null,
      reachability: null,
      funnelApprovalUrl: 'https://login.tailscale.com/f/funnel?node=n1',
    });
    const link = linkCheckFor(remoteProblem(s, 0));
    expect(link).toMatchObject({
      kind: 'approve',
      url: 'https://login.tailscale.com/f/funnel?node=n1',
      check: { state: 'waiting' },
    });
  });

  it('off is the big button alone; a real failure keeps its one fix', () => {
    expect(linkCheckFor(remoteProblem(remote({ enabled: false, linkMasked: null }), 0))).toEqual({
      kind: 'off',
    });
    const https = linkCheckFor(
      remoteProblem(
        remote({
          linkMasked: null,
          reachability: null,
          funnelError: 'HTTPS must be enabled',
          funnelProblem: { kind: 'httpsOff' },
        }),
        0
      )
    );
    expect(https).toMatchObject({
      kind: 'check',
      check: { state: 'fail', action: { label: 'Open DNS settings' } },
      fix: { kind: 'turnOn', label: 'Try again' },
    });
    const stuck = linkCheckFor(
      remoteProblem(
        remote({
          reachability: { state: 'noPublicDns' },
          publish: { sinceMs: 0, autoRetried: true, gaveUp: true },
        }),
        0
      )
    );
    expect(stuck).toMatchObject({ kind: 'check', fix: { kind: 'republish' } });
    expect(linkCheckFor(remoteProblem(remote(), 0))).toMatchObject({
      check: { state: 'pass' },
    });
  });
});

const failed = (r: CheckResult) => {
  expect(r.state).toBe('fail');
  return r as Extract<CheckResult, { state: 'fail' }>;
};

describe('the line', () => {
  it('walks the engine, then your agents, then your phone; after the last is the Chief’s chat', () => {
    // "Sign in?" (`account`) is passed over in a build with no relay, as this one is.
    expect(FLOW_STEPS.slice(0, 4)).toEqual(['welcome', 'account', 'engine', 'agentsAsk']);
    expect(nextStep('welcome')).toBe('engine');
    expect(nextStep('engine')).toBe('agentsAsk');
    expect(nextStep('agentsStart')).toBe('phoneAsk');
    expect(nextStep('phonePaired')).toBeNull();
  });

  it('with the relay: Welcome, then "Sign in?", then the engine, and no Tailscale screens for the phone', () => {
    overrideRelayForHarness(true);
    expect(nextStep('welcome')).toBe('account');
    expect(nextStep('account')).toBe('engine');
    expect(nextStep('phoneGetApp')).toBe('phoneAccess');
    expect(prevStep('phoneAccess')).toBe('phoneGetApp');
  });

  it('Back goes one screen back; an optional part’s question goes back to the one before', () => {
    expect(prevStep('welcome')).toBeNull();
    expect(prevStep('engine')).toBe('welcome');
    expect(prevStep('agentsAsk')).toBe('engine');
    expect(prevStep('phoneAsk')).toBe('agentsAsk');
    expect(prevStep('phoneAllow')).toBe('phoneScan');
    expect(prevStep('phonePaired')).toBe('phoneScan');
  });

  it('Not now and Skip for now go on to the next part, then the Chief’s chat', () => {
    expect(skipPart('agentsAsk')).toBe('phoneAsk');
    expect(skipPart('agentsConnect')).toBe('phoneAsk');
    expect(skipPart('phoneAsk')).toBeNull();
    expect(skipPart('phoneScan')).toBeNull();
  });

  it('shows three parts: welcome, the engine, then the Chief’s chat where the rest happens', () => {
    expect(progressOf('welcome')).toEqual({ section: 1, sections: 3, within: 0 });
    expect(progressOf('engine').section).toBe(2);
    expect(FLOW_SECTIONS).toEqual(['welcome', 'engine', 'chief']);
    expect(sectionOf('engine')).toBe('engine');
    expect(sectionOf('agentsLink')).toBe('agents');
    expect(sectionOf('phoneScan')).toBe('phone');
  });

  it('a relaunch saved on a screen first run no longer shows goes to the engine, then the chat', () => {
    expect(resumeStep({ v: 1, step: 'phoneAllow', finished: false })).toBe('engine');
    expect(resumeStep({ v: 1, step: 'agentsLink', finished: false })).toBe('engine');
    expect(resumeStep({ v: 1, step: 'welcome', finished: false })).toBe('welcome');
  });
});

describe('resuming', () => {
  beforeEach(() => localStorage.clear());

  it('opens where it stopped, and says onboarding is unfinished until the end', () => {
    expect(readProgress()).toBeNull();
    expect(isOnboardingInProgress()).toBe(false);
    saveProgress('engine');
    expect(readProgress()).toEqual({ v: 1, step: 'engine', finished: false });
    expect(isOnboardingInProgress()).toBe(true);
    expect(resumeStep(readProgress())).toBe('engine');
    saveProgress('engine', true);
    expect(isOnboardingInProgress()).toBe(false);
    expect(resumeStep(readProgress())).toBe('welcome');
  });

  it('a launch saved on a screen an older build had (all after the engine) is finished', () => {
    for (const retired of [
      'accounts',
      'independence',
      'phone',
      'tailscaleMac',
      'phonePair',
      'ready',
      'importConnect',
    ]) {
      localStorage.setItem(FLOW_STORAGE_KEY, JSON.stringify({ v: 1, step: retired }));
      expect(readProgress()).toEqual({ v: 1, step: 'engine', finished: true });
      expect(isOnboardingInProgress()).toBe(false);
    }
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
    // The tools it installs are named before anything asks for a password.
    expect(engineItemCopy('homebrew', codex).lede).toMatch(/Homebrew and Node\.js/);
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

  it('a network failure asks to check the Mac is online, not to reopen the app', () => {
    const offline = failed(
      engineItemCheck(
        item('claude', 'error', 'Couldn’t reach the download server (network timeout).'),
        false
      )!
    );
    expect(offline.fix).toMatch(/^Check this Mac is online/);
    expect(offline.fix).not.toMatch(/reopen/);
    const other = failed(engineItemCheck(item('codex', 'error', 'npm failed'), false)!);
    expect(other.fix).toMatch(/reopen the app/);
  });

  it('a window closed before it finished says so, never a silent screen', () => {
    // Not started yet: no line at all, just the big button.
    expect(engineItemCheck(item('codex_auth', 'not_installed'), true, false)).toBeNull();
    const signIn = failed(engineItemCheck(item('codex_auth', 'not_installed'), true, true)!);
    expect(signIn.line).toBe('Sign-in was closed before it finished.');
    expect(signIn.fix).toMatch(/^Already signed in in the browser\?/);
    const install = failed(engineItemCheck(item('codex', 'not_installed'), false, true)!);
    expect(install.line).toBe('The install was closed before it finished.');
    // Try again is the screen's own button; a line repeating it says nothing.
    expect(install.fix).toBeUndefined();
    // What the app found always wins over "it was closed".
    expect(engineItemCheck(item('codex_auth', 'ready'), true, true)?.state).toBe('pass');
    expect(engineItemCheck(item('codex', 'error', 'npm failed'), false, true)).toMatchObject({
      line: 'npm failed',
    });
  });
});
