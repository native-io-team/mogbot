import { afterEach, describe, expect, it } from 'vitest';
import { boardNavTarget, withoutName } from './AgentsTeamView';

afterEach(() => {
  document.body.innerHTML = '';
});

describe('a Needs you line under its own agent', () => {
  it('drops the agent’s name from the front', () => {
    expect(withoutName('Finance needs you in its browser: sign in', 'Finance')).toBe(
      'Needs you in its browser: sign in'
    );
  });

  it('leaves any other line alone', () => {
    expect(withoutName('Send an email · Gmail', 'Finance')).toBe('Send an email · Gmail');
    expect(withoutName('Financed the trip', 'Finance')).toBe('Financed the trip');
  });
});

describe('arrow keys on the board', () => {
  const column = () => {
    document.body.innerHTML = `
      <div id="c">
        <button id="a" data-board-nav></button>
        <div><button id="allow" data-allow></button></div>
        <button id="b" data-board-nav></button>
        <button id="g1" data-board-nav data-grid></button>
        <button id="g2" data-board-nav data-grid></button>
      </div>`;
    return document.getElementById('c')!;
  };
  const el = (id: string) => document.getElementById(id)!;

  it('moves between rows, and from a card’s button to the rows around it', () => {
    const c = column();
    expect(boardNavTarget(c, el('a'), 'ArrowDown')?.id).toBe('b');
    expect(boardNavTarget(c, el('b'), 'ArrowUp')?.id).toBe('a');
    expect(boardNavTarget(c, el('allow'), 'ArrowDown')?.id).toBe('b');
    expect(boardNavTarget(c, el('allow'), 'ArrowUp')?.id).toBe('a');
  });

  it('goes along the grid with Left and Right, never out of it', () => {
    const c = column();
    expect(boardNavTarget(c, el('g1'), 'ArrowRight')?.id).toBe('g2');
    expect(boardNavTarget(c, el('g1'), 'ArrowLeft')).toBeUndefined();
    expect(boardNavTarget(c, el('b'), 'ArrowRight')).toBeUndefined();
  });

  it('Home and End reach the first and last', () => {
    const c = column();
    expect(boardNavTarget(c, el('g1'), 'Home')?.id).toBe('a');
    expect(boardNavTarget(c, el('a'), 'End')?.id).toBe('g2');
  });
});
