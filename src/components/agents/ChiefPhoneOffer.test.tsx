/**
 * The phone, offered in the Chief's chat once the first thing asked for is
 * back: never before a reply, never with a phone paired, never twice.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
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
    // A reply that asks the user something is the Chief waiting, not a result.
    const asks = { ...msg('agent', 'a1'), text: 'Done. Want me to set that up every week?' };
    expect(reachedFirstResult([msg('agent', 'greeting'), msg('user', 'u1'), asks])).toBe(false);
    // ...unless it came back with a result card.
    expect(
      reachedFirstResult([
        msg('agent', 'greeting'),
        msg('user', 'u1'),
        { ...asks, result: {} as AgentMessage['result'] },
      ])
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

  it('isn’t offered at all when this build can’t get the app onto a phone', async () => {
    render(<ChiefPhoneOffer onSetUp={vi.fn()} note={null} />);
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByTestId('chief-phone-offer')).not.toBeInTheDocument();
    expect(getPhoneStatus).not.toHaveBeenCalled();
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

it('the harness quiets the offer under the same key it is stored at', () => {
  // resetStorage.ts writes the key out (it runs before app modules load).
  const harness = readFileSync(resolve('src/harness/resetStorage.ts'), 'utf8');
  expect(harness).toContain(`'${PHONE_OFFER_KEY}'`);
});
