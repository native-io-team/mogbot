/**
 * The morning brief on the desk: the Chief's message reads as short
 * sections with the outside text from a check shown as words (never a
 * link), and its Settings rows (on/off and time, quiet days, the user's
 * checks) write what was chosen and follow chat.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

const tauri = vi.hoisted(() => ({
  invoke: vi.fn(),
  handlers: new Map<string, () => void>(),
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: tauri.invoke }));
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn((name: string, fn: () => void) => {
    tauri.handlers.set(name, fn);
    return Promise.resolve(() => tauri.handlers.delete(name));
  }),
}));

import { Prose } from './AgentProse';
import { AgentMorningBriefSetting } from './AgentMorningBriefSetting';
import { BRIEF_SAMPLE } from '../../harness/scenarios/agentsBrief';
import { isBriefText } from '../../../packages/companion-protocol/src/brief';

const flush = () => act(() => new Promise((r) => setTimeout(r, 0)));
afterEach(cleanup);

describe('the brief in the chat', () => {
  it('reads as one line, then short headed lists', () => {
    const { container } = render(<Prose text={BRIEF_SAMPLE} />);
    expect(isBriefText(BRIEF_SAMPLE)).toBe(true);
    const first = container.querySelector('p');
    expect(first?.textContent).toMatch(/^Morning brief, Monday 9 November: 1 card waits for you/);
    const headings = [...container.querySelectorAll('strong')].map((s) => s.textContent);
    expect(headings).toEqual([
      'Needs you',
      'Didn’t work',
      'Today',
      'Since yesterday',
      'Usage',
      'Your checks',
    ]);
    expect(screen.getByText('Standup 9:30')).toBeTruthy();
  });

  it('shows a check’s outside text as escaped words, not a link or bold', () => {
    // What `brief::plain` writes for "[Click me](https://evil.example) **now**"
    // and for a bare address (GFM would link it by itself).
    const text =
      'Morning brief, Monday 9 November: nothing needs you.\n\n**Your checks**\n- mail (Gmail):\n  - \\[Click me\\]\\(https\\://evil\\.example\\) \\*\\*now\\*\\*\n  - www\\.evil\\.example and me\\@evil\\.example';
    const { container } = render(<Prose text={text} />);
    expect(container.querySelector('a')).toBeNull();
    expect(container.textContent).toContain('[Click me](https://evil.example) **now**');
    expect(container.textContent).toContain('www.evil.example and me@evil.example');
    expect([...container.querySelectorAll('strong')].map((s) => s.textContent)).toEqual([
      'Your checks',
    ]);
  });
});

describe('the brief in Settings', () => {
  let saved: Record<string, unknown>;
  beforeEach(() => {
    tauri.invoke.mockReset();
    tauri.handlers.clear();
    saved = {
      on: true,
      at: 480,
      always: false,
      checks: [{ what: 'events on my calendar today', app: 'Google Calendar' }],
    };
    tauri.invoke.mockImplementation((cmd: string, args?: Record<string, unknown>) => {
      if (cmd === 'agents_morning_brief') return Promise.resolve(saved);
      if (cmd === 'agents_set_morning_brief') {
        saved = {
          on: args?.on,
          at: args?.at,
          always: args?.always,
          checks: args?.checks ?? saved.checks,
        };
        return Promise.resolve(saved);
      }
      return Promise.reject(new Error(`unmocked ${cmd}`));
    });
  });

  it('changes its time, posts on quiet days, removes a check, and turns off', async () => {
    render(<AgentMorningBriefSetting />);
    await flush();
    fireEvent.change(screen.getByLabelText('Morning brief time'), { target: { value: '07:30' } });
    await flush();
    expect(tauri.invoke).toHaveBeenCalledWith('agents_set_morning_brief', {
      on: true,
      at: 450,
      always: false,
      checks: null,
    });
    fireEvent.click(screen.getByRole('switch', { name: 'Post even when there’s nothing new' }));
    await flush();
    expect(saved.always).toBe(true);
    expect(screen.getByText('Check: events on my calendar today')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    await flush();
    expect(tauri.invoke).toHaveBeenLastCalledWith('agents_set_morning_brief', {
      on: true,
      at: 450,
      always: true,
      checks: [],
    });
    expect(screen.queryByText('Check: events on my calendar today')).toBeNull();
    fireEvent.click(screen.getByRole('switch', { name: 'Morning brief' }));
    await flush();
    expect(saved.on).toBe(false);
    expect(screen.queryByLabelText('Morning brief time')).toBeNull();
  });

  it('reads again when chat changes it', async () => {
    render(<AgentMorningBriefSetting />);
    await flush();
    expect(screen.getByDisplayValue('08:00')).toBeTruthy();
    saved = { ...saved, at: 6 * 60 };
    act(() => {
      tauri.handlers.get('agents-morning-brief-changed')?.();
    });
    await flush();
    expect(screen.getByDisplayValue('06:00')).toBeTruthy();
  });
});
