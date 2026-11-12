/**
 * The sidebar's door into remote access, and the first place a problem shows
 * up.
 *
 * Shown only while it is on (the companion app is the phone story; see
 * PhoneIndicator). Formerly always present; while off, a muted grey
 * "Remote access off" that opens setup. While it's on, the globe (the icon
 * ⌘K uses for Remote access) with a green status dot, and the assistant that
 * last connected, named from its MCP `clientInfo.name` (`assistantName`). The row turns amber for the one thing that will end remote
 * access on its own — running on battery — and red if the server isn't
 * running at all, because those are exactly what the user needs to see
 * before they walk away.
 *
 * Polls the cheap brief (no Tailscale calls), since every window shows it.
 *
 * @module components/remote/RemoteAccessIndicator
 */

import { useState } from 'react';
import { GlobeIcon } from '@/components/icons';
import { Button } from '../primitives/Button';
import { IconButton } from '../primitives/IconButton';
import { Tooltip } from '../primitives/Tooltip';
import { FooterRowIcon } from '../workspace/FooterRowIcon';
import { useOpenModal } from '../../contexts/ModalContext';
import { useAsyncState } from '../../hooks/useAsyncState';
import { usePolling } from '../../hooks/usePolling';
import {
  agoText,
  assistantName,
  getRemoteAccessBrief,
  type RemoteAccessBrief,
} from '../../lib/remoteAccess';
import { THIS_COMPUTER } from '../../lib/computer';

type Tone = 'off' | 'ok' | 'warn' | 'down';

export function indicatorState(
  brief: RemoteAccessBrief,
  now: number
): { tone: Tone; line: string; detail: string } {
  if (!brief.enabled) {
    return {
      tone: 'off',
      line: 'Remote access off',
      detail: `Let another assistant drive your agents on ${THIS_COMPUTER} — click to set up remote access.`,
    };
  }
  if (!brief.serverRunning) {
    return {
      tone: 'down',
      line: 'Remote access stopped',
      detail: `Your assistant can’t reach ${THIS_COMPUTER}. Open Remote access to restart it.`,
    };
  }
  if (brief.power.onAc === false) {
    const pct = brief.power.batteryPercent;
    return {
      tone: 'warn',
      line: pct !== null ? `Remote on · battery ${pct}%` : 'Remote on · on battery',
      detail: 'Plug in — remote access stops when the battery runs out.',
    };
  }
  const last = brief.activity.lastRequestMs;
  return {
    tone: 'ok',
    line:
      last !== null
        ? `Remote on · ${
            brief.activity.lastClient ? assistantName(brief.activity.lastClient) : 'used'
          } ${agoText(last, now)}`
        : 'Remote on',
    detail: `Your assistant can reach ${THIS_COMPUTER} while it stays on, awake and online.`,
  };
}

export function RemoteAccessIndicator({
  isSidebarHidden,
  compact = false,
}: {
  isSidebarHidden: boolean;
  /**
   * Sized as a small icon button with a tooltip, beside Settings in the
   * foot's last row (the Agents sidebar). Placement and size only: the words
   * are the same, in the tooltip and the VoiceOver label.
   */
  compact?: boolean;
}) {
  const openModal = useOpenModal();
  // No `immediate`: the poll below reads on mount, and both made it two reads at once.
  const brief = useAsyncState<RemoteAccessBrief>(getRemoteAccessBrief);
  const [now, setNow] = useState(() => Date.now());
  const { execute } = brief;
  usePolling(
    async () => {
      setNow(Date.now());
      return execute();
    },
    { intervalMs: 20_000, name: 'remote-access-indicator' }
  );

  const state = brief.data ? indicatorState(brief.data, now) : null;
  // Off, it says nothing: the phone story is the companion app
  // (PhoneIndicator), and remote access is reached from the Phone panel and
  // ⌘K. On, it stays, because battery and a stopped server need seeing.
  if (!state || state.tone === 'off') return null;

  // Beside Settings in the Agents foot: the globe and its dot, the words in
  // the tooltip. Battery and a stopped server still show, as the dot's hue.
  if (compact) {
    return (
      <Tooltip content={`${state.line}. ${state.detail}`}>
        <IconButton
          variant="ghost"
          className={`remote-indicator remote-indicator--icon remote-indicator--${state.tone}`}
          onClick={() => openModal('remoteAccess')}
          aria-label={`${state.line}. ${state.detail}`}
          data-testid="remote-indicator"
          icon={<FooterRowIcon icon={<GlobeIcon size={14} />} status={state.tone} />}
        />
      </Tooltip>
    );
  }

  return (
    <Button
      variant="ghost"
      width="fill"
      className={`remote-indicator remote-indicator--${state.tone}${
        isSidebarHidden ? ' remote-indicator--compact' : ''
      }`}
      onClick={() => openModal('remoteAccess')}
      title={state.detail}
      aria-label={`${state.line}. ${state.detail}`}
      data-testid="remote-indicator"
      leftIcon={<FooterRowIcon icon={<GlobeIcon size={14} />} status={state.tone} />}
    >
      {!isSidebarHidden && <span className="remote-indicator__line">{state.line}</span>}
    </Button>
  );
}
