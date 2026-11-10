/**
 * The Phone panel's first step, "Get the app", in each kind of build: an App
 * Store link when there is one, a build on this Mac when that's possible,
 * otherwise a plain line, never a button into nothing.
 */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { openUrl } from '@tauri-apps/plugin-opener';
import { PhoneGetApp } from './PhoneModal';
import { PHONE_APP_NOT_OUT } from '../../lib/phoneApp';
import type { PhoneStatus } from '../../lib/companion';

const tailscale = { state: 'connected' } as PhoneStatus['tailscale'];

describe('PhoneGetApp', () => {
  it('links to the App Store when the page is known, ahead of a build here', () => {
    const onInstall = vi.fn();
    render(
      <PhoneGetApp
        tailscale={tailscale}
        storeUrl="https://apps.apple.com/app/id1"
        onInstall={onInstall}
        onHaveApp={vi.fn()}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: /Get it on the App Store/ }));
    expect(openUrl).toHaveBeenCalledWith('https://apps.apple.com/app/id1');
    expect(screen.queryByRole('button', { name: 'Get the app…' })).not.toBeInTheDocument();
  });

  it('offers the build on this Mac with no store page', () => {
    const onInstall = vi.fn();
    render(
      <PhoneGetApp
        tailscale={tailscale}
        storeUrl={null}
        onInstall={onInstall}
        onHaveApp={vi.fn()}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Get the app…' }));
    expect(onInstall).toHaveBeenCalled();
  });

  it('says the app isn’t out yet when this build can’t get it', () => {
    render(<PhoneGetApp tailscale={tailscale} storeUrl={null} onHaveApp={vi.fn()} />);
    expect(screen.getByText(PHONE_APP_NOT_OUT)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'I already have it' })).toBeInTheDocument();
  });
});
