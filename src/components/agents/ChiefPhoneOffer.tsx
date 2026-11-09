/**
 * "Use your agents from your phone?" — the phone part of onboarding, moved
 * to the moment it means something: in the Chief's chat, once the first
 * thing the user asked for has come back. Asking before then (minute two of
 * onboarding) was ten minutes of Tailscale between someone and their first
 * result.
 *
 * Shown once per Mac's chat until it's answered: Set up my phone opens the
 * Phone panel (the same pairing the onboarding screens did), Not now puts it
 * away. Never while a phone is already paired, while the import question is
 * still open (one question at a time), or while a turn is running.
 *
 * The answer is kept in this window's storage: losing it costs one more
 * offer, never a wrong state, and "Get the phone app" at the sidebar's foot
 * and ⌘K "Pair a phone" are there either way.
 *
 * @module components/agents/ChiefPhoneOffer
 */

import { useEffect, useState } from 'react';
import { MobileIcon } from '@/components/icons';
import { Button } from '../primitives/Button';
import { AgentCard } from './AgentCard';
import { getPhoneStatus } from '../../lib/companion';
import type { AgentMessage } from '../../lib/agents';

export const PHONE_OFFER_KEY = 'shipstudio.chief.phoneOffer';

/**
 * Whether the conversation has reached its first result: the user has said
 * something, and the Chief has replied to the newest thing they said (a
 * result card arrives on a reply too).
 */
export function reachedFirstResult(messages: readonly AgentMessage[]): boolean {
  let lastUser = -1;
  messages.forEach((m, i) => {
    if (m.kind === 'user') lastUser = i;
  });
  if (lastUser < 0) return false;
  return messages.slice(lastUser + 1).some((m) => m.kind === 'agent');
}

function answered(): boolean {
  try {
    return window.localStorage.getItem(PHONE_OFFER_KEY) !== null;
  } catch {
    return false;
  }
}

function remember(answer: 'later' | 'setup'): void {
  try {
    window.localStorage.setItem(PHONE_OFFER_KEY, answer);
  } catch {
    // Storage blocked: it may ask once more; the sidebar row is there anyway.
  }
}

export function ChiefPhoneOffer({ onSetUp }: { onSetUp: () => void }) {
  const [hidden, setHidden] = useState(answered);
  // Null until the Mac says: no card on a guess.
  const [paired, setPaired] = useState<boolean | null>(null);
  useEffect(() => {
    if (hidden) return;
    let live = true;
    getPhoneStatus()
      .then((s) => live && setPaired(s.devices.length > 0))
      .catch(() => live && setPaired(true));
    return () => {
      live = false;
    };
  }, [hidden]);
  if (hidden || paired !== false) return null;

  const answer = (a: 'later' | 'setup') => {
    remember(a);
    setHidden(true);
    if (a === 'setup') onSetUp();
  };

  return (
    <AgentCard
      className="agent-phone-offer"
      data-testid="chief-phone-offer"
      icon={<MobileIcon size={14} />}
      title="Use your agents from your phone?"
      note="Chat, answer and approve from anywhere. Your phone talks only to this Mac. About ten minutes."
      actions={
        <>
          <Button variant="secondary" size="compact" onClick={() => answer('later')}>
            Not now
          </Button>
          <Button
            variant="strong"
            size="compact"
            onClick={() => answer('setup')}
            data-phone-offer-setup
          >
            Set up my phone
          </Button>
        </>
      }
    />
  );
}
