/**
 * Usage before the wall: "Claude usage 85% · resets Sat", at the foot of the
 * sidebar and of What's in flight. Grok Bot's bots went silent at the limit;
 * here it is said before, quietly, and turns amber at 90%.
 *
 * Only what an engine reported (`agents_quota`: Claude Code's
 * `rate_limit_event`, Codex's `account/rateLimits`). No reading, no line: an
 * API-key login, or an engine that hasn't run a turn yet, shows nothing.
 * Re-read when an engine reports again, and every minute, so a window whose
 * reset has passed goes away instead of lingering as history.
 *
 * @module components/agents/AgentsQuota
 */

import { useEffect, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { useAsyncState } from '../../hooks/useAsyncState';
import { usePolling } from '../../hooks/usePolling';
import { AGENT_EVENTS, getQuotas, quotaLines, type Quota } from '../../lib/agents';

export function useQuotaLines() {
  const quotas = useAsyncState<Quota[]>(getQuotas, { immediate: true });
  const [now, setNow] = useState(() => Date.now());
  const { execute } = quotas;
  usePolling(
    async () => {
      setNow(Date.now());
      return execute();
    },
    { intervalMs: 60_000, name: 'agents-quota' }
  );
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let gone = false;
    void listen(AGENT_EVENTS.quota, () => {
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
      // The unlisten call is async inside Tauri and can reject once the
      // event plugin is gone (window teardown, test cleanup); nothing to do.
      void Promise.resolve(unlisten?.()).catch(() => {});
    };
  }, [execute]);
  return quotas.data ? quotaLines(quotas.data, now) : [];
}

/** `place`: the sidebar's foot, or What's in flight's. */
export function AgentsQuota({ place }: { place: 'sidebar' | 'team' }) {
  const lines = useQuotaLines();
  if (lines.length === 0) return null;
  return (
    <div className={`agents-quota agents-quota--${place}`} role="status">
      {lines.map((line) => (
        <p
          key={line.engine}
          className="agents-quota__line"
          data-tone={line.tone}
          title={line.detail}
          aria-label={`${line.text}. ${line.detail}`}
        >
          {line.text}
        </p>
      ))}
    </div>
  );
}
