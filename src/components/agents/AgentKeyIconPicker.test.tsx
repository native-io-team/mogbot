import { useState } from 'react';
import { describe, expect, it, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { AgentKeyIconPicker } from './AgentKeyIconPicker';
import { AgentKey } from './AgentKey';

/** The picker with the key it changes, as the editor has them. */
function Harness({ autoFocus = true }: { autoFocus?: boolean }) {
  const [icon, setIcon] = useState('money');
  return (
    <div>
      <div data-testid="preview">
        <AgentKey name="Finance" colorway="teal" icon={icon} size="xl" />
      </div>
      <AgentKeyIconPicker
        name="Finance"
        colorway="teal"
        icon={icon}
        onChange={setIcon}
        autoFocus={autoFocus}
      />
    </div>
  );
}

const preview = () => screen.getByTestId('preview').querySelector('.agent-key')!;
const loaded = () =>
  waitFor(() => expect(screen.getByText('2,052 icons')).toBeTruthy(), { timeout: 10_000 });

beforeEach(() => {
  try {
    localStorage.clear();
  } catch {
    // no storage
  }
});

describe('AgentKeyIconPicker', () => {
  it('focuses its search, loads the pack, and finds icons by what they are for', async () => {
    render(<Harness />);
    const search = screen.getByRole('searchbox', { name: 'Search icons' });
    expect(document.activeElement).toBe(search);
    // The featured legends are there before the pack arrives.
    expect(screen.getByRole('radio', { name: 'Money' })).toBeTruthy();
    await loaded();
    fireEvent.change(search, { target: { value: 'money' } });
    const names = screen.getAllByRole('radio').map((r) => r.getAttribute('aria-label'));
    expect(names[0]).toBe('Money');
    expect(names).toEqual(expect.arrayContaining(['Banknote', 'Coins', 'Wallet']));
    expect(screen.getByText(/for “money”/)).toBeTruthy();

    // Enter takes the first match; a click takes any, and the key above wears it.
    fireEvent.click(screen.getByRole('radio', { name: 'Wallet' }));
    expect(preview().getAttribute('data-icon')).toBe('lucide:wallet');
    await waitFor(() =>
      expect(preview().querySelector('svg')!.getAttribute('data-round')).toBe('true')
    );
    fireEvent.change(search, { target: { value: 'invoice' } });
    fireEvent.keyDown(search, { key: 'Enter' });
    expect(preview().getAttribute('data-icon')).toBe('lucide:receipt');

    fireEvent.change(search, { target: { value: 'zzqx' } });
    expect(screen.getByText(/Nothing matches “zzqx”/)).toBeTruthy();
  });

  it('moves the pick with the arrows, and up from the top row goes back to the search', async () => {
    render(<Harness />);
    await loaded();
    const search = screen.getByRole('searchbox', { name: 'Search icons' });
    fireEvent.change(search, { target: { value: 'car' } });
    fireEvent.keyDown(search, { key: 'ArrowDown' });
    const first = document.activeElement as HTMLElement;
    expect(first.getAttribute('aria-label')).toBe('Car');
    expect(preview().getAttribute('data-icon')).toBe('car');
    act(() => {
      fireEvent.keyDown(first, { key: 'ArrowRight' });
    });
    expect(preview().getAttribute('data-icon')).toBe('lucide:car');
    act(() => {
      fireEvent.keyDown(document.activeElement!, { key: 'ArrowLeft' });
      fireEvent.keyDown(document.activeElement!, { key: 'ArrowUp' });
    });
    expect(document.activeElement).toBe(search);
  });

  it('narrows to a category, and remembers what was picked', async () => {
    const { unmount } = render(<Harness autoFocus={false} />);
    await loaded();
    // The row leads with what people pick by; Lucide's others wait in More.
    const chips = within(screen.getByRole('group', { name: 'Categories' }))
      .getAllByRole('button')
      .map((b) => b.textContent);
    expect(chips.slice(0, 2)).toEqual(['All', 'Featured']);
    expect(chips).not.toContain('Animals');
    expect(chips[chips.length - 1]).toBe('More');
    fireEvent.click(screen.getByRole('button', { name: 'More' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Animals' }));
    expect(screen.getByRole('button', { name: 'Animals' })).toBeTruthy();
    const names = screen.getAllByRole('radio').map((r) => r.getAttribute('aria-label'));
    expect(names).toContain('Dog');
    expect(names).not.toContain('Money');
    fireEvent.click(screen.getByRole('radio', { name: 'Dog' }));
    unmount();
    render(<Harness autoFocus={false} />);
    await loaded();
    expect(screen.getByText('Recently used')).toBeTruthy();
    expect(screen.getByRole('radio', { name: 'Dog (recently used)' })).toBeTruthy();
  });
});
