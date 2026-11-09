import { describe, expect, it } from 'vitest';
import { FOLDED_REPLY, foldResultReplies } from './results';

const card = (summary: string) => ({ id: 'r', version: 1, title: 'Pricing page', summary });
const msg = (id: string, kind: string, text: string, result?: ReturnType<typeof card>) => ({
  id,
  kind,
  text,
  ...(result ? { result } : {}),
});

const SUMMARY =
  'I rebuilt the pricing page with three plans and a monthly toggle, and checked it at phone width.';

describe('foldResultReplies', () => {
  it('shrinks a reply the card repeats to one line', () => {
    const list = [
      msg('u', 'user', 'do it'),
      msg(
        'a',
        'agent',
        `**I rebuilt** the pricing page with three plans and a monthly toggle,\nand checked it at phone width.`
      ),
      msg('c', 'agent', '', card(SUMMARY)),
    ];
    const out = foldResultReplies(list);
    expect(out[1].text).toBe(FOLDED_REPLY);
    expect(out[2]).toBe(list[2]);
    expect(list[1].text).not.toBe(FOLDED_REPLY);
  });

  it('keeps a reply that says something the card does not', () => {
    const list = [
      msg(
        'a',
        'agent',
        `${SUMMARY} Also, the old checkout route still returns a 500 and needs someone to look at the payment webhook before launch.`
      ),
      msg('c', 'agent', '', card(SUMMARY)),
    ];
    expect(foldResultReplies(list)).toBe(list);
  });

  it('does not fold across a message from you', () => {
    const list = [
      msg('a', 'agent', SUMMARY),
      msg('u', 'user', 'thanks'),
      msg('c', 'agent', '', card(SUMMARY)),
    ];
    expect(foldResultReplies(list)).toBe(list);
  });
});
