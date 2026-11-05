import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { PhoneSigninBar } from './PhoneSigninBar';

const invoke = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tauri-apps/api/core')>()),
  invoke,
}));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));

describe('PhoneSigninBar', () => {
  beforeEach(() => invoke.mockReset());

  it('shows nothing while no phone is signing in', async () => {
    invoke.mockResolvedValue(null);
    const { container } = render(<PhoneSigninBar />);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('agents_phone_signin_status'));
    expect(container).toBeEmptyDOMElement();
  });

  it('names the site and stops it from here', async () => {
    invoke.mockImplementation((cmd: string) =>
      Promise.resolve(
        cmd === 'agents_phone_signin_status'
          ? { domain: 'figma.com', deviceName: 'Sam’s iPhone', startedAt: 1 }
          : null
      )
    );
    render(<PhoneSigninBar />);
    expect(await screen.findByText('Your phone is signing in to figma.com')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('agents_phone_signin_stop'));
    await waitFor(() => expect(screen.queryByTestId('phone-signin-bar')).toBeNull());
  });
});
