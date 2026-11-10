/**
 * The phone, offered in the Chief's chat once the first thing asked for is
 * back: never before a reply, never with a phone paired, never twice.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { AgentMessage } from '../../lib/agents';

const getPhoneStatus = vi.hoisted(() => vi.fn());
vi.mock('../../lib/companion', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/companion')>();
  return { ...actual, getPhoneStatus };
});

import {
  ChiefPhoneOffer,
  PHONE_OFFER_KEY,
  PHONE_OFFER_NOTE,
  reachedFirstResult,
} from './ChiefPhoneOffer';

const msg = (kind: AgentMessage['kind'], id: string): AgentMessage => ({
  id,
  agentId: 'chief',
  ts: 0,
  kind,
  text: id,
});

describe('reachedFirstResult', () => {
  it('needs something the user said and a reply after it', () => {
    expect(reachedFirstResult([])).toBe(false);
    // The greeting alone: the user hasn't spoken.
    expect(reachedFirstResult([msg('agent', 'greeting')])).toBe(false);
    expect(reachedFirstResult([msg('agent', 'greeting'), msg('user', 'u1')])).toBe(false);
    expect(
      reachedFirstResult([msg('agent', 'greeting'), msg('user', 'u1'), msg('approval', 'q')])
    ).toBe(false);
    expect(
      reachedFirstResult([msg('agent', 'greeting'), msg('user', 'u1'), msg('agent', 'a1')])
    ).toBe(true);
    // A new question waits for its own reply.
    expect(
      reachedFirstResult([
        msg('agent', 'greeting'),
        msg('user', 'u1'),
        msg('agent', 'a1'),
        msg('user', 'u2'),
      ])
    ).toBe(false);
  });
});

describe('ChiefPhoneOffer', () => {
  it('doesn’t promise ten minutes while there is no App Store app', () => {
    expect(PHONE_OFFER_NOTE).not.toMatch(/^.*About ten minutes\.$/);
    expect(PHONE_OFFER_NOTE).toMatch(/no App Store app yet/);
  });

  beforeEach(() => {
    localStorage.clear();
    getPhoneStatus.mockReset().mockResolvedValue({ devices: [] });
  });

  it('offers once with no phone paired; Set up my phone opens the Phone panel and stays answered', async () => {
    const onSetUp = vi.fn();
    const { unmount } = render(<ChiefPhoneOffer onSetUp={onSetUp} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Set up my phone' }));
    expect(onSetUp).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('chief-phone-offer')).not.toBeInTheDocument();
    unmount();
    render(<ChiefPhoneOffer onSetUp={onSetUp} />);
    expect(screen.queryByTestId('chief-phone-offer')).not.toBeInTheDocument();
    expect(localStorage.getItem(PHONE_OFFER_KEY)).toBe('setup');
  });

  it('Not now puts it away without opening anything', async () => {
    const onSetUp = vi.fn();
    render(<ChiefPhoneOffer onSetUp={onSetUp} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Not now' }));
    expect(onSetUp).not.toHaveBeenCalled();
    expect(localStorage.getItem(PHONE_OFFER_KEY)).toBe('later');
  });

  it('says nothing while a phone is paired, or when the Mac can’t say', async () => {
    getPhoneStatus.mockResolvedValue({ devices: [{ id: 'd1' }] });
    const { unmount } = render(<ChiefPhoneOffer onSetUp={vi.fn()} />);
    await waitFor(() => expect(getPhoneStatus).toHaveBeenCalled());
    expect(screen.queryByTestId('chief-phone-offer')).not.toBeInTheDocument();
    unmount();
    getPhoneStatus.mockRejectedValue(new Error('no companion'));
    render(<ChiefPhoneOffer onSetUp={vi.fn()} />);
    await waitFor(() => expect(getPhoneStatus).toHaveBeenCalledTimes(2));
    expect(screen.queryByTestId('chief-phone-offer')).not.toBeInTheDocument();
  });
});
