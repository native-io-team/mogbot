/**
 * Settings → Agents, "Disk space": how much is free when it's low, and each
 * agent home of 1 GB or more with "Free up space", which removes only its
 * regenerable dependency and build folders (`agents/disk.rs`). Hidden while
 * disk is fine and no home is large.
 *
 * @module components/agents/AgentsDiskSettings
 */

import { useEffect, useRef, useState } from 'react';
import { Button } from '../primitives/Button';
import { Spinner } from '../primitives/Spinner';
import { ErrorIcon } from '@/components/icons';
import { useAsyncState } from '../../hooks/useAsyncState';
import { asCommandError, formatCommandError } from '../../lib/errors';
import { takeSettingsSectionRequest } from '../../lib/settings';
import {
  diskOverview,
  formatBytes,
  freedLine,
  freeUpAgentHome,
  homeLine,
  type DiskOverview,
} from '../../lib/agentsDisk';
import { THIS_COMPUTER, THIS_COMPUTER_CAP } from '../../lib/computer';

function freeLine(d: DiskOverview): string | null {
  if (d.freeBytes === null || d.level === 'fine') return null;
  const free = `${THIS_COMPUTER_CAP} has ${formatBytes(d.freeBytes)} free.`;
  return d.level === 'floor'
    ? `${free} Agents ask before installing packages or cloning.`
    : `${free} Agents are told to clean up before installing.`;
}

/** Disk is fine and no home is large: said only when someone asked. */
function fineLine(d: DiskOverview): string {
  const none = 'No agent’s folder is 1 GB or more.';
  return d.freeBytes === null
    ? none
    : `${THIS_COMPUTER_CAP} has ${formatBytes(d.freeBytes)} free. ${none}`;
}

export function AgentsDiskSettings() {
  const { data, execute } = useAsyncState<DiskOverview>(diskOverview, { immediate: true });
  const [busy, setBusy] = useState<string | null>(null);
  const [done, setDone] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLElement>(null);
  // Opened from ⌘K "Disk space used by agents…": shown even when there is
  // nothing to do, so the command lands on an answer, not the top of the page.
  const [asked, setAsked] = useState(false);
  const loaded = data !== null;
  useEffect(() => {
    if (loaded && takeSettingsSectionRequest('agent-disk')) setAsked(true);
  }, [loaded]);
  useEffect(() => {
    if (asked) ref.current?.scrollIntoView?.({ block: 'start' });
  }, [asked]);
  if (!data) return null;
  const line = freeLine(data) ?? (asked && data.homes.length === 0 ? fineLine(data) : null);
  if (!line && data.homes.length === 0) return null;

  const freeUp = async (agentId: string) => {
    setError(null);
    setBusy(agentId);
    try {
      const freed = await freeUpAgentHome(agentId);
      setDone((d) => ({ ...d, [agentId]: freedLine(freed) }));
      await execute();
    } catch (err) {
      setError(formatCommandError(asCommandError(err)));
    } finally {
      setBusy(null);
    }
  };

  return (
    <section
      ref={ref}
      className="settings-group agents-disk"
      aria-labelledby="agents-settings-disk"
    >
      <h3 className="settings-group__title" id="agents-settings-disk">
        Disk space
      </h3>
      <div className="settings-section">
        {line && (
          <div className="settings-row" data-disk-level={data.level}>
            <div className="settings-row-info">
              <span className="settings-row-label">On {THIS_COMPUTER}</span>
              <span className="settings-row-description">{line}</span>
            </div>
          </div>
        )}
        {data.homes.map((h) => (
          <div key={h.agentId} className="settings-row" data-disk-home={h.agentId}>
            <div className="settings-row-info">
              <span className="settings-row-label">{h.name}</span>
              <span
                className="settings-row-description"
                data-freed={done[h.agentId] ? '' : undefined}
              >
                {done[h.agentId] ?? homeLine(h)}
              </span>
            </div>
            {h.regenerableBytes > 0 && (
              <Button
                variant="secondary"
                disabled={busy !== null}
                onClick={() => void freeUp(h.agentId)}
              >
                {busy === h.agentId && <Spinner size="sm" />}
                Free up space
              </Button>
            )}
          </div>
        ))}
        {error && (
          <p className="agent-editor__error" role="alert">
            <ErrorIcon size={12} className="inline-error-icon" />
            {error}
          </p>
        )}
      </div>
    </section>
  );
}
