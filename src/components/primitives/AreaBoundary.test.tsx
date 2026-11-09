import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { AreaBoundary } from './AreaBoundary';
import { ModalFrame } from './ModalFrame';

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
  vi.restoreAllMocks();
});

describe('an area that fails to draw', () => {
  it('is one card with Try again; its neighbours still show', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    render(
      <div>
        <p>sidebar</p>
        <AreaBoundary where="test-area">
          <Flaky label="area" />
        </AreaBoundary>
        <p>composer</p>
      </div>
    );
    expect(screen.getByText('sidebar')).toBeTruthy();
    expect(screen.getByText('composer')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toContain('couldn’t be shown');
    expect(logError).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'bad area' }),
      expect.objectContaining({ where: 'test-area' }),
      'frontend-crash'
    );
    broken = false;
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(screen.getByText('area')).toBeTruthy();
  });

  it('clears when its reset key changes', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { rerender } = render(
      <AreaBoundary where="x" resetKey="a">
        <Flaky label="a" />
      </AreaBoundary>
    );
    expect(screen.queryByRole('alert')).toBeTruthy();
    broken = false;
    rerender(
      <AreaBoundary where="x" resetKey="b">
        <Flaky label="b" />
      </AreaBoundary>
    );
    expect(screen.getByText('b')).toBeTruthy();
  });

  it('takes its own fallback', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    render(
      <AreaBoundary where="x" fallback={() => <span>custom</span>}>
        <Flaky label="a" />
      </AreaBoundary>
    );
    expect(screen.getByText('custom')).toBeTruthy();
  });
});

describe('a dialog whose body throws', () => {
  it('keeps its title and close button, and says so in the body', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const onClose = vi.fn();
    render(
      <ModalFrame isOpen onClose={onClose} title="Apps">
        <Flaky label="body" />
      </ModalFrame>
    );
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(screen.getByText('Apps')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toContain('This dialog couldn’t be shown');
    expect(logError).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ where: 'dialog' }),
      'frontend-crash'
    );
    fireEvent.click(screen.getByRole('button', { name: 'Close dialog' }));
    expect(onClose).toHaveBeenCalled();
  });
});
