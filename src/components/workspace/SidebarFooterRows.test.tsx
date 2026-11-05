/**
 * The sidebar footer's status rows are real buttons that open their panel on
 * one click or Enter/Space, with the app-wide tooltip (which claims every
 * `title`) showing on hover and never standing in for the click.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import { ModalProvider, useModal } from '../../contexts/ModalContext';
import { TooltipProvider } from '../primitives/Tooltip';
import { PhoneIndicator } from '../phone/PhoneIndicator';
import { RemoteAccessIndicator } from '../remote/RemoteAccessIndicator';

// Unmount first: the rows' listeners unregister through the mocks.
afterEach(() => {
  cleanup();
  clearMocks();
});

const NOW = Date.now();

function Open() {
  const phone = useModal('phone');
  const remote = useModal('remoteAccess');
  return (
    <output data-testid="open">
      {[phone.isOpen && 'phone', remote.isOpen && 'remoteAccess'].filter(Boolean).join(',')}
    </output>
  );
}

function renderFooter() {
  mockIPC(
    (cmd) => {
      if (cmd === 'companion_status') {
        return {
          enabled: true,
          devices: [{ id: 'd1', name: 'Sam’s iPhone', lastSeenAt: NOW - 60 * 60_000 }],
        };
      }
      if (cmd === 'get_remote_access_brief') {
        return {
          enabled: true,
          serverRunning: true,
          keepAwake: true,
          power: { hasBattery: true, onAc: true, batteryPercent: 90, charging: true },
          lidClosedMode: false,
          activity: { lastRequestMs: NOW - 5_000, lastClient: 'Cursor', rejectedRequests: 0 },
        };
      }
      return null;
    },
    { shouldMockEvents: true }
  );
  return render(
    <ModalProvider>
      <TooltipProvider>
        <PhoneIndicator isSidebarHidden={false} />
        <RemoteAccessIndicator isSidebarHidden={false} />
        <Open />
      </TooltipProvider>
    </ModalProvider>
  );
}

describe('sidebar footer rows', () => {
  it('the Phone row opens the Phone panel on one click, after its tooltip has shown', async () => {
    renderFooter();
    const row = await screen.findByTestId('phone-indicator');
    expect(row.tagName).toBe('BUTTON');
    expect(row.textContent).toBe('Phone seen 1 h ago');
    const user = userEvent.setup();
    await user.hover(row);
    await screen.findByRole('tooltip', {}, { timeout: 2000 });
    await user.click(row);
    expect(screen.getByTestId('open').textContent).toBe('phone');
  });

  it('the Remote row opens Remote access on one click and names the reported client', async () => {
    renderFooter();
    const row = await screen.findByTestId('remote-indicator');
    expect(row.tagName).toBe('BUTTON');
    expect(row.textContent).toBe('Remote on · Cursor just now');
    // A line icon with a status dot, not a bare dot.
    expect(row.querySelector('.footer-row-icon svg')).not.toBeNull();
    expect(
      row.querySelector('.footer-row-icon[data-status="ok"] .footer-row-icon__badge')
    ).not.toBeNull();
    await userEvent.setup().click(row);
    expect(screen.getByTestId('open').textContent).toBe('remoteAccess');
  });

  it('opens from the keyboard: Enter and Space', async () => {
    const user = userEvent.setup();
    const first = renderFooter();
    (await screen.findByTestId('phone-indicator')).focus();
    await user.keyboard('{Enter}');
    expect(screen.getByTestId('open').textContent).toBe('phone');
    first.unmount();

    renderFooter();
    (await screen.findByTestId('remote-indicator')).focus();
    await user.keyboard(' ');
    await waitFor(() => expect(screen.getByTestId('open').textContent).toBe('remoteAccess'));
  });
});
