/**
 * Usage: the whole stack of accounts agents run on, as a full view (the
 * sidebar's usage row, ⌘K "Usage and accounts…", the chat header's account
 * chip).
 *
 * Read top-down:
 * 1. **The answer**: one headline ("Plenty of room", "Runs out ~Thu, 2 days
 *    before reset", labelled as an estimate when it is one), the stack as one
 *    big segmented meter with each account named under its segment, and the
 *    soonest reset, relative and absolute.
 * 2. **Max it out**: the mode (Normal / Save my limits / Use it all before
 *    reset), and when a window on the account in use resets soon with room
 *    left, a nudge with what it would spend it on and one button to start it.
 * 3. **Nearly out everywhere**: one calm bar with the options (add an
 *    account, carry on with the other engine, wait until the reset).
 * 4. **The stack**: each engine's accounts as keys in the order turns try
 *    them, dragged to reorder (the handle also moves with the keyboard).
 *    Each key: its place, name, plan and who, state, its 5-hour and weekly
 *    limits with resets, who used it this week, the fix for a sign-in
 *    problem, "Use this one now", and "Where did my usage go".
 * 5. Add an account in one click, the crossover choice, the spare-capacity
 *    list and other compute on this Mac.
 *
 * Every figure is a reading the Mac served; none is made up here
 * (`companion-protocol/usageGlance`).
 *
 * @module components/agents/AgentsUsageView
 */

import { useEffect, useRef, useState } from 'react';
import { AddIcon, ZapIcon } from '@/components/icons';
import { Button } from '../primitives/Button';
import { SegmentedControl } from '../primitives/SegmentedControl';
import { DragSortItem, DragSortScope } from '../primitives/DragSort';
import { useOptionalToast } from '../../contexts/ToastContext';
import { asCommandError, formatCommandError } from '../../lib/errors';
import { ENGINE_LABEL, type AgentEngine } from '../../lib/agents';
import {
  addUsageAccount,
  putAccountFirst,
  renameUsageAccount,
  reorderUsageAccounts,
  suggestName,
  takeAccountsRequest,
  takeUsageAdd,
  type UsageAccount,
} from '../../lib/agentAccounts';
import {
  USAGE_MODES,
  USAGE_MODE_DETAIL,
  USAGE_MODE_LABEL,
  estimateLine,
  localLine,
  setUsageMode,
  setCrossover,
  spendSpareNow,
  type StackEngine,
  type UsageMode,
} from '../../lib/agentsUsage';
import { takeSettingsSectionRequest } from '../../lib/settings';
import { onAccountSignIn, takeAccountSignIn } from '../../lib/settingsFromChat';
import { ADD_ACCOUNT_WHY } from '../../../packages/companion-protocol/src/accountSwitcher';
import { AccountSignIn } from './AccountSignIn';
import { EngineSignInModal } from './EngineSignInModal';
import { AgentsCrossover } from './AgentsCrossover';
import { SpareList } from './AgentsUsage';
import { useUsageGlance } from './AccountSwitcher';
import { StackMeter, UsageKey } from './UsageStack';

const say = (e: unknown) => formatCommandError(asCommandError(e));

export function AgentsUsageView() {
  return (
    <section className="agent-chat agents-usage-view" aria-label="Usage">
      <header className="agent-chat__header">
        <div className="agent-chat__title">Usage</div>
      </header>
      <div
        className="agent-chat__scroll"
        tabIndex={0}
        role="region"
        aria-label="Usage and accounts"
      >
        <div className="agents-usage-view__column">
          <UsagePanel />
        </div>
      </div>
    </section>
  );
}

/**
 * Usage and accounts, the one rendering: the Usage view's body, and Settings
 * → Accounts & usage (`inSettings`), so the two can never disagree. In
 * Settings it also answers what opens that page: ⌘K's "Add an account…"
 * for an engine, and the Chief starting an account's sign-in from chat.
 */
export function UsagePanel({ inSettings = false }: { inSettings?: boolean }) {
  const { showToast } = useOptionalToast();
  const { accounts, all, glance, inventory, now, engines, attempt, remove, reload } =
    useUsageGlance({ look: true });
  const [signingIn, setSigningIn] = useState<UsageAccount | null>(null);
  const [macSignIn, setMacSignIn] = useState<AgentEngine | null>(null);
  const [busy, setBusy] = useState(false);
  const installed = engines.filter((e) => e.installed).map((e) => e.id);

  const add = async (engine: AgentEngine) => {
    let added: UsageAccount | null = null;
    const ok = await attempt(async () => {
      const a = await addUsageAccount(engine, suggestName(all, engine));
      added = { ...a, thisMac: false, signedIn: false, out: false };
    });
    if (ok && added) setSigningIn(added);
  };

  // ⌘K "Add an account…": straight to adding one, when there's one engine to
  // add to. In Settings, also the palette's request for a given engine, and
  // being scrolled to.
  const top = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (installed.length === 0) return;
    const asked = inSettings ? takeAccountsRequest() : null;
    if (inSettings && takeSettingsSectionRequest('agent-usage')) {
      top.current?.scrollIntoView?.({ block: 'start' });
    }
    if (asked && asked !== 'show' && installed.includes(asked)) void add(asked);
    else if (takeUsageAdd()) void add(installed[0]);
    // Once, when the engines are known.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [installed.length]);

  // An account the Chief added from chat (`manage_account add`): its
  // sign-in runs here, once the list has it. Only Settings answers, which is
  // where the Chief's request opens, so two sign-ins never start.
  const [signInFor, setSignInFor] = useState<string | null>(() =>
    inSettings ? takeAccountSignIn() : null
  );
  useEffect(() => (inSettings ? onAccountSignIn(setSignInFor) : undefined), [inSettings]);
  useEffect(() => {
    if (!signInFor) return;
    const asked = all.find((a) => a.id === signInFor);
    if (!asked) return;
    setSignInFor(null);
    if (!asked.signedIn) setSigningIn(asked);
  }, [signInFor, all]);

  const signIn = (engine: AgentEngine, id: string) => {
    const account = all.find((a) => a.engine === engine && a.id === id);
    if (!account) return;
    if (account.thisMac) setMacSignIn(engine);
    else setSigningIn(account);
  };

  const choose = async (mode: UsageMode) => {
    try {
      await setUsageMode(mode);
      reload();
    } catch (e) {
      showToast(say(e), 'error');
    }
  };

  const spend = async () => {
    setBusy(true);
    try {
      showToast(await spendSpareNow(), 'success');
      reload();
    } catch (e) {
      showToast(say(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  const carryOn = async (from: AgentEngine) => {
    try {
      await setCrossover(from, 'carry');
      showToast(
        `When every ${ENGINE_LABEL[from]} account is out, agents carry on with the other engine.`,
        'success'
      );
      reload();
    } catch (e) {
      showToast(say(e), 'error');
    }
  };

  return (
    <div className="usage-panel" ref={top} data-in-settings={inSettings || undefined}>
      {!accounts ? null : (
        <>
          <div className="usage-hero" data-tone={glance.tone} data-testid="usage-hero">
            <p className="usage-hero__eyebrow">
              {glance.keys.length === 1 ? 'Your account' : 'Your accounts, together'}
            </p>
            {glance.unread ? (
              // Nothing read yet: the account, and one quiet line. Display size is for a reading.
              <>
                <h2 className="usage-hero__name">
                  {glance.keys.length === 1 ? glance.keys[0].name : glance.summary}
                </h2>
                <p className="usage-hero__reset">No usage reading yet.</p>
              </>
            ) : (
              <h2 className="usage-hero__headline">{glance.headline}</h2>
            )}
            {glance.estimate && (
              <p className="usage-hero__estimate">{glance.estimate}. An estimate, not a reading.</p>
            )}
            <StackMeter keys={glance.keys} size="large" labelled />
            {glance.soonest && (
              <p className="usage-hero__reset">
                Next reset: {glance.soonest.account}’s {glance.soonest.label.toLowerCase()} limit,{' '}
                {glance.soonest.resetsIn} ({glance.soonest.resetsAt})
              </p>
            )}
          </div>

          {glance.low && (
            <div className="usage-bar" role="status" data-testid="usage-low">
              <p className="usage-bar__text">{glance.low.text}</p>
              <div className="usage-bar__actions">
                {installed.length > 0 && (
                  <Button
                    size="compact"
                    variant="secondary"
                    leftIcon={<AddIcon size={14} />}
                    onClick={() => void add(glance.keys[0]?.engine ?? installed[0])}
                  >
                    Add an account
                  </Button>
                )}
                {glance.low.otherEngine && (
                  <Button
                    size="compact"
                    variant="secondary"
                    onClick={() =>
                      void carryOn(
                        glance.engines.find((e) => e.engine !== glance.low?.otherEngine)?.engine ??
                          'claude'
                      )
                    }
                  >
                    Carry on with {ENGINE_LABEL[glance.low.otherEngine]}
                  </Button>
                )}
                {glance.low.waitUntil && (
                  <span className="usage-bar__wait">{glance.low.waitUntil}</span>
                )}
              </div>
            </div>
          )}

          {inventory && (
            <section className="usage-section" aria-labelledby="usage-max">
              <h3 className="usage-section__title" id="usage-max">
                Get the most from your limits
              </h3>
              {glance.nudge && (
                <div className="usage-nudge" data-testid="usage-nudge">
                  <ZapIcon size={16} className="usage-nudge__icon" />
                  <div className="usage-nudge__body">
                    <p className="usage-nudge__text">{glance.nudge.text}</p>
                    <p className="usage-nudge__question">{glance.nudge.question}</p>
                    {glance.nudge.items.length > 0 && (
                      <ul className="usage-nudge__items" aria-label="It would start">
                        {glance.nudge.items.map((t) => (
                          <li key={t}>{t}</li>
                        ))}
                        {glance.nudge.more > 0 && (
                          <li className="usage-nudge__more">and {glance.nudge.more} more</li>
                        )}
                      </ul>
                    )}
                    {!glance.nudge.empty && (
                      <div className="usage-nudge__actions">
                        <Button
                          variant="strong"
                          size="compact"
                          disabled={busy}
                          onClick={() => void spend()}
                        >
                          Give agents something to do
                        </Button>
                      </div>
                    )}
                  </div>
                </div>
              )}
              <SegmentedControl
                aria-label="How agents use your limits"
                value={inventory.mode}
                size="default"
                options={USAGE_MODES.map((m) => ({ value: m, label: USAGE_MODE_LABEL[m] }))}
                onValueChange={(m) => void choose(m)}
              />
              <p className="usage-section__muted">{USAGE_MODE_DETAIL[inventory.mode]}</p>
            </section>
          )}

          {glance.engines.map((e) => (
            <EngineStack
              key={e.engine}
              engine={e}
              several={glance.engines.length > 1}
              onReorder={(ids) => void attempt(() => reorderUsageAccounts(e.engine, ids))}
              onUse={(id) => void attempt(() => putAccountFirst(e.engine, id))}
              onSignIn={(id) => signIn(e.engine, id)}
              onRename={(id, name) => attempt(() => renameUsageAccount(e.engine, id, name))}
              onRemove={(id) => void remove(e.engine, id)}
            />
          ))}

          {installed.length > 0 && (
            <div className="usage-add">
              <div className="usage-add__buttons">
                {installed.map((engine) => (
                  <Button
                    key={engine}
                    variant="secondary"
                    leftIcon={<AddIcon size={14} />}
                    onClick={() => void add(engine)}
                    data-add-account={engine}
                  >
                    Add a {ENGINE_LABEL[engine]} account
                  </Button>
                ))}
              </div>
              <p className="usage-section__muted">{ADD_ACCOUNT_WHY}</p>
            </div>
          )}

          {installed.length > 0 && <AgentsCrossover installed={installed} now={now} />}
          {inventory && <SpareList inventory={inventory} onChanged={reload} />}

          {inventory && inventory.local.length > 0 && (
            <section className="usage-section" aria-labelledby="usage-local">
              <h3 className="usage-section__title" id="usage-local">
                Other compute on this Mac
              </h3>
              <p className="usage-section__muted">
                Detected here. Agents don’t run on it; project terminals can.
              </p>
              <ul className="usage-section__list">
                {inventory.local.map((l) => (
                  <li key={l.name}>{localLine(l)}</li>
                ))}
              </ul>
            </section>
          )}

          {inventory &&
            inventory.engines
              .filter((e) => e.installed)
              .map((e) => ({ id: e.id, line: estimateLine(e.perTurn) }))
              .filter((e) => e.line !== null)
              .map((e) => (
                // An estimate from past runs, said as one; absent with too little history.
                <p className="usage-section__muted" key={e.id} data-estimate={e.id}>
                  {ENGINE_LABEL[e.id]}: {e.line}
                </p>
              ))}

          <p className="usage-section__muted usage-view__foot">
            As each account last reported it. Use of the same plan anywhere else counts too.
          </p>
        </>
      )}
      {signingIn && (
        <AccountSignIn
          account={signingIn}
          onDone={() => {
            setSigningIn(null);
            reload();
          }}
        />
      )}
      {macSignIn && (
        <EngineSignInModal engine={macSignIn} step="sign-in" onClose={() => setMacSignIn(null)} />
      )}
    </div>
  );
}

function EngineStack({
  engine,
  several,
  onReorder,
  onUse,
  onSignIn,
  onRename,
  onRemove,
}: {
  engine: StackEngine;
  several: boolean;
  onReorder: (ids: string[]) => void;
  onUse: (id: string) => void;
  onSignIn: (id: string) => void;
  onRename: (id: string, name: string) => Promise<boolean>;
  onRemove: (id: string) => void;
}) {
  const ids = engine.keys.map((k) => k.id);
  const draggable = engine.keys.length > 1;
  return (
    <section
      className="usage-section usage-engine"
      aria-labelledby={`usage-engine-${engine.engine}`}
      data-engine={engine.engine}
    >
      <h3 className="usage-section__title" id={`usage-engine-${engine.engine}`}>
        {several ? `${engine.label} accounts` : 'Accounts'}
      </h3>
      <p className="usage-section__muted">
        {draggable
          ? 'Turns start on the first with room and carry on down. Drag to change the order.'
          : 'Turns run on this one.'}
      </p>
      <DragSortScope
        label={`${engine.label} account order`}
        items={ids}
        onMove={(move) => {
          const order = move.projectedOrder?.map(String);
          if (order && order.join() !== ids.join()) onReorder(order);
        }}
      >
        <div className="usage-engine__keys">
          {engine.keys.map((k, i) => (
            <DragSortItem
              key={k.key}
              id={k.id}
              group={engine.engine}
              index={i}
              label={k.name}
              disabled={!draggable}
              className="usage-engine__slot"
            >
              <UsageKey
                k={k}
                draggable={draggable}
                actions={{
                  onUse: () => onUse(k.id),
                  onSignIn: () => onSignIn(k.id),
                  onRename: (name) => onRename(k.id, name),
                  onRemove: () => onRemove(k.id),
                }}
              />
            </DragSortItem>
          ))}
        </div>
      </DragSortScope>
    </section>
  );
}
