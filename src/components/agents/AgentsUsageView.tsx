/**
 * Usage: the whole stack of accounts agents run on, as a full view (the
 * sidebar's usage row, ⌘K "Usage and accounts…", the chat header's account
 * chip). Two levels:
 *
 * **The overview**, read top-down:
 * 1. **The total**: the room across every real account as one figure ("72%
 *    left across 2 accounts", each account counted equally), when the next
 *    refill is, and one bar made of a segment per account, in the work order,
 *    each labelled under it and opening that account.
 * 2. **Nearly out everywhere**: one calm bar with the options.
 * 3. **Accounts**: one row each, in the order turns try them (its place,
 *    name, a small bar, what it adds, In use / Next, refill), opening its page.
 * 4. **How agents use your limits**: Normal / Save my limits / Use it all
 *    before reset, its one line, and the spare-capacity nudge.
 * 5. Add an account, the crossover choice, the list of ideas for leftover usage and other
 *    compute on this Mac.
 *
 * **An account's page** (`AccountDetail`, "Usage › Work", Esc or the back
 * arrow to return; `requestUsageAccount` opens one from elsewhere): its
 * limit cards against pace, who used it this week (Limits | Tokens), where
 * its usage went, its notices and what to do with it.
 *
 * Every figure is a reading the Mac served; none is made up here
 * (`companion-protocol/usageGlance`).
 *
 * @module components/agents/AgentsUsageView
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { AddIcon, ArrowLeftIcon, ZapIcon } from '@/components/icons';
import { Button } from '../primitives/Button';
import { IconButton } from '../primitives/IconButton';
import { SegmentedControl } from '../primitives/SegmentedControl';
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '../primitives/Breadcrumb';
import { useOptionalToast } from '../../contexts/ToastContext';
import { asCommandError, formatCommandError } from '../../lib/errors';
import { ENGINE_LABEL, type AgentEngine } from '../../lib/agents';
import {
  addUsageAccount,
  onUsageAccountRequest,
  putAccountFirst,
  renameUsageAccount,
  reorderUsageAccounts,
  suggestName,
  takeAccountsRequest,
  takeUsageAccount,
  takeUsageAdd,
  type UsageAccount,
  type UsageAccountRef,
  USAGE_ID,
} from '../../lib/agentAccounts';
import {
  USAGE_MODES,
  USAGE_MODE_DETAIL,
  USAGE_MODE_LABEL,
  ADD_IT,
  NOT_NOW,
  estimateLine,
  localLine,
  markSignInChangeSeen,
  setUsageMode,
  setCrossover,
  spendSpareNow,
  type StackKey,
  type UsageGlance,
  type UsageMode,
} from '../../lib/agentsUsage';
import { takeSettingsSectionRequest } from '../../lib/settings';
import { onAccountSignIn, takeAccountSignIn } from '../../lib/settingsFromChat';
import { ADD_ACCOUNT_WHY } from '../../../packages/companion-protocol/src/accountSwitcher';
import { AccountSignIn } from './AccountSignIn';
import { EngineSignInModal } from './EngineSignInModal';
import { AgentsPageHeader, type AgentsPageCompact, type UsageCrumb } from './AgentsPageHeader';
import { AgentsCrossover } from './AgentsCrossover';
import { SpareList } from './AgentsUsage';
import { useUsageGlance } from './AccountSwitcher';
import { AccountDetail, AccountRow, SameNotes, TotalBar } from './UsageStack';

const say = (e: unknown) => formatCommandError(asCommandError(e));

export function AgentsUsageView({
  compact,
  onOpenAgent = () => {},
}: {
  compact?: AgentsPageCompact;
  onOpenAgent?: (agentId: string) => void;
} = {}) {
  // On an account's page the header is the breadcrumb ("Usage › Work"): the
  // header is where you are, so the page doesn't say it a second time. In a
  // compact window the header is the agent switcher, so the page keeps its own.
  const [crumb, setCrumb] = useState<UsageCrumb | null>(null);
  return (
    <section className="agent-chat agents-usage-view" aria-label="Usage">
      <AgentsPageHeader
        name="Usage"
        icon="lucide:gauge"
        pageId={USAGE_ID}
        compact={compact}
        onOpenAgent={onOpenAgent}
        crumb={compact ? null : crumb}
      />
      <div
        className="agent-chat__scroll"
        tabIndex={0}
        role="region"
        aria-label="Usage and accounts"
      >
        <div className="agents-usage-view__column">
          <UsagePanel onCrumb={compact ? undefined : setCrumb} />
        </div>
      </div>
    </section>
  );
}

/** `ids` with the entries at `a` and `b` exchanged. */
function swap(ids: readonly string[], a: number, b: number): string[] {
  const next = [...ids];
  [next[a], next[b]] = [next[b], next[a]];
  return next;
}

/**
 * Usage and accounts, the one rendering: the Usage view's body, and Settings
 * → Accounts & usage (`inSettings`), so the two can never disagree. In
 * Settings it also answers what opens that page: ⌘K's "Add an account…"
 * for an engine, and the Chief starting an account's sign-in from chat.
 */
export function UsagePanel({
  inSettings = false,
  onCrumb,
}: {
  inSettings?: boolean;
  /** The header shows where you are: the open account's name and the way back. */
  onCrumb?: (crumb: UsageCrumb | null) => void;
}) {
  const { showToast } = useOptionalToast();
  const { accounts, all, glance, inventory, now, engines, attempt, remove, reload } =
    useUsageGlance({ look: true });
  const [signingIn, setSigningIn] = useState<UsageAccount | null>(null);
  const [macSignIn, setMacSignIn] = useState<AgentEngine | null>(null);
  const [busy, setBusy] = useState(false);
  // The account whose page is showing; null on the overview.
  const [open, setOpen] = useState<UsageAccountRef | null>(() => takeUsageAccount());
  const installed = engines.filter((e) => e.installed).map((e) => e.id);
  const top = useRef<HTMLDivElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const cameFrom = useRef<string | null>(null);

  // Another surface asked for one account's page while this is showing.
  useEffect(() => onUsageAccountRequest(() => setOpen(takeUsageAccount())), []);

  const show = useCallback((ref: UsageAccountRef | null) => {
    if (ref) cameFrom.current = ref.id;
    setOpen(ref);
    // Each level starts at its top.
    const scroller = top.current?.closest('.agent-chat__scroll, .settings-content');
    if (scroller) scroller.scrollTop = 0;
  }, []);

  const key = open ? glance.keys.find((k) => k.engine === open.engine && k.id === open.id) : null;

  const crumbName = key?.name ?? null;
  useEffect(() => {
    onCrumb?.(crumbName ? { name: crumbName, back: () => show(null) } : null);
  }, [crumbName, onCrumb, show]);
  useEffect(() => () => onCrumb?.(null), [onCrumb]);

  // Arriving on a page puts focus on its name; coming back, on the row it was opened from.
  useEffect(() => {
    if (key) heading.current?.focus({ preventScroll: true });
    else if (cameFrom.current) {
      top.current
        ?.querySelector<HTMLElement>(`.usage-row[data-account="${CSS.escape(cameFrom.current)}"]`)
        ?.focus({ preventScroll: true });
      cameFrom.current = null;
    }
  }, [key?.key]); // eslint-disable-line react-hooks/exhaustive-deps

  // Esc (or ⌘[) goes back to the overview, unless something on the page is
  // taking it (a menu, a field being edited, a dialog).
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      const back = e.key === 'Escape' || (e.metaKey && e.key === '[');
      if (!back) return;
      const t = e.target as HTMLElement | null;
      if (t?.closest('input, textarea, [aria-modal="true"], [role="menu"]')) return;
      if (document.querySelector('[role="menu"], [aria-modal="true"]')) return;
      e.preventDefault();
      show(null);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, show]);

  // An account that went away (removed) leaves its page.
  useEffect(() => {
    if (open && accounts && !key) setOpen(null);
  }, [open, accounts, key]);

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

  // "This Mac's Claude Code is now signed in as …": answered once, either way.
  const answerChange = async (addIt: boolean) => {
    const change = glance.signInChanged;
    if (!change) return;
    try {
      await markSignInChangeSeen(change.key);
    } catch (e) {
      showToast(say(e), 'error');
    }
    if (addIt) void add(change.engine);
    reload();
  };

  const signInChanged = glance.signInChanged && (
    <div className="usage-bar" role="status" data-testid="usage-signin-changed">
      <p className="usage-bar__text">{glance.signInChanged.text}</p>
      <div className="usage-bar__actions">
        <Button
          variant="secondary"
          leftIcon={<AddIcon size={14} />}
          onClick={() => void answerChange(true)}
        >
          {ADD_IT}
        </Button>
        <Button variant="ghost" onClick={() => void answerChange(false)}>
          {NOT_NOW}
        </Button>
      </div>
    </div>
  );

  const pageOf = (k: StackKey) => {
    const ids = glance.engines.find((e) => e.engine === k.engine)?.keys.map((x) => x.id) ?? [];
    const i = ids.indexOf(k.id);
    const reorder = (order: string[]) => void attempt(() => reorderUsageAccounts(k.engine, order));
    return (
      <>
        {!onCrumb && (
          <div className="usage-crumbs">
            <IconButton
              variant="ghost"
              size="medium"
              icon={<ArrowLeftIcon size={14} />}
              aria-label="Back to Usage"
              onClick={() => show(null)}
            />
            <Breadcrumb aria-label="Where you are">
              <BreadcrumbList>
                <BreadcrumbItem>
                  <BreadcrumbLink onClick={() => show(null)}>Usage</BreadcrumbLink>
                </BreadcrumbItem>
                <BreadcrumbSeparator />
                <BreadcrumbItem>
                  <BreadcrumbPage aria-current="page">{k.name}</BreadcrumbPage>
                </BreadcrumbItem>
              </BreadcrumbList>
            </Breadcrumb>
          </div>
        )}
        <AccountDetail
          key={k.key}
          k={k}
          headingRef={heading}
          notice={glance.signInChanged?.engine === k.engine && k.thisMac ? signInChanged : null}
          actions={{
            onUse: () => void attempt(() => putAccountFirst(k.engine, k.id)),
            onSignIn: () => signIn(k.engine, k.id),
            onRename: (name) => attempt(() => renameUsageAccount(k.engine, k.id, name)),
            onRemove: () => {
              show(null);
              void remove(k.engine, k.id);
            },
            onMoveUp: i > 0 ? () => reorder(swap(ids, i, i - 1)) : undefined,
            onMoveDown:
              i >= 0 && i < ids.length - 1 ? () => reorder(swap(ids, i, i + 1)) : undefined,
          }}
        />
      </>
    );
  };

  return (
    <div className="usage-panel" ref={top} data-in-settings={inSettings || undefined}>
      {!accounts ? null : key ? (
        pageOf(key)
      ) : (
        <>
          {signInChanged}
          <TotalHero glance={glance} onOpen={(engine, id) => show({ engine, id })} />

          {glance.low && (
            <div className="usage-bar" role="status" data-testid="usage-low">
              <p className="usage-bar__text">{glance.low.text}</p>
              <div className="usage-bar__actions">
                {installed.length > 0 && (
                  <Button
                    variant="secondary"
                    leftIcon={<AddIcon size={14} />}
                    onClick={() => void add(glance.keys[0]?.engine ?? installed[0])}
                  >
                    Add an account
                  </Button>
                )}
                {glance.low.otherEngine && (
                  <Button
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

          {glance.keys.length > 0 && (
            <section className="usage-section" aria-labelledby="usage-accounts">
              <div className="usage-section__head">
                <h3 className="usage-section__title" id="usage-accounts">
                  Accounts
                </h3>
                {installed.length > 0 && (
                  <div className="usage-add__buttons">
                    {installed.map((engine) => (
                      <Button
                        key={engine}
                        variant="ghost"
                        leftIcon={<AddIcon size={14} />}
                        onClick={() => void add(engine)}
                        data-add-account={engine}
                      >
                        {installed.length > 1
                          ? `Add a ${ENGINE_LABEL[engine]} account`
                          : 'Add an account'}
                      </Button>
                    ))}
                  </div>
                )}
              </div>
              <p className="usage-section__muted">
                {glance.keys.length > 1
                  ? 'Work starts on the first account with room and carries on down. Open one to change its place.'
                  : `Your agents use this one. ${ADD_ACCOUNT_WHY}`}
              </p>
              {glance.engines.map((e) => (
                <div key={e.engine} className="usage-rows" data-engine={e.engine}>
                  {glance.engines.length > 1 && <h4 className="usage-rows__engine">{e.label}</h4>}
                  <ul className="usage-rows__list" aria-label={`${e.label} accounts, in order`}>
                    {e.keys.map((k) => (
                      <AccountRow
                        key={k.key}
                        k={k}
                        onOpen={() => show({ engine: k.engine, id: k.id })}
                        onSignIn={() => signIn(k.engine, k.id)}
                      />
                    ))}
                  </ul>
                </div>
              ))}
            </section>
          )}

          {glance.keys.length === 0 && installed.length > 0 && (
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

          {inventory && (
            <section className="usage-section" aria-labelledby="usage-max">
              <h3 className="usage-section__title" id="usage-max">
                How agents use your limits
              </h3>
              <SegmentedControl
                aria-label="How agents use your limits"
                value={inventory.mode}
                size="default"
                options={USAGE_MODES.map((m) => ({ value: m, label: USAGE_MODE_LABEL[m] }))}
                onValueChange={(m) => void choose(m)}
              />
              <p className="usage-section__muted">{USAGE_MODE_DETAIL[inventory.mode]}</p>
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
                        <Button variant="strong" disabled={busy} onClick={() => void spend()}>
                          Give agents something to do
                        </Button>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </section>
          )}

          {installed.length > 0 && (
            <AgentsCrossover
              installed={installed}
              signedIn={[...new Set(all.filter((a) => a.signedIn).map((a) => a.engine))]}
              now={now}
            />
          )}
          {inventory && <SpareList inventory={inventory} onChanged={reload} />}

          {inventory && inventory.local.length > 0 && (
            <section className="usage-section" aria-labelledby="usage-local">
              <h3 className="usage-section__title" id="usage-local">
                Other compute on this Mac
              </h3>
              <p className="usage-section__muted">
                Detected here, with no plan limits to read. Agents can run on OpenCode; they reach
                Ollama and LM Studio models only through it.
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
          nameOf={(id) =>
            glance.keys.find((k) => k.engine === signingIn.engine && k.id === id)?.name
          }
          onRemove={() => {
            void remove(signingIn.engine, signingIn.id);
            setSigningIn(null);
          }}
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

/**
 * The total first: what is left across every account, of what, and when it
 * next refills; then the bar, in the work order, each account under its
 * segment. Out everywhere, or nothing read, it says that instead of a figure.
 */
function TotalHero({
  glance,
  onOpen,
}: {
  glance: UsageGlance;
  onOpen: (engine: AgentEngine, id: string) => void;
}) {
  const { total } = glance;
  const out = glance.tone === 'limited';
  const figure = glance.unread
    ? glance.headline
    : out || total.left === null
      ? glance.row.figure
      : total.figure;
  const refill = out
    ? glance.row.refill
    : total.refill
      ? `Next refill in ${total.refill.in}${
          total.counted > 1 ? ` · ${total.refill.account}` : ''
        }, ${total.refill.at}`
      : null;
  return (
    <div
      className="usage-hero"
      data-tone={glance.tone}
      data-unread={total.left === null || undefined}
      data-testid="usage-hero"
    >
      <div className="usage-hero__answer">
        {/* With one account the page's title already says Usage. */}
        {total.segments.length > 1 && <p className="usage-hero__eyebrow">All accounts</p>}
        <h2 className="usage-hero__headline">
          {figure}
          {!out && total.left !== null && total.across && (
            <span className="usage-hero__across"> {total.across}</span>
          )}
        </h2>
        {refill && <p className="usage-hero__refill">{refill}</p>}
      </div>
      {/* One account: the bar alone; its name and room are the row below. */}
      <TotalBar total={total} size="large" onOpen={onOpen} labelled={total.segments.length > 1} />
      {(glance.estimate || total.unread || glance.sameNotes.length > 0) && (
        <div className="usage-hero__notes">
          {glance.estimate && (
            <p className="usage-hero__estimate">
              {glance.headline}. {glance.estimate}: an estimate, not a reading.
            </p>
          )}
          {total.unread && <p className="usage-hero__estimate">{total.unread}.</p>}
          <SameNotes notes={glance.sameNotes} />
        </div>
      )}
    </div>
  );
}
