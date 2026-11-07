import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { guardRow, PaneBoundary } from './AgentsErrorBoundary';

const logError = vi.hoisted(() => vi.fn());
vi.mock('../../lib/logger', () => ({ logger: { logError, error: vi.fn() } }));

let broken = true;
function Flaky({ label }: { label: string }) {
  if (broken) throw new Error(`bad ${label}`);
  return <p>{label}</p>;
}

afterEach(() => {
  cleanup();
  broken = true;
  logError.mockClear();
});

describe('a pane that fails to draw', () => {
  it('says so in place, logs it, and Try again redraws it', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    render(
      <PaneBoundary resetKey="a">
        <Flaky label="chat a" />
      </PaneBoundary>
    );
    expect(screen.getByRole('alert').textContent).toContain('couldn');
    expect(logError).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'bad chat a' }),
      expect.objectContaining({ where: 'agents-pane' }),
      'frontend-crash'
    );
    broken = false;
    fireEvent.click(screen.getByText('Try again'));
    expect(screen.getByText('chat a')).toBeTruthy();
  });

  it('clears when another agent is chosen', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { rerender } = render(
      <PaneBoundary resetKey="a">
        <Flaky label="chat a" />
      </PaneBoundary>
    );
    expect(screen.queryByRole('alert')).toBeTruthy();
    broken = false;
    rerender(
      <PaneBoundary resetKey="b">
        <Flaky label="chat b" />
      </PaneBoundary>
    );
    expect(screen.getByText('chat b')).toBeTruthy();
  });
});

describe('a history line that fails to draw', () => {
  it('is one muted line; the lines around it still show', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    function Bad(): never {
      throw new Error('bad line');
    }
    const rows = [<p key="1">first</p>, <Bad key="2" />, null, <p key="3">third</p>].map(guardRow);
    render(<div>{rows}</div>);
    expect(screen.getByText('first')).toBeTruthy();
    expect(screen.getByText('third')).toBeTruthy();
    expect(screen.getByText("This line couldn't be shown.")).toBeTruthy();
    expect(logError).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'bad line' }),
      expect.objectContaining({ where: 'agents-row' }),
      'frontend-crash'
    );
  });
});
