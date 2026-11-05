import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { PairCode, PairConfirm } from './PhonePairing';
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

describe('PairCode', () => {
  const code = {
    link: 'x://pair?d=1',
    qr: { size: 1, modules: '1' },
    expiresAt: Date.now() + 60_000,
  };
  const tailscale = {
    state: 'connected',
    dnsName: 'm.ts.net',
    login: 'julian@example.com',
  } as const;
  const show = (reachedAt?: number) =>
    render(
      <PairCode
        code={code}
        now={Date.now()}
        busy={false}
        tailscale={tailscale}
        reachedAt={reachedAt}
        onCopy={vi.fn()}
        onCancel={vi.fn()}
      />
    );

  it('puts Tailscale on the phone first, with the Mac’s account and the store links', () => {
    show();
    const first = screen.getAllByRole('listitem')[0];
    expect(first.textContent).toMatch(
      /^Install Tailscale on your phone and sign in as julian@example\.com\./
    );
    expect(screen.getByRole('button', { name: /App Store/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Google Play/ })).toBeTruthy();
    expect(screen.queryByTestId('phone-code-reached')).toBeNull();
  });

  it('says a device reached this Mac, not that a phone did', () => {
    show(Date.now());
    expect(screen.getByTestId('phone-code-reached').textContent).toMatch(
      /^A device reached this Mac at .+\. Waiting for it to send the code…$/
    );
  });
});
