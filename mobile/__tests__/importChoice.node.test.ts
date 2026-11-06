/**
 * Import on the phone: the home asks once, only while the Mac says nobody
 * has answered and it can take the answer; the import screen shows one of
 * its three steps at a time, from what the Mac reports.
 */

import type { ImportTalk, PhoneImportStatus } from '@shipstudio/companion-protocol';
import { asksImportChoice, phoneImportStep } from '../src/lib/importChoice';

const SERVES = { methods: ['agents.import.status', 'agents.setImportChoice'] };

describe('asksImportChoice', () => {
  it('asks only while undecided, on a Mac that can import and take the answer', () => {
    expect(asksImportChoice({ importChoice: 'undecided' }, SERVES)).toBe(true);
    expect(asksImportChoice({ importChoice: 'declined' }, SERVES)).toBe(false);
    expect(asksImportChoice({ importChoice: 'imported' }, SERVES)).toBe(false);
    // An older Mac sends no answer, or can't take one: never asks.
    expect(asksImportChoice({}, SERVES)).toBe(false);
    expect(
      asksImportChoice({ importChoice: 'undecided' }, { methods: ['agents.import.status'] })
    ).toBe(false);
    expect(asksImportChoice(null, SERVES)).toBe(false);
  });
});

const status = (over: Partial<PhoneImportStatus> = {}): PhoneImportStatus => ({
  remoteAccess: { enabled: true, funnelOn: true, everConnected: true },
  armed: false,
  talk: null,
  prompt: 'Move my agents…',
  chiefId: 'chief',
  ...over,
});

describe('phoneImportStep', () => {
  it('shows one step at a time: connect, then start, then follow', () => {
    expect(phoneImportStep(null)).toEqual({ id: 'connect', index: 1, reachable: false });
    expect(
      phoneImportStep(
        status({ remoteAccess: { enabled: false, funnelOn: false, everConnected: false } })
      )
    ).toEqual({ id: 'connect', index: 1, reachable: false });
    expect(
      phoneImportStep(
        status({ remoteAccess: { enabled: true, funnelOn: true, everConnected: false } })
      )
    ).toEqual({ id: 'connect', index: 1, reachable: true });
    expect(phoneImportStep(status())).toEqual({ id: 'start', index: 2, reachable: true });
    expect(phoneImportStep(status({ armed: true }))).toMatchObject({ id: 'start' });
    const talk = {
      source: 'Grok',
      state: 'interviewing',
      staged: [],
      imported: [],
    } as unknown as ImportTalk;
    expect(phoneImportStep(status({ talk }))).toMatchObject({ id: 'follow', index: 3 });
  });
});
