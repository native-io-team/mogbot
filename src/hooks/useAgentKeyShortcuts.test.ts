import { afterEach, describe, expect, it } from 'vitest';
import { agentForKeyEvent } from './useAgentKeyShortcuts';

const team = [
  { id: 'chief', name: 'Chief of Staff', role: '', color: 'white', isMain: true, boundKey: 'C' },
  { id: 'fin', name: 'Finance', role: '', color: 'amber', isMain: false, boundKey: 'F' },
  // From an older Mac: no key, so no shortcut.
  { id: 'old', name: 'Old', role: '', color: 'blue', isMain: false },
];

function press(
  key: string,
  init: Partial<KeyboardEvent> = {},
  target: EventTarget | null = document.body
) {
  return agentForKeyEvent(
    {
      key,
      metaKey: false,
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
      repeat: false,
      defaultPrevented: false,
      target,
      ...init,
    },
    team
  );
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('an agent’s bound key', () => {
  it('opens that agent, upper or lower case', () => {
    expect(press('f')).toBe('fin');
    expect(press('c')).toBe('chief');
    expect(press('o')).toBeNull();
    expect(press('z')).toBeNull();
  });

  it('never fires with a modifier, on a repeat, or when already handled', () => {
    expect(press('f', { metaKey: true })).toBeNull();
    expect(press('f', { ctrlKey: true })).toBeNull();
    expect(press('f', { altKey: true })).toBeNull();
    expect(press('F', { shiftKey: true })).toBeNull();
    expect(press('f', { repeat: true })).toBeNull();
    expect(press('f', { defaultPrevented: true })).toBeNull();
    expect(press('Enter')).toBeNull();
  });

  it('leaves typing alone: fields, the composer, terminals', () => {
    const input = document.createElement('input');
    const editable = document.createElement('div');
    editable.setAttribute('contenteditable', 'true');
    const term = document.createElement('div');
    term.className = 'xterm';
    const inner = document.createElement('textarea');
    term.appendChild(inner);
    document.body.append(input, editable, term);
    expect(press('f', {}, input)).toBeNull();
    expect(press('f', {}, editable)).toBeNull();
    expect(press('f', {}, inner)).toBeNull();
  });

  it('waits while a dialog or a menu is open', () => {
    const dialog = document.createElement('div');
    dialog.setAttribute('aria-modal', 'true');
    document.body.append(dialog);
    expect(press('f')).toBeNull();
    dialog.remove();
    const menu = document.createElement('div');
    menu.setAttribute('role', 'menu');
    document.body.append(menu);
    expect(press('f')).toBeNull();
  });
});
