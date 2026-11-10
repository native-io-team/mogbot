/**
 * The usage inventory, kept current (`useUsageInventory`), the
 * spare-capacity list (`SpareList`, in the Usage view), and What's in
 * flight's spare-capacity line (`AgentsSpareNote`).
 *
 * The list is work to do when capacity would otherwise expire. Users add
 * here; agents add with `add_spare_work`. Every row is a Line; nothing shown
 * that wasn't read or measured.
 *
 * Usage and accounts themselves have one rendering, the Usage view's
 * (`AgentsUsageView` `UsagePanel`), which Settings → Accounts & usage mounts too.
 *
 * @module components/agents/AgentsUsage
 */

import { useCallback, useEffect, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { Button } from '../primitives/Button';
import { IconButton } from '../primitives/IconButton';
import { TextField } from '../primitives/TextField';
import { CloseIcon } from '../icons';
import { useAsyncState } from '../../hooks/useAsyncState';
import { usePolling } from '../../hooks/usePolling';
import { useOptionalToast } from '../../contexts/ToastContext';
import { asCommandError, formatCommandError } from '../../lib/errors';
import { AGENT_EVENTS } from '../../lib/agents';
import {
  addSpareItem,
  getUsageInventory,
  glanceUsageInventory,
  onUsagePlanChanged,
  removeSpareItem,
  spareLine,
  type UsageInventory,
} from '../../lib/agentsUsage';

const say = (e: unknown) => formatCommandError(asCommandError(e));

/** Tauri's unlisten can reject (the event plugin gone, as under test mocks). */
const stop = (fn: () => void) => {
  void Promise.resolve()
    .then(fn)
    .catch(() => {});
};

/** The inventory, re-read when the plan or a reading changes, and every minute. */
/** `glance`: shown all the time (the sidebar's account row), so it never asks for a read. */
export function useUsageInventory({ glance = false }: { glance?: boolean } = {}) {
  const state = useAsyncState<UsageInventory>(glance ? glanceUsageInventory : getUsageInventory, {
    immediate: true,
  });
  const [now, setNow] = useState(() => Date.now());
  const { execute } = state;
  const reload = useCallback(() => {
    setNow(Date.now());
    void execute().catch(() => undefined);
  }, [execute]);
  usePolling(
    async () => {
      setNow(Date.now());
      return execute();
    },
    { intervalMs: 60_000, name: 'agents-usage' }
  );
  useEffect(() => {
    const offs: (() => void)[] = [];
    let gone = false;
    const keep = (fn: () => void) => (gone ? stop(fn) : offs.push(fn));
    void onUsagePlanChanged(reload)
      .then(keep)
      .catch(() => {});
    void listen(AGENT_EVENTS.quota, reload)
      .then(keep)
      .catch(() => {});
    return () => {
      gone = true;
      offs.forEach(stop);
    };
  }, [reload]);
  return { inventory: state.data ?? null, now, reload };
}

/** What's in flight: a window about to reset with capacity left. */
export function AgentsSpareNote() {
  const { inventory, now } = useUsageInventory();
  const line = spareLine(inventory, now);
  if (!line) return null;
  return (
    <p
      className="agents-usage-spare"
      role="status"
      title={line.detail}
      aria-label={`${line.text}. ${line.detail}`}
    >
      {line.text}
    </p>
  );
}

export function SpareList({
  inventory,
  onChanged,
}: {
  inventory: UsageInventory;
  onChanged: () => void;
}) {
  const { showToast } = useOptionalToast();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const name = (id?: string) => inventory.agents.find((a) => a.id === id)?.name;
  const add = async () => {
    if (!text.trim()) return;
    setBusy(true);
    try {
      await addSpareItem(text.trim());
      setText('');
      onChanged();
    } catch (e) {
      showToast(say(e), 'error');
    } finally {
      setBusy(false);
    }
  };
  const remove = async (id: string) => {
    try {
      await removeSpareItem(id);
      onChanged();
    } catch (e) {
      showToast(say(e), 'error');
    }
  };
  return (
    <div className="agents-usage__block">
      <span className="agents-usage__heading">Spare-capacity list</span>
      <span className="agents-usage__muted">
        Work for when capacity would otherwise expire. Agents can add to it too.
      </span>
      {inventory.backlog.length > 0 && (
        <ul className="agents-usage__list">
          {inventory.backlog.map((item) => {
            const who = name(item.agentId);
            const by = item.addedBy === 'you' ? 'Added by you' : `Added by ${item.addedBy}`;
            return (
              <li className="agents-usage__line" key={item.id}>
                <div className="agents-usage__info">
                  <span className="agents-usage__name">{item.text}</span>
                  <span className="agents-usage__muted">
                    {[by, who && `for ${who}`, item.state === 'started' ? 'Started' : null]
                      .filter(Boolean)
                      .join(' · ')}
                  </span>
                </div>
                <IconButton
                  size="compact"
                  variant="ghost"
                  icon={<CloseIcon size={14} />}
                  aria-label={`Remove “${item.text}”`}
                  onClick={() => void remove(item.id)}
                />
              </li>
            );
          })}
        </ul>
      )}
      <form
        className="agents-usage__add"
        onSubmit={(e) => {
          e.preventDefault();
          void add();
        }}
      >
        <TextField
          className="agents-usage__field"
          value={text}
          maxLength={600}
          placeholder="Research I’d like done sometime…"
          aria-label="Add to the spare-capacity list"
          onChange={(e) => setText(e.target.value)}
        />
        <Button type="submit" variant="secondary" disabled={busy || !text.trim()}>
          Add
        </Button>
      </form>
    </div>
  );
}
