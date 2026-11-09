import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { describeAgentsAttention, ModeToggle } from './ModeToggle';

/** Lay the two segments out side by side, as the sidebar does (jsdom has no layout). */
function layOut(list: HTMLElement) {
  const place = (value: string, left: number) => {
    const tab = list.querySelector<HTMLElement>(`[data-tab-value="${value}"]`)!;
    tab.getBoundingClientRect = () =>
      ({ left, right: left + 98, top: 60, bottom: 84, width: 98, height: 24 }) as DOMRect;
  };
  place('agents', 11);
  place('projects', 111);
}

describe('ModeToggle', () => {
  function setup(mode: 'agents' | 'projects') {
    const onAgents = vi.fn();
    const onProjects = vi.fn();
    render(<ModeToggle mode={mode} onAgents={onAgents} onProjects={onProjects} />);
    const list = screen.getByRole('tablist', { name: 'Mode' });
    layOut(list);
    return { list, onAgents, onProjects };
  }

  it('switches on a click on the other segment, and not on its own', () => {
    const { onAgents, onProjects } = setup('agents');
    fireEvent.click(screen.getByRole('tab', { name: 'Agents' }));
    expect(onAgents).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('tab', { name: 'Projects' }));
    expect(onProjects).toHaveBeenCalledTimes(1);
  });

  it('a click in the hairline between the segments goes to the nearer one', () => {
    const { list, onProjects } = setup('agents');
    fireEvent.click(list, { clientX: 110.6, clientY: 70 });
    expect(onProjects).toHaveBeenCalledTimes(1);
  });

  it('a click on the rim goes to the segment under it', () => {
    const { list, onAgents } = setup('projects');
    fireEvent.click(list, { clientX: 9, clientY: 59 });
    expect(onAgents).toHaveBeenCalledTimes(1);
  });
});

describe('describeAgentsAttention', () => {
  it('is null when nobody wants you', () => {
    expect(describeAgentsAttention({ waiting: [], unread: 0 })).toBeNull();
  });

  it('names who is waiting, then counts the unread', () => {
    expect(describeAgentsAttention({ waiting: ['Lead Gen'], unread: 1 })).toBe(
      'Lead Gen needs your OK · 1 unread'
    );
    expect(describeAgentsAttention({ waiting: ['Lead Gen', 'Finance'], unread: 0 })).toBe(
      'Lead Gen and Finance need your OK'
    );
    expect(describeAgentsAttention({ waiting: ['Lead Gen', 'Finance', 'Hiring'], unread: 2 })).toBe(
      'Lead Gen and 2 others need your OK · 2 unread'
    );
    expect(describeAgentsAttention({ waiting: [], unread: 3 })).toBe('3 unread');
  });
});
