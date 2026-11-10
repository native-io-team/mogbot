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
  nextIntro,
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

  it('names the Mac’s own button, and the Mac names the phone’s', () => {
    expect(CLICK_PAIR_TITLE).toContain(PAIR_YOUR_PHONE);
    expect(CLICK_PAIR_TITLE).toContain(PAIR_WHERE);
    expect(SCAN_LINE).toContain(SCAN_THE_CODE);
  });
});
