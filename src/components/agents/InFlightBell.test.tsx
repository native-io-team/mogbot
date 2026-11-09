import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { InFlightBell } from './AgentsSidebar';

describe('InFlightBell: the sidebar’s one count of what needs you', () => {
  it('says how many need you, and opens What’s in flight', () => {
    const onOpen = vi.fn();
    render(<InFlightBell count={2} current={false} onOpen={onOpen} />);
    const bell = screen.getByRole('button', { name: 'What’s in flight · 2 need you' });
    expect(document.querySelector('.agents-inflight__count')?.textContent).toBe('2');
    fireEvent.click(bell);
    expect(onOpen).toHaveBeenCalledOnce();
  });

  it('shows no count when nothing waits, and caps a big one', () => {
    const { rerender } = render(<InFlightBell count={0} current onOpen={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'What’s in flight' })).toHaveAttribute(
      'aria-current',
      'page'
    );
    expect(document.querySelector('.agents-inflight__count')).toBeNull();
    rerender(<InFlightBell count={16} current={false} onOpen={vi.fn()} />);
    expect(document.querySelector('.agents-inflight__count')?.textContent).toBe('9+');
  });
});
