import { describe, expect, it } from 'vitest';
import {
  agentHoldsC,
  answerFrontCard,
  cardAnswerForKey,
  isCatchUpKey,
  projectIndexForKey,
  type KeyLike,
} from './designedShortcuts';

const press = (over: Partial<KeyLike>): KeyLike => ({
  key: '',
  code: '',
  repeat: false,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  defaultPrevented: false,
  target: document.body,
  ...over,
});

describe('a project by its number', () => {
  const k = (n: number, over: Partial<KeyLike> = {}) =>
    press({ ctrlKey: true, altKey: true, shiftKey: true, code: `Digit${n}`, key: '¡', ...over });
  it('is ⌃⌥⇧ and a digit, read from the code (⌥⇧ changes the key)', () => {
    expect(projectIndexForKey(k(1))).toBe(0);
    expect(projectIndexForKey(k(9))).toBe(8);
  });
  it('is never 0, never another family, never a repeat', () => {
    expect(
      projectIndexForKey(press({ ctrlKey: true, altKey: true, shiftKey: true, code: 'Digit0' }))
    ).toBeNull();
    expect(projectIndexForKey(k(1, { shiftKey: false }))).toBeNull();
    expect(projectIndexForKey(k(1, { altKey: false }))).toBeNull();
    expect(projectIndexForKey(k(1, { metaKey: true }))).toBeNull();
    expect(projectIndexForKey(k(1, { repeat: true }))).toBeNull();
    expect(projectIndexForKey(press({ code: 'Digit1', key: '1' }))).toBeNull();
  });
});

describe('Catch up', () => {
  const c = (over: Partial<KeyLike> = {}) =>
    press({ ctrlKey: true, altKey: true, code: 'KeyC', key: 'ç', ...over });
  it('is ⌃⌥C while no agent holds C', () => {
    expect(isCatchUpKey(c(), false)).toBe(true);
    expect(isCatchUpKey(c({ shiftKey: true }), false)).toBe(false);
  });
  it('is ⌃⌥⇧C once an agent holds C, and then ⌃⌥C is left to that agent', () => {
    expect(isCatchUpKey(c({ shiftKey: true }), true)).toBe(true);
    expect(isCatchUpKey(c(), true)).toBe(false);
  });
  it('needs both ⌃ and ⌥ and no ⌘', () => {
    expect(isCatchUpKey(c({ ctrlKey: false }), false)).toBe(false);
    expect(isCatchUpKey(c({ altKey: false }), false)).toBe(false);
    expect(isCatchUpKey(c({ metaKey: true }), false)).toBe(false);
  });
  it('sees which agents hold C', () => {
    const a = (boundKey?: string) =>
      ({ id: 'x', name: 'Cat', role: '', color: 'blue', isMain: false, boundKey }) as never;
    expect(agentHoldsC([a('C')])).toBe(true);
    expect(agentHoldsC([a('L')])).toBe(false);
  });
});

describe('Allow and Deny on the card in front', () => {
  const m = (key: string, over: Partial<KeyLike> = {}) => press({ metaKey: true, key, ...over });
  it('⌘↩ allows and ⌘⌫ denies', () => {
    expect(cardAnswerForKey(m('Enter'), document, true)).toBe('allow');
    expect(cardAnswerForKey(m('Backspace'), document, true)).toBe('deny');
  });
  it('needs ⌘ alone: ⌃⌘↩, ⌥⌘↩, ⇧⌘↩, a bare ↩ and a repeat do nothing', () => {
    for (const over of [
      { ctrlKey: true },
      { altKey: true },
      { shiftKey: true },
      { repeat: true },
    ]) {
      expect(cardAnswerForKey(m('Enter', over), document, true)).toBeNull();
    }
    expect(cardAnswerForKey(press({ key: 'Enter' }), document, true)).toBeNull();
    expect(cardAnswerForKey(press({ key: 'Backspace' }), document, true)).toBeNull();
  });
  it('is Mac only: Super+Enter and Super+Backspace on Windows or Linux answer nothing', () => {
    expect(cardAnswerForKey(m('Enter'), document, false)).toBeNull();
    expect(cardAnswerForKey(m('Backspace'), document, false)).toBeNull();
    expect(cardAnswerForKey(m('Enter'), document, true)).toBe('allow');
  });
  it('does nothing while a text box has focus, so sending a message with ⌘↩ is untouched', () => {
    const box = document.createElement('textarea');
    document.body.append(box);
    expect(cardAnswerForKey(m('Enter', { target: box }), document, true)).toBeNull();
    box.focus();
    expect(cardAnswerForKey(m('Backspace', { target: document.body }), document, true)).toBeNull();
    box.remove();
    const editable = document.createElement('div');
    editable.setAttribute('contenteditable', 'true');
    expect(cardAnswerForKey(m('Enter', { target: editable }), document, true)).toBeNull();
  });
  it('presses the first waiting card’s button, and not a disabled or missing one', () => {
    document.body.innerHTML = `<div data-keys><button data-allow>Allow</button><button data-deny>Deny</button></div>
      <div data-keys><button data-allow>Allow 2</button></div>`;
    const clicks: string[] = [];
    document
      .querySelectorAll('button')
      .forEach((b) => b.addEventListener('click', () => clicks.push(b.textContent ?? '')));
    expect(answerFrontCard('allow')).toBe(true);
    expect(answerFrontCard('deny')).toBe(true);
    expect(clicks).toEqual(['Allow', 'Deny']);
    (document.querySelector('[data-allow]') as HTMLButtonElement).disabled = true;
    expect(answerFrontCard('allow')).toBe(false);
    document.body.innerHTML = '<div>no cards</div>';
    expect(answerFrontCard('deny')).toBe(false);
  });
});
