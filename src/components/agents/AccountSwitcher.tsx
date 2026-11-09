/**
 * Which account is working, always in sight: a row at the foot of the
 * Agents sidebar ("Work · 62% left") that opens every account in one
 * popover, to swap, reorder, rename, sign in again, remove or add, without
 * leaving it (a sign-in runs in its own terminal over the app).
 *
 * "Use this one now" puts an account first in its engine's order
 * (`agents_account_use`): every turn that starts from then on tries it
 * first; a turn already running finishes on its own account, and an agent
 * set to one account ("Runs on" in its … menu) stays there. The row and the
 * list change at once, from the order the Mac answers with.
 *
 * Words and figures are the phone's too (`companion-protocol/accountSwitcher`):
 * only what an engine reported; an account nobody has read shows no figure.
 * This row never asks for a reading itself (`glance`); opening the popover
 * does, as any look at usage does.
 *
 * ⌘K "Switch account…" and "Add an account…" open it.
 *
 * @module components/agents/AccountSwitcher
 */

import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import {
  AddIcon,
  ArrowDownIcon,
  ArrowUpIcon,
  CheckIcon,
  ClaudeIcon,
  CodexIcon,
  EditIcon,
  MoreHorizontalIcon,
  ResetIcon,
  TrashIcon,
} from '@/components/icons';
import { Button } from '../primitives/Button';
import { IconButton } from '../primitives/IconButton';
import { TextField } from '../primitives/TextField';
import { Tooltip } from '../primitives/Tooltip';
import { Dropdown, DropdownDivider, DropdownItem } from '../primitives/Dropdown';
import { FooterRowIcon, type FooterRowStatus } from '../workspace/FooterRowIcon';
import { AccountSignIn } from './AccountSignIn';
import { EngineSignInModal } from './EngineSignInModal';
import { useUsageAccounts } from './useUsageAccounts';
import { useUsageInventory } from './AgentsUsage';
import { useAgentsSelector } from '../../lib/agentsStore';
import { ENGINE_LABEL, type Agent, type AgentEngine, type EngineInfo } from '../../lib/agents';
import {
  addUsageAccount,
  onSwitcherRequest,
  requestSwitcher,
  renameUsageAccount,
  reorderUsageAccounts,
  suggestName,
  putAccountFirst,
  type UsageAccount,
} from '../../lib/agentAccounts';
import {
  ADD_ACCOUNT_WHY,
  movedIds,
  pinnedLine,
  switcherView,
  workingLine,
  type SwitcherEngine,
  type SwitcherRow,
  type WorkingLine,
} from '../../../packages/companion-protocol/src/accountSwitcher';
import { awayStateOf } from '../../../packages/companion-protocol/src/crossover';

const ENGINE_ICON: Record<AgentEngine, typeof ClaudeIcon> = {
  claude: ClaudeIcon,
  codex: CodexIcon,
};

const STATUS: Record<WorkingLine['tone'], FooterRowStatus> = {
  ok: 'ok',
  warning: 'warn',
  out: 'down',
  off: 'off',
};

const selectEngines = (s: { engines: EngineInfo[] }) => s.engines;
const selectAgents = (s: { agents: Agent[] }) => s.agents;

/**
 * The engines worth a line: installed ones that agents run on, or that have
 * more than one account; else every installed one.
 */
export function shownEngines(
  engines: EngineInfo[],
  agents: Pick<Agent, 'engine'>[],
  accounts: UsageAccount[]
): AgentEngine[] {
  const installed = engines.filter((e) => e.installed).map((e) => e.id);
  const used = installed.filter(
    (e) => agents.some((a) => a.engine === e) || accounts.filter((a) => a.engine === e).length > 1
  );
  return used.length > 0 ? used : installed;
}

export function AccountSwitcher({ collapsed }: { collapsed: boolean }) {
  const { accounts, attempt, remove } = useUsageAccounts();
  const engines = useAgentsSelector(selectEngines);
  const agents = useAgentsSelector(selectAgents);
  const [open, setOpen] = useState(false);
  const [adding, setAdding] = useState<AgentEngine | 'pick' | null>(null);
  const [signingIn, setSigningIn] = useState<UsageAccount | null>(null);
  const [macSignIn, setMacSignIn] = useState<AgentEngine | null>(null);
  // A glance while closed; opening it is a look, which reads every account.
  const { inventory, now } = useUsageInventory({ glance: !open });

  const installed = useMemo(() => engines.filter((e) => e.installed).map((e) => e.id), [engines]);
  useEffect(
    () =>
      onSwitcherRequest((what) => {
        setOpen(true);
        if (what === 'add') setAdding(installed.length === 1 ? installed[0] : 'pick');
      }),
    [installed]
  );

  const pins = useMemo(
    () =>
      agents
        .filter((a) => a.account)
        .map((a) => ({ engine: a.engine, account: a.account as string, name: a.name })),
    [agents]
  );
  const all = accounts ?? [];
  const view = switcherView(all, inventory, {
    now,
    engines: shownEngines(engines, agents, all),
    pins,
  });
  const lines = view
    .map((v) => workingLine(v, awayStateOf(v.engine, agents, now), now))
    .filter((l): l is WorkingLine => l !== null);
  if (!accounts || lines.length === 0) return null;

  const worst = lines.find((l) => l.tone === 'out') ?? lines.find((l) => l.tone === 'warning');
  const status = STATUS[(worst ?? lines[0]).tone];
  const label = lines.map((l) => l.detail).join(' ');

  const close = () => {
    setOpen(false);
    setAdding(null);
  };

  return (
    <>
      <Dropdown
        align="left"
        side="top"
        portal
        presentation="popover"
        ariaLabel="Accounts"
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) setAdding(null);
        }}
        menuClassName="account-switcher"
        className="account-switcher__anchor"
        trigger={(p) => (
          <Button
            {...p}
            variant="ghost"
            width="fill"
            className={`remote-indicator account-switcher__row${
              collapsed ? ' remote-indicator--compact' : ''
            }`}
            title={label}
            aria-label={`Accounts. ${label}`}
            data-testid="account-switcher"
            leftIcon={
              <FooterRowIcon
                icon={(() => {
                  const Icon = ENGINE_ICON[lines[0].engine];
                  return <Icon size={14} />;
                })()}
                status={status}
              />
            }
          >
            {!collapsed && (
              <span className="account-switcher__lines">
                {lines.map((l) => (
                  <span
                    key={l.engine}
                    className="account-switcher__line"
                    data-tone={l.tone}
                    data-away={l.away || undefined}
                  >
                    <span className="account-switcher__name">{l.name}</span>
                    {l.room && <span className="account-switcher__room">{l.room}</span>}
                  </span>
                ))}
              </span>
            )}
          </Button>
        )}
      >
        {open && (
          <SwitcherBody
            view={view}
            all={all}
            installed={installed}
            adding={adding}
            setAdding={setAdding}
            onUse={(row) => void attempt(() => putAccountFirst(row.engine, row.id))}
            onMove={(engine, ids) => void attempt(() => reorderUsageAccounts(engine, ids))}
            onRename={(row, name) => attempt(() => renameUsageAccount(row.engine, row.id, name))}
            onRemove={(row) => void remove(row.engine, row.id)}
            onSignIn={(row) => {
              const account = all.find((a) => a.engine === row.engine && a.id === row.id);
              close();
              if (row.thisMac) setMacSignIn(row.engine);
              else if (account) setSigningIn(account);
            }}
            onAdd={async (engine, name) => {
              let added: UsageAccount | null = null;
              const ok = await attempt(async () => {
                const a = await addUsageAccount(engine, name);
                added = { ...a, thisMac: false, signedIn: false, out: false };
              });
              if (ok && added) {
                close();
                setSigningIn(added);
              }
              return ok;
            }}
          />
        )}
      </Dropdown>
      {signingIn && <AccountSignIn account={signingIn} onDone={() => setSigningIn(null)} />}
      {macSignIn && (
        <EngineSignInModal engine={macSignIn} step="sign-in" onClose={() => setMacSignIn(null)} />
      )}
    </>
  );
}

/**
 * The chat header's chip: the account this agent's last turn ran on, once
 * its engine has more than one (the Mac sends `ranOn` only then). Opens the
 * accounts. "only" when it is set to run on that one.
 */
export function AgentAccountChip({ agent }: { agent: Agent }) {
  if (!agent.ranOn) return null;
  const only = agent.account === agent.ranOn.id;
  const Icon = ENGINE_ICON[agent.engine];
  const tip = only
    ? `${agent.name} runs only on ${agent.ranOn.name}. Change it in Runs on, in the … menu.`
    : `${agent.name}’s last turn ran on ${agent.ranOn.name}. Show accounts`;
  return (
    <Tooltip content={tip}>
      <Button
        tabIndex={0}
        variant="ghost"
        size="compact"
        className="agent-chat__project agent-chat__account"
        leftIcon={<Icon size={12} />}
        onClick={() => requestSwitcher('open')}
        aria-label={tip}
        data-testid="agent-account-chip"
      >
        {agent.ranOn.name}
        {only && <span className="agent-chat__project-copy">· only</span>}
      </Button>
    </Tooltip>
  );
}

interface BodyProps {
  view: SwitcherEngine[];
  all: UsageAccount[];
  installed: AgentEngine[];
  adding: AgentEngine | 'pick' | null;
  setAdding: (a: AgentEngine | 'pick' | null) => void;
  onUse: (row: SwitcherRow) => void;
  onMove: (engine: AgentEngine, ids: string[]) => void;
  onRename: (row: SwitcherRow, name: string) => Promise<boolean>;
  onRemove: (row: SwitcherRow) => void;
  onSignIn: (row: SwitcherRow) => void;
  onAdd: (engine: AgentEngine, name: string) => Promise<boolean>;
}

function SwitcherBody({ view, all, installed, adding, setAdding, ...on }: BodyProps) {
  return (
    <div className="account-switcher__body">
      <p className="account-switcher__title">Accounts</p>
      <p className="account-switcher__lead">
        Turns start on the first account with room, then carry on with the next.
      </p>
      {view.map((engine) => (
        <section
          key={engine.engine}
          className="account-switcher__engine"
          aria-label={engine.label}
          data-engine={engine.engine}
        >
          {view.length > 1 && <h4 className="account-switcher__heading">{engine.label}</h4>}
          <ol className="account-switcher__list">
            {engine.rows.map((row, i) => (
              <Row
                key={row.key}
                row={row}
                first={i === 0}
                last={i === engine.rows.length - 1}
                onUse={() => on.onUse(row)}
                onMove={(by) => {
                  const ids = engine.rows.map((r) => r.id);
                  const next = movedIds(ids, i, by);
                  if (next) on.onMove(engine.engine, next);
                }}
                onRename={(name) => on.onRename(row, name)}
                onRemove={() => on.onRemove(row)}
                onSignIn={() => on.onSignIn(row)}
              />
            ))}
          </ol>
        </section>
      ))}
      <AddAccount
        all={all}
        installed={installed}
        adding={adding}
        setAdding={setAdding}
        onAdd={on.onAdd}
      />
    </div>
  );
}

function Row({
  row,
  first,
  last,
  onUse,
  onMove,
  onRename,
  onRemove,
  onSignIn,
}: {
  row: SwitcherRow;
  first: boolean;
  last: boolean;
  onUse: () => void;
  onMove: (by: -1 | 1) => void;
  onRename: (name: string) => Promise<boolean>;
  onRemove: () => void;
  onSignIn: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(row.name);
  const [confirming, setConfirming] = useState(false);
  const pinned = pinnedLine(row.pinnedBy);
  const save = async () => {
    if (name.trim() === row.name) return setEditing(false);
    if (await onRename(name)) setEditing(false);
  };

  return (
    <li
      className="account-switcher__account"
      data-tone={row.tone}
      data-in-use={row.inUse || undefined}
      data-account={row.id}
    >
      <span className="account-switcher__mark" aria-hidden>
        {row.inUse && <CheckIcon size={12} />}
      </span>
      <div className="account-switcher__info">
        <div className="account-switcher__head">
          {editing ? (
            <TextField
              className="account-switcher__name-field"
              value={name}
              maxLength={40}
              aria-label="Account name"
              autoFocus
              onChange={(e) => setName(e.target.value)}
              onBlur={() => void save()}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === 'Enter') void save();
                if (e.key === 'Escape') {
                  setName(row.name);
                  setEditing(false);
                }
              }}
            />
          ) : (
            <span className="account-switcher__account-name">{row.name}</span>
          )}
          <span className="account-switcher__state" data-tone={row.tone}>
            {row.state}
          </span>
        </div>
        {row.detail.length > 0 && (
          <span className="account-switcher__muted">{row.detail.join(' · ')}</span>
        )}
        {row.room.map((r) => (
          <div key={r.key} className="account-switcher__limit" data-tone={r.tone}>
            <span className="account-switcher__limit-text">
              {r.label} {r.left}% left
              {r.resets && <span className="account-switcher__muted"> · {r.resets}</span>}
            </span>
            <span
              className="account-switcher__bar"
              role="meter"
              aria-label={`${r.label} limit left`}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={r.left}
            >
              <span
                className="account-switcher__fill"
                style={{ '--account-switcher-fill': `${r.left}%` } as CSSProperties}
              />
            </span>
          </div>
        ))}
        {row.signedIn && row.tone === 'ok' && row.room.length === 0 && (
          <span className="account-switcher__muted">No usage reading yet</span>
        )}
        {pinned && <span className="account-switcher__muted">{pinned}</span>}
        {confirming ? (
          <div className="account-switcher__actions">
            <span className="account-switcher__muted">Remove its sign-in from this Mac?</span>
            <Button size="compact" variant="ghost" onClick={() => setConfirming(false)}>
              Keep
            </Button>
            <Button size="compact" variant="danger" onClick={onRemove}>
              Remove
            </Button>
          </div>
        ) : (
          <div className="account-switcher__actions">
            {row.canUse && (
              <Button size="compact" variant="secondary" onClick={onUse}>
                Use this one now
              </Button>
            )}
            {!row.signedIn && (
              <Button size="compact" variant="secondary" onClick={onSignIn}>
                Sign in
              </Button>
            )}
            <span className="account-switcher__spacer" />
            <span className="account-switcher__order" role="group" aria-label="Order">
              <IconButton
                size="compact"
                variant="ghost"
                icon={<ArrowUpIcon size={14} />}
                aria-label={`Try ${row.name} earlier`}
                disabled={first}
                onClick={() => onMove(-1)}
              />
              <IconButton
                size="compact"
                variant="ghost"
                icon={<ArrowDownIcon size={14} />}
                aria-label={`Try ${row.name} later`}
                disabled={last}
                onClick={() => onMove(1)}
              />
            </span>
            <Dropdown
              align="right"
              portal
              quietOpen
              trigger={(p) => (
                <IconButton
                  {...p}
                  tabIndex={0}
                  size="compact"
                  variant="ghost"
                  icon={<MoreHorizontalIcon size={14} />}
                  aria-label={`More for ${row.name}`}
                />
              )}
            >
              <DropdownItem icon={<EditIcon size={14} />} onSelect={() => setEditing(true)}>
                Rename
              </DropdownItem>
              {row.signedIn && !row.thisMac && (
                <DropdownItem icon={<ResetIcon size={14} />} onSelect={onSignIn}>
                  Sign in again
                </DropdownItem>
              )}
              {!row.thisMac && (
                <>
                  <DropdownDivider />
                  <DropdownItem
                    icon={<TrashIcon size={14} />}
                    variant="danger"
                    onSelect={() => setConfirming(true)}
                  >
                    Remove…
                  </DropdownItem>
                </>
              )}
            </Dropdown>
          </div>
        )}
      </div>
    </li>
  );
}

function AddAccount({
  all,
  installed,
  adding,
  setAdding,
  onAdd,
}: {
  all: UsageAccount[];
  installed: AgentEngine[];
  adding: AgentEngine | 'pick' | null;
  setAdding: (a: AgentEngine | 'pick' | null) => void;
  onAdd: (engine: AgentEngine, name: string) => Promise<boolean>;
}) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (adding && adding !== 'pick') setName(suggestName(all, adding));
    // Only when the engine is picked: typing must not be reset by a refresh.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [adding]);
  if (installed.length === 0) return null;

  if (!adding) {
    return (
      <Button
        variant="ghost"
        width="fill"
        className="account-switcher__add"
        leftIcon={<AddIcon size={14} />}
        onClick={() => setAdding(installed.length === 1 ? installed[0] : 'pick')}
        data-add-account
      >
        Add account
      </Button>
    );
  }
  if (adding === 'pick') {
    return (
      <div className="account-switcher__new">
        <p className="account-switcher__muted">{ADD_ACCOUNT_WHY}</p>
        <div className="account-switcher__actions">
          {installed.map((e) => (
            <Button key={e} size="compact" variant="secondary" onClick={() => setAdding(e)}>
              {ENGINE_LABEL[e]}
            </Button>
          ))}
          <Button size="compact" variant="ghost" onClick={() => setAdding(null)}>
            Cancel
          </Button>
        </div>
      </div>
    );
  }
  const submit = async () => {
    setBusy(true);
    const done = await onAdd(adding, name);
    setBusy(false);
    if (done) setAdding(null);
  };
  return (
    <div className="account-switcher__new" data-adding={adding}>
      <p className="account-switcher__muted">
        A {ENGINE_LABEL[adding]} account of its own. {ADD_ACCOUNT_WHY}
      </p>
      <TextField
        value={name}
        maxLength={40}
        aria-label={`Name for the new ${ENGINE_LABEL[adding]} account`}
        autoFocus
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Enter') void submit();
          if (e.key === 'Escape') setAdding(null);
        }}
      />
      <div className="account-switcher__actions">
        <span className="account-switcher__spacer" />
        <Button size="compact" variant="ghost" onClick={() => setAdding(null)}>
          Cancel
        </Button>
        <Button
          size="compact"
          variant="strong"
          disabled={busy || !name.trim()}
          onClick={() => void submit()}
        >
          Add and sign in
        </Button>
      </div>
    </div>
  );
}
