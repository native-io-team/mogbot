/**
 * Onboarding, right after the engine is signed in: "Add another account?"
 * One line on why (agents carry on with the next when one runs out of
 * usage), then the accounts there are, each a line, a quiet line per
 * engine to add one, and one big Continue: most people have one account,
 * so going on is the default. The same thing is in the account row at the
 * foot of Agents (and ⌘K "Add an account…") later.
 *
 * Adding names the account, then runs its engine's own sign-in in a
 * terminal (`AccountSignIn`): Claude Code's `setup-token`, captured in
 * Rust; Codex's `codex login` in its own folder. Nothing is shown as
 * signed in until the app's own check says so (`agents_accounts`).
 *
 * @module components/setup/flow/AccountsStep
 */

import { useEffect, useState } from 'react';
import { CheckIcon } from '@/components/icons';
import { Button } from '../../primitives/Button';
import { TextButton } from '../../primitives/TextButton';
import { TextField } from '../../primitives/TextField';
import { AccountSignIn } from '../../agents/AccountSignIn';
import { useUsageAccounts } from '../../agents/useUsageAccounts';
import { FlowShell } from './FlowParts';
import { ENGINE_LABEL, getAgentsOverview, type AgentEngine } from '../../../lib/agents';
import { addUsageAccount, suggestName, type UsageAccount } from '../../../lib/agentAccounts';
import { ADD_ACCOUNT_WHY } from '../../../../packages/companion-protocol/src/accountSwitcher';

export function AccountsStep({
  engine,
  onNext,
  onBack,
}: {
  /** The engine just set up: offered first. */
  engine: AgentEngine;
  onNext: () => void;
  onBack: () => void;
}) {
  const { accounts, attempt, reload } = useUsageAccounts();
  const [installed, setInstalled] = useState<AgentEngine[]>([engine]);
  const [naming, setNaming] = useState<AgentEngine | null>(null);
  const [name, setName] = useState('');
  const [signingIn, setSigningIn] = useState<UsageAccount | null>(null);

  useEffect(() => {
    let live = true;
    getAgentsOverview()
      .then((o) => {
        if (!live) return;
        const here = o.engines.filter((e) => e.installed).map((e) => e.id);
        // The one just set up first, then any other engine on this Mac.
        setInstalled([engine, ...here.filter((e) => e !== engine)]);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [engine]);

  const all = accounts ?? [];
  // This Mac's own sign-in of the engine just set up, and every account added.
  const listed = all.filter(
    (a) =>
      (a.engine === engine && a.thisMac && a.signedIn) ||
      (!a.thisMac && installed.includes(a.engine))
  );

  const start = (e: AgentEngine) => {
    setName(suggestName(all, e));
    setNaming(e);
  };
  const submit = async () => {
    if (!naming) return;
    let made: UsageAccount | null = null;
    const ok = await attempt(async () => {
      const a = await addUsageAccount(naming, name);
      made = { ...a, thisMac: false, signedIn: false, out: false };
    });
    if (ok && made) {
      setNaming(null);
      setSigningIn(made);
    }
  };

  const primary = naming ? (
    <Button
      variant="primary"
      size="large"
      disabled={!name.trim()}
      onClick={() => void submit()}
      data-flow-primary
    >
      Add and sign in
    </Button>
  ) : (
    // Optional, and most people have one account: going on is the big
    // button, adding one is the quiet line under the list.
    <Button variant="primary" size="large" onClick={onNext} autoFocus data-flow-primary>
      Continue
    </Button>
  );

  return (
    <FlowShell
      step="accounts"
      title="Add another account?"
      lede={`${ADD_ACCOUNT_WHY} Optional: you can add one any time from Agents.`}
      onBack={onBack}
      primary={primary}
      secondary={
        naming ? (
          <Button variant="ghost" onClick={() => setNaming(null)}>
            Cancel
          </Button>
        ) : undefined
      }
    >
      {listed.length > 0 && (
        <ul className="flow-accounts" aria-label="Accounts">
          {listed.map((a) => (
            <li
              key={`${a.engine}:${a.id}`}
              className="flow-accounts__row"
              data-signed-in={a.signedIn || undefined}
            >
              <span className="flow-accounts__mark" aria-hidden>
                {a.signedIn && <CheckIcon size={12} />}
              </span>
              <span className="flow-accounts__name">{a.name}</span>
              <span className="flow-accounts__detail">
                {ENGINE_LABEL[a.engine]} ·{' '}
                {a.signedIn
                  ? a.thisMac
                    ? 'this Mac’s own sign-in'
                    : 'signed in'
                  : 'not signed in yet'}
              </span>
            </li>
          ))}
        </ul>
      )}
      {naming && (
        <label className="flow-accounts__field">
          <span className="flow-accounts__detail">
            A name for the {ENGINE_LABEL[naming]} account (Work, Personal…)
          </span>
          <TextField
            value={name}
            maxLength={40}
            autoFocus
            aria-label={`Name for the new ${ENGINE_LABEL[naming]} account`}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && name.trim()) void submit();
              if (e.key === 'Escape') setNaming(null);
            }}
          />
        </label>
      )}
      {!naming && (
        <div className="flow-accounts__more">
          {installed.map((e) => (
            <TextButton key={e} onClick={() => start(e)}>
              {e === engine
                ? `Add another ${ENGINE_LABEL[e]} account`
                : `Add a ${ENGINE_LABEL[e]} account`}
            </TextButton>
          ))}
        </div>
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
    </FlowShell>
  );
}
