/**
 * The onboarding line: its order, Back, where a launch resumes, and what
 * every check says when it passes or fails. A failed check always
 * names the one fix; nothing here is ever a silent "try again".
 */
import { beforeEach, describe, expect, it } from 'vitest';
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
  FLOW_STORAGE_KEY,
  type CheckResult,
} from './onboardingFlow';
import type { SetupItem } from './setup';

const failed = (r: CheckResult) => {
  expect(r.state).toBe('fail');
  return r as Extract<CheckResult, { state: 'fail' }>;
};

describe('the line', () => {
  it('is two screens, Welcome then the engine; after the engine is the Chief’s chat', () => {
    expect(FLOW_STEPS).toEqual(['welcome', 'engine']);
    expect(nextStep('welcome')).toBe('engine');
    expect(nextStep('engine')).toBeNull();
  });

  it('Back goes one screen back', () => {
    expect(prevStep('welcome')).toBeNull();
    expect(prevStep('engine')).toBe('welcome');
  });

  it('shows three parts, the last being where it leads', () => {
    expect(progressOf('welcome')).toEqual({ section: 1, sections: 3 });
    expect(progressOf('engine')).toEqual({ section: 2, sections: 3 });
    expect(FLOW_SECTIONS[2]).toBe('chief');
    expect(sectionOf('engine')).toBe('engine');
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
