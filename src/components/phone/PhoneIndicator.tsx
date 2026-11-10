/**
 * The sidebar's door to the phone: the companion app is how you take your
 * agents with you, so it has a row of its own at the foot of the sidebar
 * rather than a place in Settings.
 *
 * It says only what `companion_status` read: no phone yet, a phone connected
 * now, or when a paired phone was last seen. Clicking opens the Phone panel
 * (pair, install, paired phones). Remote access, for driving the app from
 * another assistant, is a separate and secondary thing and keeps its own
 * row only while it is on.
 *
 * @module components/phone/PhoneIndicator
 */

import { useEffect, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { MobileIcon } from '@/components/icons';
import { Button } from '../primitives/Button';
import { FooterRowIcon } from '../workspace/FooterRowIcon';
import { useOpenModal } from '../../contexts/ModalContext';
import { useAsyncState } from '../../hooks/useAsyncState';
import { usePolling } from '../../hooks/usePolling';
import { agoText } from '../../lib/remoteAccess';
import {
  COMPANION_CHANGED_EVENT,
  getPhoneStatus,
  requestPairOnOpen,
  type PhoneStatus,
} from '../../lib/companion';
import { PAIR_YOUR_PHONE } from '../../../packages/companion-protocol/src/pairWords';

type Tone = 'off' | 'ok';

export function phoneIndicatorState(
  status: PhoneStatus,
  now: number
): { tone: Tone; line: string; detail: string; pair: boolean } {
  const devices = status.devices;
  if (devices.length === 0) {
    return {
      tone: 'off',
      // The phone app's first screen says to click exactly this.
      line: PAIR_YOUR_PHONE,
      detail: 'Shows a code to scan with the phone app, to talk to your agents from your phone.',
      pair: true,
    };
  }
  const connected = devices.find((d) => d.connected);
  if (status.enabled && connected) {
    return {
      tone: 'ok',
      line: `${connected.name} connected`,
      detail: 'Your phone is connected to this Mac.',
      pair: false,
    };
  }
  if (!status.enabled) {
    return {
      tone: 'off',
      line: 'Phone access off',
      detail: 'Your phone stays paired and reconnects when you turn phone access back on.',
      pair: false,
    };
  }
  const seen = devices
    .map((d) => d.lastSeenAt)
    .filter((t): t is number => typeof t === 'number')
    .sort((a, b) => b - a)[0];
  return {
    tone: 'off',
    line: seen !== undefined ? `Phone seen ${agoText(seen, now)}` : 'Phone paired',
    detail: 'Your phone reconnects when you open the app on it.',
    pair: false,
  };
}

export function PhoneIndicator({ isSidebarHidden }: { isSidebarHidden: boolean }) {
  const openModal = useOpenModal();
  // No `immediate`: the poll below reads on mount, and both made it two reads at once.
  const status = useAsyncState<PhoneStatus>(getPhoneStatus);
  const [now, setNow] = useState(() => Date.now());
  const { execute } = status;
  usePolling(
    async () => {
      setNow(Date.now());
      return execute();
    },
    { intervalMs: 20_000, name: 'phone-indicator' }
  );
  // A phone arriving or leaving shows at once, not on the next poll.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let gone = false;
    void listen(COMPANION_CHANGED_EVENT, () => {
      setNow(Date.now());
      void execute();
    })
      .then((fn) => {
        if (gone) fn();
        else unlisten = fn;
      })
      .catch(() => {});
    return () => {
      gone = true;
      unlisten?.();
    };
  }, [execute]);

  const state = status.data ? phoneIndicatorState(status.data, now) : null;
  if (!state) return null;

  return (
    <Button
      variant="ghost"
      width="fill"
      className={`remote-indicator remote-indicator--${state.tone}${
        isSidebarHidden ? ' remote-indicator--compact' : ''
      }`}
      onClick={() => {
        if (state.pair) requestPairOnOpen();
        openModal('phone');
      }}
      title={state.detail}
      aria-label={`${state.line}. ${state.detail}`}
      data-testid="phone-indicator"
      leftIcon={<FooterRowIcon icon={<MobileIcon size={14} />} status={state.tone} />}
    >
      {!isSidebarHidden && <span className="remote-indicator__line">{state.line}</span>}
    </Button>
  );
}
