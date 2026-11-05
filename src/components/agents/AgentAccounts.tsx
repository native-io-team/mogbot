/**
 * Settings → Agents → Accounts: each engine's accounts, in the order turns
 * try them. When a turn ends on one's usage limit, it continues on the next
 * (`agents/wallet.rs`). This Mac's own sign-in is always in the list; more
 * can be added, each signed in into a folder of its own.
 *
 * Every row is a Line: name, one muted line of state (only what is known),
 * and quiet actions. Adding names the account, then runs its engine's own
 * sign-in in a terminal (`AccountSignIn`).
 *
 * @module components/agents/AgentAccounts
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '../primitives/Button';
import { IconButton } from '../primitives/IconButton';
import { TextField } from '../primitives/TextField';
import { ArrowDownIcon, ArrowUpIcon } from '../icons';
import { useAsyncState } from '../../hooks/useAsyncState';
import { useOptionalToast } from '../../contexts/ToastContext';
import { asCommandError, formatCommandError } from '../../lib/errors';
import { ENGINE_LABEL, type AgentEngine, type EngineInfo } from '../../lib/agents';
import {
  accountKind,
  accountState,
  accountsOf,
  addUsageAccount,
  listUsageAccounts,
  moved,
  onUsageAccountsChanged,
  removeUsageAccount,
  renameUsageAccount,
  reorderUsageAccounts,
  suggestName,
  takeAccountsRequest,
  type UsageAccount,
} from '../../lib/agentAccounts';
import { AccountSignIn } from './AccountSignIn';

const say = (e: unknown) => formatCommandError(asCommandError(e));

function AccountRow({
  account,
  index,
  count,
  onMove,
  onRename,
  onSignIn,
  onRemove,
}: {
  account: UsageAccount;
  index: number;
  count: number;
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
          <span className="agent-account__name">{account.name}</span>
        )}
        <span className="agent-account__state">{accountState(account)}</span>
        {account.thisMac && <span className="agent-account__kind">{accountKind(account)}</span>}
      </div>
      <div className="agent-account__actions">
        {confirming ? (
          <>
            <span className="agent-account__confirm">Remove its sign-in from this Mac?</span>
            <Button size="compact" variant="secondary" onClick={() => setConfirming(false)}>
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
            {!account.thisMac && account.signedIn && (
              <Button size="compact" variant="ghost" onClick={onSignIn}>
                Sign in again
              </Button>
            )}
            <Button size="compact" variant="ghost" onClick={() => setEditing(true)}>
              Rename
            </Button>
            {!account.thisMac && (
              <Button size="compact" variant="ghost" onClick={() => setConfirming(true)}>
                Remove
              </Button>
            )}
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
  const ref = useRef<HTMLElement>(null);
  const all = data ?? [];

  const reload = useCallback(() => void execute().catch(() => undefined), [execute]);
  useEffect(() => {
    reload();
    let unlisten: (() => void) | undefined;
    let gone = false;
    void onUsageAccountsChanged(reload)
      .then((u) => (gone ? u() : (unlisten = u)))
      .catch(() => undefined);
    return () => {
      gone = true;
      unlisten?.();
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
                  onMove={(by) => {
                    const next = moved(ids, i, by);
                    if (next) void attempt(() => reorderUsageAccounts(engine, next));
                  }}
                  onRename={(name) => attempt(() => renameUsageAccount(engine, account.id, name))}
                  onSignIn={() => setSigningIn(account)}
                  onRemove={() => void attempt(() => removeUsageAccount(engine, account.id))}
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
