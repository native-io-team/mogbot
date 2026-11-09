/**
 * Settings → Agents → Accounts: each engine's accounts, in the order turns
 * try them. When a turn ends on one's usage limit, it continues on the next
 * (`agents/wallet.rs`). This Mac's own sign-in is always in the list; more
 * can be added, each signed in into a folder of its own.
 *
 * Every row is a Line: its name in full (this Mac's own sign-in, unnamed, is
 * shown as who it is signed in as), then one muted line of state with
 * who it is signed in as and its plan, only as the engine's own files say
 * (`agents/identity.rs`). The account turns start on is marked "In use";
 * any other signed-in one offers "Use this one now", which puts it first
 * (`agents_account_use`). Actions are quiet: Sign in when it isn't, a More
 * menu (Rename, Sign in again, Remove…, which asks first; This Mac's own
 * sign-in can't be removed and says why), and the two order arrows as one
 * group. Adding names the account, then runs its engine's own sign-in in a
 * terminal (`AccountSignIn`).
 *
 * @module components/agents/AgentAccounts
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '../primitives/Button';
import { IconButton } from '../primitives/IconButton';
import { TextField } from '../primitives/TextField';
import { Tooltip } from '../primitives/Tooltip';
import { StatusPill } from '../primitives/StatusPill';
import { Dropdown, DropdownDivider, DropdownItem } from '../primitives/Dropdown';
import {
  ArrowDownIcon,
  ArrowUpIcon,
  EditIcon,
  MoreHorizontalIcon,
  ResetIcon,
  TrashIcon,
} from '../icons';
import { useAsyncState } from '../../hooks/useAsyncState';
import { useOptionalToast } from '../../contexts/ToastContext';
import { asCommandError, formatCommandError } from '../../lib/errors';
import { ENGINE_LABEL, type AgentEngine, type EngineInfo } from '../../lib/agents';
import {
  accountDetail,
  accountKind,
  accountsOf,
  addUsageAccount,
  listUsageAccounts,
  moved,
  onUsageAccountsChanged,
  removalLine,
  removeUsageAccount,
  renameUsageAccount,
  reorderUsageAccounts,
  suggestName,
  takeAccountsRequest,
  putAccountFirst,
  type UsageAccount,
} from '../../lib/agentAccounts';
import { inUseOf } from '../../../packages/companion-protocol/src/accountSwitcher';
import { USE_THIS_ONE_NOW } from '../../../packages/companion-protocol/src/cardWords';
import { AccountSignIn } from './AccountSignIn';
import { onAccountSignIn, takeAccountSignIn } from '../../lib/settingsFromChat';

const say = (e: unknown) => formatCommandError(asCommandError(e));

function AccountRow({
  account,
  index,
  count,
  inUse,
  onUse,
  onMove,
  onRename,
  onSignIn,
  onRemove,
}: {
  account: UsageAccount;
  index: number;
  count: number;
  inUse: boolean;
  onUse: () => void;
  onMove: (by: -1 | 1) => void;
  onRename: (name: string) => Promise<boolean>;
  onSignIn: () => void;
  onRemove: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(account.name);
  const [confirming, setConfirming] = useState(false);
  const save = async () => {
    if (name.trim() === account.name) return setEditing(false);
    if (await onRename(name)) setEditing(false);
  };
  const tone = account.out ? 'out' : account.signedIn ? 'ok' : 'off';
  const detail = accountDetail(account);
  const engine = ENGINE_LABEL[account.engine];

  return (
    <li className={`agent-account agent-account--${tone}`} data-account={account.id}>
      <span className="agent-account__order" aria-hidden="true">
        {index + 1}
      </span>
      <div className="agent-account__info">
        {editing ? (
          <TextField
            className="agent-account__name-field"
            value={name}
            maxLength={40}
            aria-label="Account name"
            autoFocus
            onChange={(e) => setName(e.target.value)}
            onBlur={() => void save()}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void save();
              if (e.key === 'Escape') {
                setName(account.name);
                setEditing(false);
              }
            }}
          />
        ) : (
          <Tooltip content={`${account.name} · ${accountKind(account)}`}>
            <span className="agent-account__name">{account.name}</span>
          </Tooltip>
        )}
        <span className="agent-account__detail">
          {/* The state is a pill (in use, out of usage, signed in or not); who
              it is and its plan follow in quiet words. */}
          <StatusPill
            className="agent-account__state"
            tone={account.out ? 'out' : inUse && account.signedIn ? 'done' : 'idle'}
          >
            {inUse && !account.out ? 'In use' : detail.state}
          </StatusPill>
          {detail.email && detail.email !== account.name && (
            <Tooltip content={detail.email}>
              <span className="agent-account__email">{detail.email}</span>
            </Tooltip>
          )}
          {detail.plan && <span className="agent-account__plan">{detail.plan}</span>}
          {detail.note && <span className="agent-account__note">{detail.note}</span>}
        </span>
      </div>
      <div className="agent-account__actions">
        {confirming ? (
          <>
            <span className="agent-account__confirm">Remove its sign-in from this Mac?</span>
            <Button size="compact" variant="ghost" onClick={() => setConfirming(false)}>
              Keep
            </Button>
            <Button size="compact" variant="danger" onClick={onRemove}>
              Remove
            </Button>
          </>
        ) : (
          <>
            {!account.signedIn && (
              <Button size="compact" variant="secondary" onClick={onSignIn}>
                Sign in
              </Button>
            )}
            {account.signedIn && !account.out && !inUse && (
              <Button size="compact" variant="secondary" onClick={onUse}>
                {USE_THIS_ONE_NOW}
              </Button>
            )}
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
                  aria-label={`More for ${account.name}`}
                />
              )}
            >
              <DropdownItem icon={<EditIcon size={14} />} onSelect={() => setEditing(true)}>
                Rename
              </DropdownItem>
              {account.signedIn && !account.thisMac && (
                <DropdownItem icon={<ResetIcon size={14} />} onSelect={onSignIn}>
                  Sign in again
                </DropdownItem>
              )}
              <DropdownDivider />
              {account.thisMac ? (
                <span
                  className="agent-account__no-remove"
                  title={`This Mac’s own ${engine} sign-in stays. To change it, sign out in ${engine} itself.`}
                >
                  <DropdownItem icon={<TrashIcon size={14} />} disabled onSelect={() => undefined}>
                    Remove…
                  </DropdownItem>
                </span>
              ) : (
                <DropdownItem
                  icon={<TrashIcon size={14} />}
                  variant="danger"
                  onSelect={() => setConfirming(true)}
                >
                  Remove…
                </DropdownItem>
              )}
            </Dropdown>
            <span className="agent-account__order-controls" role="group" aria-label="Order">
              <IconButton
                size="compact"
                variant="ghost"
                icon={<ArrowUpIcon size={14} />}
                aria-label={`Try ${account.name} earlier`}
                disabled={index === 0}
                onClick={() => onMove(-1)}
              />
              <IconButton
                size="compact"
                variant="ghost"
                icon={<ArrowDownIcon size={14} />}
                aria-label={`Try ${account.name} later`}
                disabled={index === count - 1}
                onClick={() => onMove(1)}
              />
            </span>
          </>
        )}
      </div>
    </li>
  );
}

function AddAccount({
  engine,
  suggested,
  autoOpen,
  onAdd,
}: {
  engine: AgentEngine;
  suggested: string;
  autoOpen: boolean;
  onAdd: (name: string) => Promise<boolean>;
}) {
  const [open, setOpen] = useState(autoOpen);
  const [name, setName] = useState(suggested);
  const [busy, setBusy] = useState(false);

  if (!open) {
    return (
      <Button
        variant="secondary"
        className="agent-accounts__add"
        onClick={() => {
          setName(suggested);
          setOpen(true);
        }}
        data-add-account={engine}
      >
        Add a {ENGINE_LABEL[engine]} account
      </Button>
    );
  }
  const submit = async () => {
    setBusy(true);
    const done = await onAdd(name);
    setBusy(false);
    if (done) setOpen(false);
  };
  return (
    <div className="agent-accounts__new">
      <TextField
        value={name}
        maxLength={40}
        aria-label={`Name for the new ${ENGINE_LABEL[engine]} account`}
        autoFocus
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void submit();
          if (e.key === 'Escape') setOpen(false);
        }}
      />
      <Button variant="secondary" onClick={() => setOpen(false)}>
        Cancel
      </Button>
      <Button variant="strong" disabled={busy || !name.trim()} onClick={() => void submit()}>
        Add and sign in
      </Button>
    </div>
  );
}

export function AgentAccounts({ engines }: { engines: EngineInfo[] }) {
  const { showToast } = useOptionalToast();
  const { data, execute } = useAsyncState(listUsageAccounts);
  const [signingIn, setSigningIn] = useState<UsageAccount | null>(null);
  const [request] = useState(takeAccountsRequest);
  // An account the Chief added from chat (`manage_account add`): its sign-in
  // runs here, as Add and sign in would, once the list has it.
  const [signInFor, setSignInFor] = useState<string | null>(takeAccountSignIn);
  useEffect(() => onAccountSignIn(setSignInFor), []);
  const ref = useRef<HTMLElement>(null);
  const all = data ?? [];
  const asked = signInFor ? all.find((a) => a.id === signInFor) : undefined;
  if (asked) {
    setSignInFor(null);
    if (!asked.signedIn) setSigningIn(asked);
  }

  const reload = useCallback(() => void execute().catch(() => undefined), [execute]);
  useEffect(() => {
    reload();
    let unlisten: (() => void) | undefined;
    let gone = false;
    void onUsageAccountsChanged(reload)
      .then((u) => (gone ? u() : (unlisten = u)))
      .catch(() => undefined);
    // A sign-in can change in a terminal outside the app: read again on return.
    window.addEventListener('focus', reload);
    return () => {
      gone = true;
      unlisten?.();
      window.removeEventListener('focus', reload);
    };
  }, [reload]);
  useEffect(() => {
    if (request) ref.current?.scrollIntoView?.({ block: 'start' });
  }, [request]);

  const attempt = async (what: () => Promise<unknown>): Promise<boolean> => {
    try {
      await what();
      reload();
      return true;
    } catch (e) {
      showToast(say(e), 'error');
      return false;
    }
  };

  // Only engines this Mac has: there's nothing to sign in to otherwise.
  const shown = engines.filter((e) => e.installed).map((e) => e.id);

  return (
    <section
      className="settings-group agent-accounts"
      aria-labelledby="agents-settings-accounts"
      ref={ref}
    >
      <h3 className="settings-group__title" id="agents-settings-accounts">
        Accounts
      </h3>
      <p className="agent-accounts__lead">
        When one runs out of usage, agents carry on with the next, in this order.
      </p>
      {shown.map((engine) => {
        const mine = accountsOf(all, engine);
        const ids = mine.map((a) => a.id);
        return (
          <div className="agent-accounts__engine" key={engine} data-engine={engine}>
            <span className="agent-accounts__engine-name">{ENGINE_LABEL[engine]}</span>
            <ol className="agent-accounts__list">
              {mine.map((account, i) => (
                <AccountRow
                  key={account.id}
                  account={account}
                  index={i}
                  count={mine.length}
                  inUse={mine.length > 1 && inUseOf(mine)?.id === account.id}
                  onUse={() => void attempt(() => putAccountFirst(engine, account.id))}
                  onMove={(by) => {
                    const next = moved(ids, i, by);
                    if (next) void attempt(() => reorderUsageAccounts(engine, next));
                  }}
                  onRename={(name) => attempt(() => renameUsageAccount(engine, account.id, name))}
                  onSignIn={() => setSigningIn(account)}
                  onRemove={() =>
                    void attempt(async () => {
                      // A turn running on it: it goes when that turn ends.
                      const line = removalLine(await removeUsageAccount(engine, account.id));
                      if (line) showToast(line, 'info');
                    })
                  }
                />
              ))}
            </ol>
            <AddAccount
              engine={engine}
              suggested={suggestName(all, engine)}
              autoOpen={request === engine}
              onAdd={(name) =>
                attempt(async () => {
                  const added = await addUsageAccount(engine, name);
                  setSigningIn({ ...added, thisMac: false, signedIn: false, out: false });
                })
              }
            />
          </div>
        );
      })}
      {signingIn && (
        <AccountSignIn
          account={signingIn}
          onDone={() => {
            setSigningIn(null);
            reload();
          }}
        />
      )}
    </section>
  );
}
