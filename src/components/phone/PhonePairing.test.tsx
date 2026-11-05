import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { PairConfirm } from './PhonePairing';
import type { Device, PairRequestView } from '../../lib/companion';

const device = {
  name: 'Julian’s iPhone',
  platform: 'ios',
  model: 'iPhone 16 Pro',
  appVersion: '1.0.0',
  build: 'official',
} as const;

const paired: Device = {
  id: 'dev_old',
  ...device,
  pairedAt: Date.UTC(2026, 9, 3),
  connected: false,
};

const request = (replaces: Device[] = []): PairRequestView => ({
  id: 'pr_1',
  device,
  requestedAt: Date.now(),
  codeHint: 'K7Q2',
  login: 'julian@example.com',
  replaces,
});

describe('PairConfirm', () => {
  it('shows when it asked, the code ending and the tailnet user', () => {
    render(<PairConfirm request={request()} busy={null} onDecide={vi.fn()} />);
    const meta = screen.getByTestId('phone-confirm-meta').textContent ?? '';
    expect(meta).toMatch(/^Asked at .+ · code ending K7Q2 · julian@example\.com$/);
  });

  it('allows a new phone without replacing anything', () => {
    const onDecide = vi.fn();
    render(<PairConfirm request={request()} busy={null} onDecide={onDecide} />);
    expect(screen.queryByTestId('phone-confirm-replaces')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Allow' }));
    expect(onDecide).toHaveBeenCalledWith(true, []);
  });

  // A look-alike name used to revoke the real phone silently.
  it('asks before replacing a phone that looks the same, and keeps both unless told', () => {
    const onDecide = vi.fn();
    render(<PairConfirm request={request([paired])} busy={null} onDecide={onDecide} />);
    expect(screen.getByTestId('phone-confirm-replaces').textContent).toMatch(
      /already paired.*If you don’t recognise this request, deny it\./
    );
    expect(screen.queryByRole('button', { name: 'Allow' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Allow, keep both' }));
    expect(onDecide).toHaveBeenLastCalledWith(true, []);
    fireEvent.click(screen.getByRole('button', { name: 'Allow and replace' }));
    expect(onDecide).toHaveBeenLastCalledWith(true, ['dev_old']);
    fireEvent.click(screen.getByRole('button', { name: 'Deny' }));
    expect(onDecide).toHaveBeenLastCalledWith(false, []);
  });
});
