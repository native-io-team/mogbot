import { describe, expect, it } from 'vitest';
import { readPlan, readResultCard, readSecretRequest } from './cardShapes';

describe('readResultCard', () => {
  it('keeps a well-formed card as it is', () => {
    const card = {
      id: 'c',
      version: 2,
      title: 'Homepage',
      summary: 'Done',
      items: [
        { kind: 'link', url: 'https://example.com', label: 'Live' },
        {
          kind: 'file',
          file: { name: 'a.png', path: 'attachments/a.png', mime: 'image/png', size: 3 },
          role: 'after',
        },
      ],
      checked: ['It builds'],
      notVerified: ['Safari'],
      changes: 'Bigger title',
      project: '/p',
      checkpoint: true,
    };
    expect(readResultCard(card)).toEqual(card);
  });

  it.each([null, 'nonsense', 7, [], {}])('anything at all (%s) reads as a card', (raw) => {
    const card = readResultCard(raw);
    expect(card.title).toBe('A result');
    expect(card.version).toBe(1);
    expect(card.items).toBeUndefined();
  });

  it('drops unreadable items and lines, never invents them', () => {
    const card = readResultCard({
      id: 'c',
      title: 'T',
      items: [{ kind: 'file' }, { kind: 'link' }, { kind: 'odd', url: 'x' }, null],
      checked: 'all of it',
      notVerified: [3, '', 'Phone'],
      test: { steps: 'none' },
    });
    expect(card.items).toBeUndefined();
    expect(card.checked).toBeUndefined();
    expect(card.notVerified).toEqual(['Phone']);
    expect(card.test).toEqual({ outcome: 'passed', summary: '' });
  });

  it('a file with no name is named after its path; odd sizes read as 0', () => {
    const card = readResultCard({
      items: [{ kind: 'file', file: { path: 'a/b.txt', size: 'x' } }],
    });
    expect(card.items).toEqual([
      { kind: 'file', file: { name: 'b.txt', path: 'a/b.txt', mime: '', size: 0 } },
    ]);
  });
});

describe('readSecretRequest', () => {
  it('drops fields with no variable; an empty request has no fields', () => {
    expect(readSecretRequest({}).fields).toEqual([]);
    expect(readSecretRequest({ fields: 'x' }).fields).toEqual([]);
    expect(
      readSecretRequest({ fields: [{ env: 'A' }, { label: 'B' }, null, { env: 'C', label: 'C!' }] })
        .fields
    ).toEqual([
      { env: 'A', label: 'A' },
      { env: 'C', label: 'C!' },
    ]);
  });

  it('an unknown kind reads as other', () => {
    expect(readSecretRequest({ kind: 'wallet' }).kind).toBe('other');
    expect(readSecretRequest({ kind: 'token' }).kind).toBe('token');
  });
});

describe('readPlan', () => {
  it('keeps actions with a summary, drops the rest', () => {
    expect(
      readPlan({
        actions: [{ summary: 'Push', target: 'a/b', kind: 'push', text: 'hi' }, {}, 'x'],
        why: 'ship',
      })
    ).toEqual({
      actions: [{ summary: 'Push', target: 'a/b', kind: 'push', text: 'hi' }],
      why: 'ship',
    });
  });

  it.each([null, {}, { actions: 'all' }])('%s has no actions', (raw) => {
    expect(readPlan(raw).actions).toEqual([]);
  });
});
