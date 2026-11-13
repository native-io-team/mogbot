import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { GrowingProse, Prose } from './AgentProse';
import { revealStep, REVEAL_CATCH_UP_MS, REVEAL_MIN_RATE } from './useReveal';
import { toSegments } from './agentMarkdown';

afterEach(cleanup);

describe('a reply growing', () => {
  it('keeps the DOM of finished blocks and redraws only the one being written', () => {
    const first = 'The numbers check out.\n\n';
    const { container, rerender } = render(<GrowingProse text={`${first}Revenue is`} />);
    const paragraph = container.querySelector('.agent-markdown__prose > p');
    rerender(<GrowingProse text={`${first}Revenue is up, churn is flat.\n\n- one`} />);
    const after = container.querySelectorAll('.agent-markdown__prose > :not(:empty)');
    // The same node, not an equal one: it was never torn down.
    expect(after[0]).toBe(paragraph);
    expect(after[1].textContent).toBe('Revenue is up, churn is flat.');
    expect(after[2].tagName).toBe('UL');
  });

  it('draws the same HTML a whole parse does', () => {
    const text = '## Plan\n\nFirst **bold** step.\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\nDone.';
    const { container, rerender } = render(<GrowingProse text={text.slice(0, 20)} />);
    rerender(<GrowingProse text={text} />);
    const whole = toSegments(text)[0];
    const wrapper = document.createElement('div');
    wrapper.innerHTML = whole.type === 'html' ? whole.html : '';
    // A table that scrolls sideways is a tab stop, drawn either way.
    for (const table of wrapper.querySelectorAll('table')) table.tabIndex = 0;
    expect(container.querySelector('.agent-markdown__prose')?.innerHTML).toBe(wrapper.innerHTML);
  });

  it('makes a table a tab stop, so a wide one can be scrolled by keyboard', () => {
    const { container } = render(<Prose text={'| A | B |\n| - | - |\n| 1 | 2 |'} />);
    expect(container.querySelector('table')?.getAttribute('tabindex')).toBe('0');
  });
});

describe('the reveal pace', () => {
  it('shows what is queued over about a quarter of a second, never slower than its floor', () => {
    // 260 characters queued: about one per ms, ~16 a frame.
    expect(revealStep(260, 16, 0).n).toBe(16);
    // Almost nothing queued still moves, at the floor rate.
    const slow = revealStep(3, 16, 0);
    expect(slow.n).toBe(0);
    expect(slow.carry).toBeCloseTo((REVEAL_MIN_RATE * 16) / 1000);
    // Never more than is there.
    expect(revealStep(2, 1000, 0).n).toBe(2);
    expect(REVEAL_CATCH_UP_MS).toBeLessThan(400);
  });
});
