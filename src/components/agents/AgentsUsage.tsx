/**
 * Settings → Agents → Usage, and What's in flight's spare-capacity line.
 *
 * - **How agents use your limits**: Normal (default, never throttles), Save
 *   my limits, or Use it all before reset (`agents::usage_plan`).
 * - **What you have**: each account with what its engine last reported (a
 *   reading, with its age) or "No reading yet"; each engine's average turn
 *   here as an *estimate* from past runs, absent with too little history;
 *   under an account, the Mac's pace estimate for a window that would run
 *   out before its reset ("5-hour: At this pace you'll hit the limit…"),
 *   with what it rests on;
 *   other compute detected on this Mac.
 * - **Spare-capacity list**: work to do when capacity would otherwise
 *   expire. Users add here; agents add with `add_spare_work`.
 *
 * Every row is a Line; nothing shown that wasn't read or measured.
 *
 * @module components/agents/AgentsUsage
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { Button } from '../primitives/Button';
import { IconButton } from '../primitives/IconButton';
import { SegmentedControl } from '../primitives/SegmentedControl';
import { TextField } from '../primitives/TextField';
import { CloseIcon } from '../icons';
import { useAsyncState } from '../../hooks/useAsyncState';
import { usePolling } from '../../hooks/usePolling';
import { useOptionalToast } from '../../contexts/ToastContext';
import { asCommandError, formatCommandError } from '../../lib/errors';
import { AGENT_EVENTS, ENGINE_LABEL } from '../../lib/agents';
import { takeSettingsSectionRequest } from '../../lib/settings';
import { ComputeTotal } from './AgentsCompute';
import {
  USAGE_MODES,
  USAGE_MODE_DETAIL,
  USAGE_MODE_LABEL,
  accountTags,
  accountUsage,
  addSpareItem,
  computeView,
  estimateLine,
  getUsageInventory,
  localLine,
  onUsagePlanChanged,
  paceLine,
  removeSpareItem,
  setUsageMode,
  spareLine,
  windowName,
  type UsageAccountLine,
  type UsageInventory,
  type UsageMode,
} from '../../lib/agentsUsage';

/** "5-hour", "Weekly": which of the account's windows a pace line is for. */
const windowLabel = (a: UsageAccountLine, kind: string) => {
  const w = a.windows.find((x) => x.kind === kind);
  const name = windowName(w ?? { kind });
  return name.charAt(0).toUpperCase() + name.slice(1);
};

const say = (e: unknown) => formatCommandError(asCommandError(e));

/** Tauri's unlisten can reject (the event plugin gone, as under test mocks). */
const stop = (fn: () => void) => {
  void Promise.resolve()
    .then(fn)
    .catch(() => {});
};

/** The inventory, re-read when the plan or a reading changes, and every minute. */
export function useUsageInventory() {
  const state = useAsyncState<UsageInventory>(getUsageInventory, { immediate: true });
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

function SpareList({ inventory, onChanged }: { inventory: UsageInventory; onChanged: () => void }) {
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

export function AgentUsageSettings() {
  const { showToast } = useOptionalToast();
  const { inventory, now, reload } = useUsageInventory();
  const ref = useRef<HTMLElement>(null);
  const ready = inventory !== null;
  // ⌘K "Usage limits and spare capacity…": shown, not left below the fold.
  useEffect(() => {
    if (ready && takeSettingsSectionRequest('agent-usage')) {
      ref.current?.scrollIntoView?.({ block: 'start' });
    }
  }, [ready]);
  if (!inventory) return null;
  const choose = async (mode: UsageMode) => {
    try {
      await setUsageMode(mode);
      reload();
    } catch (e) {
      showToast(say(e), 'error');
    }
  };
  const engines = inventory.engines.filter((e) => e.installed);
  const spare = spareLine(inventory, now);
  const total = computeView(inventory, now);
  const estimates = engines
    .map((e) => ({ id: e.id, line: estimateLine(e.perTurn) }))
    .filter((e): e is { id: typeof e.id; line: string } => e.line !== null);

  return (
    <section
      className="settings-group agents-usage"
      aria-labelledby="agents-settings-usage"
      ref={ref}
    >
      <h3 className="settings-group__title" id="agents-settings-usage">
        Usage
      </h3>
      <div className="agents-usage__block">
        <span className="agents-usage__heading">How agents use your limits</span>
        <SegmentedControl
          aria-label="How agents use your limits"
          value={inventory.mode}
          size="default"
          options={USAGE_MODES.map((m) => ({ value: m, label: USAGE_MODE_LABEL[m] }))}
          onValueChange={(m) => void choose(m)}
        />
        <span className="agents-usage__muted">{USAGE_MODE_DETAIL[inventory.mode]}</span>
      </div>

      {engines.length > 0 && total && (
        <div className="agents-usage__block">
          <span className="agents-usage__heading">What you have</span>
          <ComputeTotal view={total} />
          {estimates.map((e) => (
            <span className="agents-usage__muted" key={e.id}>
              {ENGINE_LABEL[e.id]}: {e.line}
            </span>
          ))}
          {spare && (
            <span className="agents-usage-spare" title={spare.detail}>
              {spare.text}
            </span>
          )}
          <span className="agents-usage__muted">
            As each account last reported it. Use of the same plan anywhere else counts too.
          </span>
        </div>
      )}

      {engines.length > 0 && !total && (
        <div className="agents-usage__block">
          <span className="agents-usage__heading">What you have</span>
          <span className="agents-usage__muted">
            Limits as each engine last reported them. Use elsewhere counts too.
          </span>
          {engines.map((engine) => {
            const est = estimateLine(engine.perTurn);
            return (
              <ul className="agents-usage__list" key={engine.id} data-engine={engine.id}>
                {inventory.accounts
                  .filter((a) => a.engine === engine.id)
                  .map((a) => {
                    const state = accountUsage(a, now);
                    const tags = accountTags(a);
                    return (
                      <li className="agents-usage__line" key={a.id} data-tone={state.tone}>
                        <div className="agents-usage__info">
                          <span className="agents-usage__name">
                            {ENGINE_LABEL[engine.id]} · {a.name}
                          </span>
                          <span className="agents-usage__state">{state.text}</span>
                          {(a.out ? [] : (a.pace ?? [])).map((p) => {
                            const pace = paceLine(p, now);
                            return (
                              pace && (
                                <span
                                  className="agents-usage__pace"
                                  key={p.kind}
                                  title={pace.basis}
                                >
                                  {windowLabel(a, p.kind)}: {pace.text} · {pace.basis}
                                </span>
                              )
                            );
                          })}
                          {tags.length > 0 && (
                            <span className="agents-usage__muted">{tags.join(' · ')}</span>
                          )}
                        </div>
                      </li>
                    );
                  })}
                {est && (
                  <li className="agents-usage__line agents-usage__line--estimate">
                    <span className="agents-usage__muted">{est}</span>
                  </li>
                )}
              </ul>
            );
          })}
          {spare && (
            <span className="agents-usage-spare" title={spare.detail}>
              {spare.text}
            </span>
          )}
        </div>
      )}

      {inventory.local.length > 0 && (
        <div className="agents-usage__block">
          <span className="agents-usage__heading">Other compute on this Mac</span>
          <span className="agents-usage__muted">
            Detected here. Agents don’t run on it; project terminals can.
          </span>
          <ul className="agents-usage__list">
            {inventory.local.map((l) => (
              <li className="agents-usage__line" key={l.name}>
                <span className="agents-usage__name">{localLine(l)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <SpareList inventory={inventory} onChanged={reload} />
    </section>
  );
}
