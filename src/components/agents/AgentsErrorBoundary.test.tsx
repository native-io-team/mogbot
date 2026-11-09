import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react';
import {
  guardRow,
  PaneBoundary,
  SectionBoundary,
  SidebarBoundary,
  useGuardedRows,
} from './AgentsErrorBoundary';

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

describe('a broken sidebar', () => {
  it('leaves the chat beside it, says so, and Try again redraws it', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    render(
      <div>
        <SidebarBoundary>
          <Flaky label="agents list" />
        </SidebarBoundary>
        <p>chat</p>
      </div>
    );
    expect(screen.getByText('chat')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toContain(
      'The list of agents couldn’t be shown.'
    );
    expect(logError).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ where: 'agents-sidebar:agents' }),
      'frontend-crash'
    );
    broken = false;
    fireEvent.click(screen.getByText('Try again'));
    expect(screen.getByText('agents list')).toBeTruthy();
  });
});

describe('a broken settings section', () => {
  it('is one card; the sections around it still show', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    render(
      <div>
        <SectionBoundary name="usage">
          <p>usage ok</p>
        </SectionBoundary>
        <SectionBoundary name="slack">
          <Flaky label="slack" />
        </SectionBoundary>
        <SectionBoundary name="disk">
          <p>disk ok</p>
        </SectionBoundary>
      </div>
    );
    expect(screen.getByText('usage ok')).toBeTruthy();
    expect(screen.getByText('disk ok')).toBeTruthy();
    expect(screen.getAllByRole('alert')).toHaveLength(1);
    expect(screen.getByRole('alert').textContent).toContain('This setting couldn’t be shown');
    expect(logError).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ where: 'settings:slack' }),
      'frontend-crash'
    );
  });
});

describe('history rows kept between renders', () => {
  const Row = ({ n }: { n: number }) => <p>{n}</p>;

  it('keeps an unchanged row’s guarded element, so React skips it, and redraws a changed one', () => {
    const { result, rerender } = renderHook(({ rows }) => useGuardedRows(rows), {
      initialProps: { rows: [<Row key="a" n={1} />, <Row key="b" n={2} />] },
    });
    const [a, b] = result.current;
    rerender({ rows: [<Row key="a" n={1} />, <Row key="b" n={3} />, <Row key="c" n={4} />] });
    expect(result.current[0]).toBe(a);
    expect(result.current[1]).not.toBe(b);
    expect(result.current).toHaveLength(3);
    // A row of another kind under the same key is never mistaken for it.
    const Other = ({ n }: { n: number }) => <span>{n}</span>;
    const kept = result.current[0];
    rerender({ rows: [<Other key="a" n={1} />] });
    expect(result.current[0]).not.toBe(kept);
  });

  it('keeps every row in its own boundary', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    function Rows() {
      const rows = useGuardedRows([<Flaky key="x" label="x" />, <p key="y">fine</p>]);
      return <div>{rows}</div>;
    }
    render(<Rows />);
    expect(screen.getByText(/This line couldn.t be shown/)).toBeTruthy();
    expect(screen.getByText('fine')).toBeTruthy();
  });
});
