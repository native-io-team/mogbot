/**
 * Import on the phone: the home asks once, only while the Mac says nobody
 * has answered and it can take the answer; the import screen shows one of
 * its three steps at a time, from what the Mac reports.
 */

import type { ImportTalk, PhoneImportStatus } from '@shipstudio/companion-protocol';
import {
  asksImportChoice,
  importedHere,
  phoneImportStep,
  phoneTalkHeading,
} from '../src/lib/importChoice';

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

describe('phoneTalkHeading', () => {
  const talk = (state: ImportTalk['state'], imported: string[] = []): ImportTalk => ({
    id: 't',
    source: 'Grok',
    chiefId: 'chief',
    state,
    startedAt: 0,
    lastAt: 0,
    exchanges: 0,
    staged: [],
    imported,
    busy: false,
  });

  it('never asks the user to answer while the other assistant is sending', () => {
    expect(phoneTalkHeading(talk('interviewing'), 'Ada')).toBe('Grok is sending everything');
    expect(phoneTalkHeading(talk('awaiting_consent'), 'Ada')).toBe('Allow Grok in Ada’s chat');
    expect(phoneTalkHeading(talk('playback'), 'Ada')).toBe('Check the plan in Ada’s chat');
    expect(phoneTalkHeading(talk('review'), 'Ada')).toBe('Review them in Ada’s chat');
    expect(phoneTalkHeading(talk('imported', ['Travel']), 'Ada')).toBe('Your team is here');
    expect(phoneTalkHeading(talk('stopped'), 'Ada')).toBe('Nothing was imported');
  });

  it('ends on the imported agents that are here, to open', () => {
    const agents = [
      { id: 'a1', name: 'Travel' },
      { id: 'a2', name: 'Finance' },
    ];
    expect(importedHere(talk('imported', ['Finance (from Grok)', 'Travel']), agents)).toEqual([
      { id: 'a1', name: 'Travel' },
    ]);
    expect(importedHere(talk('review', ['Travel']), agents)).toEqual([]);
  });
});
