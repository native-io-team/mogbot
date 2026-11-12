/**
 * "Can't reach your Mac" as a checklist (lib/reachChecklist.ts): three
 * things, each with what this phone can see of it and its one fix, and the
 * address only ever in the folded detail.
 */

import { reachChecklist, reachDetail, type ReachInputs } from '../src/lib/reachChecklist';

const NOW = 1_800_000_000_000;
const base: ReachInputs = {
  mac: 'Studio Mac',
  phoneOnline: true,
  tailscaleInstalled: true,
  paired: { kind: 'not_yet' },
  now: NOW,
};
const byId = (input: Partial<ReachInputs>) =>
  Object.fromEntries(reachChecklist({ ...base, ...input }).map((c) => [c.id, c]));

describe('the reach checklist', () => {
  it('is the same three things, in order, every time', () => {
    expect(reachChecklist(base).map((c) => c.title)).toEqual([
      'Studio Mac is awake, with the app open',
      'Tailscale is on, same account on both',
      'This phone is paired',
    ]);
  });

  it('says nothing of Tailscale to a phone that reaches the Mac only through the relay', () => {
    const checks = reachChecklist({ ...base, viaTailscale: false, tailscaleInstalled: false });
    expect(checks.map((c) => c.title)).toEqual([
      'Studio Mac is awake, with the app open',
      'This phone is online',
      'This phone is paired',
    ]);
    for (const c of checks) expect(`${c.title} ${c.status} ${c.fix ?? ''}`).not.toMatch(/Tailscale/);
    expect(checks.every((c) => c.action !== 'get_tailscale' && c.action !== 'open_tailscale')).toBe(
      true
    );
    const offline = byId({ viaTailscale: false, phoneOnline: false }).online;
    expect(offline.tone).toBe('problem');
  });

  it('never puts an address or a port in a row', () => {
    for (const diagnosis of ['tailscale_off', 'mac_unreachable'] as const) {
      for (const c of reachChecklist({ ...base, diagnosis })) {
        const words = `${c.title} ${c.status} ${c.fix ?? ''}`;
        expect(words).not.toMatch(/localhost|:\d{2,5}|\.ts\.net|https?:/);
      }
    }
    // It lives in the folded detail instead.
    expect(reachDetail('localhost:50898')).toContain('localhost:50898');
  });

  it('never calls an asleep or closed Mac fine or broken: silence looks the same', () => {
    const mac = byId({ diagnosis: 'mac_unreachable' }).mac;
    expect(mac.tone).toBe('unknown');
    expect(mac.status).toMatch(/Can’t tell/);
    expect(mac.fix).toMatch(/Wake the Mac and open the app/);
    const asleep = byId({ likelyAsleep: true, lastSeenAt: NOW - 10 * 60_000 }).mac;
    expect(asleep.tone).toBe('unknown');
    expect(asleep.status).toBe(
      'Last heard from 10 min ago. It was on battery and allowed to sleep, so it probably is.'
    );
  });

  it('says what it saw of Tailscale, and offers the app that fixes it', () => {
    expect(byId({ diagnosis: 'tailscale_off' }).tailscale).toMatchObject({
      tone: 'problem',
      action: 'open_tailscale',
    });
    expect(byId({ tailscaleInstalled: false }).tailscale).toMatchObject({
      tone: 'problem',
      status: 'Tailscale isn’t on this phone.',
      action: 'get_tailscale',
    });
    // Offline beats everything: Tailscale can't help without a network.
    expect(byId({ phoneOnline: false, diagnosis: 'tailscale_off' }).tailscale).toMatchObject({
      tone: 'problem',
      status: 'This phone isn’t online.',
      action: null,
    });
    // Nothing observed: unknown, with the place to check.
    expect(byId({ diagnosis: 'mac_unreachable' }).tailscale).toMatchObject({
      tone: 'unknown',
      action: 'open_tailscale',
    });
  });

  it('pairing: not yet while pairing, fine when paired, the one fix when let go', () => {
    expect(byId({}).paired).toMatchObject({ tone: 'unknown', action: null });
    expect(byId({ paired: { kind: 'yes', since: NOW } }).paired).toMatchObject({
      tone: 'ok',
      fix: null,
    });
    expect(byId({ paired: { kind: 'let_go' } }).paired).toMatchObject({
      tone: 'problem',
      action: 'pair_again',
    });
  });
});
