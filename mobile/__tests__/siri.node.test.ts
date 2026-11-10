/**
 * Siri and Shortcuts: a request becomes a send to the agent named (else the
 * Chief), with the same clientId on every replay; nothing else is ever sent,
 * and only names reach the system's catalog.
 */

import {
  TELL_AGENT,
  agentCatalog,
  planSiriRequest,
  siriClientId,
  type Invocation,
} from '../src/lib/siri';

const team = [
  { id: 'main', name: 'Chief of Staff', isMain: true, hidden: false },
  { id: 'inbox', name: 'Inbox', isMain: false, hidden: false },
  { id: 'gone', name: 'Old helper', isMain: false, hidden: true },
];

const ask = (params: Record<string, unknown>, name = TELL_AGENT): Invocation => ({
  id: 'inv-1',
  name,
  params,
});

describe('a Siri request', () => {
  it('goes to the agent named, trimmed, with a clientId that is the same on a replay', () => {
    expect(planSiriRequest(ask({ agentId: 'inbox', text: '  archive receipts  ' }), team)).toEqual({
      kind: 'send',
      agentId: 'inbox',
      text: 'archive receipts',
      clientId: siriClientId('inv-1'),
    });
    expect(siriClientId('inv-1')).toBe(siriClientId('inv-1'));
  });

  it('goes to the Chief of Staff when no agent is named', () => {
    expect(planSiriRequest(ask({ text: 'What is on today?' }), team)).toMatchObject({
      kind: 'send',
      agentId: 'main',
    });
    expect(planSiriRequest(ask({ agentId: null, text: 'Hi' }), team)).toMatchObject({
      agentId: 'main',
    });
  });

  it('sends nothing without words, to an agent no longer on the team, or with no team yet', () => {
    expect(planSiriRequest(ask({ text: '   ' }), team).kind).toBe('drop');
    expect(planSiriRequest(ask({ text: 42 }), team).kind).toBe('drop');
    expect(
      planSiriRequest(ask({ agentId: 'deleted', agentName: 'Finance', text: 'Hi' }), team)
    ).toEqual({
      kind: 'drop',
      reason: 'Finance isn’t on your team any more, so nothing was sent.',
    });
    expect(planSiriRequest(ask({ text: 'Hi' }), []).kind).toBe('drop');
  });

  it('leaves another intent’s request alone', () => {
    expect(planSiriRequest(ask({ text: 'Hi' }, 'somethingElse'), team)).toEqual({ kind: 'skip' });
  });
});

describe('the catalog Siri matches names against', () => {
  it('holds names only, of the agents you can talk to, the Chief findable as Chief', () => {
    expect(agentCatalog(team)).toEqual([
      {
        id: 'main',
        title: 'Chief of Staff',
        subtitle: 'Chief of Staff',
        synonyms: ['Chief', 'Chief of Staff'],
      },
      { id: 'inbox', title: 'Inbox' },
    ]);
  });
});
