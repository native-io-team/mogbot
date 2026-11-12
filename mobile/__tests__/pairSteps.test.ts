/**
 * Pairing on the phone is one straight line of one-question screens, in
 * the same order and words the Mac walks from its side.
 */

import {
  CLICK_PAIR_TITLE,
  PAIR_WHERE,
  PAIR_YOUR_PHONE,
  SCAN_LINE,
  SCAN_THE_CODE,
} from '@shipstudio/companion-protocol';
import {
  INTRO_STEPS,
  introSteps,
  nextIntro,
  pairStages,
  PAIR_STAGES,
  prevIntro,
  progressOf,
  stageOf,
  startStep,
} from '../src/lib/pairSteps';

describe('pairSteps', () => {
  it('walks mac → tailscale → code, then the camera', () => {
    expect([...INTRO_STEPS]).toEqual(['mac', 'tailscale', 'code']);
    expect(nextIntro('mac')).toBe('tailscale');
    expect(nextIntro('tailscale')).toBe('code');
    expect(nextIntro('code')).toBeNull();
    expect(prevIntro('mac')).toBeNull();
    expect(prevIntro('code')).toBe('tailscale');
  });

  it('treats "Not yet" as the first question still, and goes on to Tailscale', () => {
    expect(stageOf('getMac')).toBe('mac');
    expect(prevIntro('getMac')).toBe('mac');
    expect(nextIntro('getMac')).toBe('tailscale');
  });

  it('counts the camera and both answers on the bar', () => {
    expect(PAIR_STAGES.length).toBe(6);
    expect(progressOf('mac')).toEqual({ n: 1, of: 6 });
    expect(progressOf('allow')).toEqual({ n: 6, of: 6 });
  });

  it('resumes where it stopped, and skips what a paired phone has done', () => {
    expect(startStep(null, false)).toBe('mac');
    expect(startStep('tailscale', false)).toBe('tailscale');
    expect(startStep(null, true)).toBe('code');
    expect(startStep('tailscale', true)).toBe('code');
  });

  // docs/relay.md: through the relay the phone needs no Tailscale to pair.
  it('with a relay, passes over the Tailscale screen: mac → code, one fewer on the bar', () => {
    expect([...introSteps(true)]).toEqual(['mac', 'code']);
    expect([...introSteps(false)]).toEqual(['mac', 'tailscale', 'code']);
    expect(nextIntro('mac', true)).toBe('code');
    expect(nextIntro('getMac', true)).toBe('code');
    expect(nextIntro('code', true)).toBeNull();
    expect(prevIntro('code', true)).toBe('mac');
    expect(pairStages(true)).toEqual(['mac', 'code', 'scan', 'pair', 'allow']);
    expect(progressOf('mac', true)).toEqual({ n: 1, of: 5 });
    expect(progressOf('code', true)).toEqual({ n: 2, of: 5 });
    expect(progressOf('allow', true)).toEqual({ n: 5, of: 5 });
    // Saved on the Tailscale screen by a build without the relay: on to the code.
    expect(startStep('tailscale', false, true)).toBe('code');
    expect(startStep('mac', false, true)).toBe('mac');
    expect(startStep(null, false, true)).toBe('mac');
    // Without a relay, nothing changes.
    expect(startStep('tailscale', false, false)).toBe('tailscale');
    expect(progressOf('code', false)).toEqual({ n: 3, of: 6 });
  });

  it('names the Mac’s own button, and the Mac names the phone’s', () => {
    expect(CLICK_PAIR_TITLE).toContain(PAIR_YOUR_PHONE);
    expect(CLICK_PAIR_TITLE).toContain(PAIR_WHERE);
    expect(SCAN_LINE).toContain(SCAN_THE_CODE);
  });
});
