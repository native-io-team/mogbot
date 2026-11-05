import { describe, expect, it } from 'vitest';
import { phoneIndicatorState } from './PhoneIndicator';
import type { PhoneStatus } from '../../lib/companion';
import type { Device } from '../../../packages/companion-protocol/src/model';

const now = 1_000_000_000;
const device = (over: Partial<Device> = {}): Device => ({
  id: 'd1',
  name: 'Julian’s iPhone',
  platform: 'ios',
  appVersion: '1.0.0',
  build: 'official',
  pairedAt: now - 86_400_000,
  connected: false,
  ...over,
});
const status = (over: Partial<PhoneStatus> = {}): PhoneStatus => ({
  enabled: true,
  running: true,
  serve: { state: 'off' },
  tailscale: { state: 'notInstalled' },
  devices: [],
  pairing: { active: false },
  activity: {},
  methods: [],
  push: { available: false, enabled: false },
  ...over,
});

describe('phoneIndicatorState', () => {
  it('invites pairing when no phone is paired', () => {
    expect(phoneIndicatorState(status({ enabled: false }), now)).toMatchObject({
      tone: 'off',
      line: 'Put it on your phone',
      pair: true,
    });
  });

  it('names the phone connected now', () => {
    const s = status({ devices: [device({ connected: true })] });
    expect(phoneIndicatorState(s, now)).toMatchObject({
      tone: 'ok',
      line: 'Julian’s iPhone connected',
    });
  });

  it('says when a paired phone was last seen, and only what was recorded', () => {
    const seen = status({ devices: [device({ lastSeenAt: now - 7_200_000 })] });
    expect(phoneIndicatorState(seen, now).line).toBe('Phone seen 2 h ago');
    expect(phoneIndicatorState(status({ devices: [device()] }), now).line).toBe('Phone paired');
  });

  it('says phone access is off rather than calling a paired phone connected', () => {
    const s = status({ enabled: false, devices: [device({ connected: true })] });
    expect(phoneIndicatorState(s, now)).toMatchObject({ tone: 'off', line: 'Phone access off' });
  });
});
