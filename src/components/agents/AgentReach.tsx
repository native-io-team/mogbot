/**
 * The agent editor's "What it can reach": every app it was connected to on a
 * login card (which account, read or also send, where the sign-in is kept),
 * its browser (which way it reaches your Chrome now, Your Chrome or Claude
 * in Chrome, and why; the sites it was given it for), its API keys in the Keychain, and the Claude Code apps kept from it.
 * Each comes off in one click (`agents_reach_remove`), from its next turn.
 * Removing a connection here takes it from this agent only; the account stays
 * connected for the others.
 *
 * Replaces the old Logins list: secrets are one kind of thing it can reach.
 *
 * @module components/agents/AgentReach
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { ErrorIcon } from '@/components/icons';
import { TextButton } from '../primitives/TextButton';
import { Tooltip } from '../primitives/Tooltip';
import { useAsyncState } from '../../hooks/useAsyncState';
import { useOpenModal } from '../../contexts/ModalContext';
import { asCommandError, formatCommandError } from '../../lib/errors';
import { formatAgo } from '../../lib/formatAgo';
import {
  accessLabel,
  agentReach,
  removeReach,
  type Reach,
  type Removal,
} from '../../lib/agentLogins';
import type { Agent } from '../../lib/agents';
import { routeName, routeWhy } from '../../lib/userChrome';
import { THIS_COMPUTER, THIS_COMPUTER_CAP } from '../../lib/computer';

export function AgentReach({
  agent,
  onOpenApps,
  focus,
}: {
  agent: Agent;
  onOpenApps?: () => void;
  /** Opened from a card's "What it can reach": scroll its heading into view once loaded. */
  focus?: boolean;
}) {
  const load = useCallback(() => agentReach(agent.id), [agent.id]);
  const { data, setData, error: loadError, execute } = useAsyncState<Reach>(load);
  const openModal = useOpenModal();
  useEffect(() => {
    void execute();
  }, [execute]);
  const [error, setError] = useState<string | null>(null);
  const [now] = useState(() => Date.now());
  const [confirmKey, setConfirmKey] = useState<string | null>(null);
  const groupRef = useRef<HTMLDivElement>(null);
  const loaded = !!data;
  useEffect(() => {
    if (!focus || !loaded) return;
    // The heading is AgentPolicy's, just above this list.
    const el = groupRef.current;
    const heading = el?.parentElement?.querySelector<HTMLElement>('.agent-policy') ?? el;
    heading?.scrollIntoView({ block: 'start' });
  }, [focus, loaded]);
  const remove = async (removal: Removal) => {
    setError(null);
    try {
      setData(await removeReach(agent.id, removal));
    } catch (err) {
      setError(formatCommandError(asCommandError(err)));
    }
  };
  const reach = data;
  const empty =
    reach &&
    reach.connections.length === 0 &&
    reach.secrets.length === 0 &&
    reach.blockedApps.length === 0 &&
    !reach.browser;

  return (
    // No heading of its own: it sits right under AgentPolicy's "What it can
    // reach" and continues it (its sections carry their own headings), so the
    // editor doesn't show the same title twice in a row.
    <div
      ref={groupRef}
      className="agent-editor__label agent-reach"
      role="group"
      aria-label="What it can reach: sign-ins, browser and keys"
    >
      {loadError && !reach && (
        <p className="agent-editor__error" role="alert">
          <ErrorIcon size={12} className="inline-error-icon" />
          {formatCommandError(asCommandError(loadError))}
        </p>
      )}
      {empty && (
        <p className="agent-editor__hint">
          Nothing connected yet. When {agent.name} needs an app, it asks on a sign-in card in the
          chat: you connect it on {THIS_COMPUTER} and it never sees a password.
        </p>
      )}
      {reach && reach.connections.length > 0 && (
        <section className="agent-reach__section" aria-label="Apps">
          <span className="agent-reach__heading">Apps</span>
          <ul className="agent-permissions">
            {reach.connections.map((c) => (
              <li key={c.connectionId} className="agent-permissions__rule agent-secrets__row">
                <span className="agent-secrets__text">
                  <span className="agent-secrets__name">
                    {c.title}
                    {c.account !== c.title ? ` · ${c.account}` : ''}
                  </span>
                  <span className="agent-secrets__meta">
                    {accessLabel(c.access)}
                    {/* The title already says "This Mac"; how macOS asks is said once, below. */}
                    {c.macApp ? '' : ` · ${c.kept}`}
                    {c.lastUsedAt ? ` · used ${formatAgo(c.lastUsedAt, now)}` : ''}
                  </span>
                  {c.needsSignIn && (
                    <span className="agent-secrets__meta agent-reach__warn">
                      {onOpenApps
                        ? `Needs signing in again. Until then ${agent.name} asks on a card.`
                        : `Needs signing in again: ${agent.name} will ask on a card.`}
                    </span>
                  )}
                </span>
                {/* The one fix, where it is: Apps signs it in again for every agent it's shared with. */}
                {c.needsSignIn && onOpenApps && (
                  <TextButton
                    tabIndex={0}
                    className="agent-permissions__revoke"
                    data-sign-in-again
                    onClick={onOpenApps}
                  >
                    Sign in again
                  </TextButton>
                )}
                <TextButton
                  tabIndex={0}
                  className="agent-permissions__revoke"
                  aria-label={`Remove ${c.title} from ${agent.name}`}
                  title={`Takes ${c.title} from ${agent.name} only, from its next message. Other agents keep it.`}
                  onClick={() => void remove({ kind: 'connection', connectionId: c.connectionId })}
                >
                  Remove
                </TextButton>
              </li>
            ))}
          </ul>
          {reach.connections.some((c) => c.macApp) && (
            <p className="agent-editor__hint">
              {THIS_COMPUTER_CAP}’s own apps: macOS asks once, in System Settings → Privacy &amp;
              Security.
            </p>
          )}
        </section>
      )}
      {reach?.browser && (
        <section className="agent-reach__section" aria-label="Browser">
          <span className="agent-reach__heading">Your browser</span>
          <ul className="agent-permissions">
            <li className="agent-permissions__rule agent-secrets__row">
              <span className="agent-secrets__text">
                <span className="agent-secrets__name">
                  {reach.browser.on
                    ? reach.browser.route
                      ? routeName(reach.browser.route)
                      : 'Chrome, through Claude in Chrome'
                    : reach.browser.teamOn
                      ? 'Off'
                      : 'Not set up'}
                </span>
                <span className="agent-secrets__meta">
                  {reach.browser.on
                    ? browserLine(reach.browser.sites)
                    : reach.browser.teamOn
                      ? `${agent.name} can’t use your browser.`
                      : 'Your team’s browser isn’t on yet, so it asks you instead.'}
                </span>
                {reach.browser.on && reach.browser.route && (
                  <span className="agent-secrets__meta" data-testid="reach-browser-route">
                    {routeWhy(reach.browser.route, agent.name)}
                  </span>
                )}
                {reach.browser.on &&
                  reach.browser.accounts?.map((a) => (
                    <span key={a.site} className="agent-secrets__meta">
                      {a.site}: {a.account ? `${a.account} in ` : ''}“{a.browser}”{' '}
                      <TextButton
                        tabIndex={0}
                        className="agent-permissions__revoke"
                        onClick={() => void remove({ kind: 'browser_account', site: a.site })}
                      >
                        Forget
                      </TextButton>
                    </span>
                  ))}
                {reach.browser.on &&
                  reach.browser.route?.route !== 'your_chrome' &&
                  !reach.browser.helperInstalled && (
                    <span className="agent-secrets__meta agent-reach__warn">
                      The Claude in Chrome extension isn’t set up on {THIS_COMPUTER} yet.
                    </span>
                  )}
              </span>
              {reach.browser.on && (
                <TextButton
                  tabIndex={0}
                  className="agent-permissions__revoke"
                  aria-label={`Remove your browser from ${agent.name}`}
                  title={`${agent.name} stops using your Chrome from its next message. Other agents keep it.`}
                  onClick={() => void remove({ kind: 'browser' })}
                >
                  Remove
                </TextButton>
              )}
              {!reach.browser.teamOn && (
                <TextButton
                  tabIndex={0}
                  className="agent-permissions__revoke"
                  onClick={() => openModal('agentBrowser')}
                >
                  Set up
                </TextButton>
              )}
              {reach.browser.teamOn && reach.browser.ownOff && (
                <TextButton
                  tabIndex={0}
                  className="agent-permissions__revoke"
                  onClick={() => void remove({ kind: 'browser_on' })}
                >
                  Give it back
                </TextButton>
              )}
            </li>
          </ul>
        </section>
      )}
      {reach && reach.secrets.length > 0 && (
        <section className="agent-reach__section" aria-label="Keys">
          <span className="agent-reach__heading">Keys in your Keychain</span>
          <ul className="agent-permissions">
            {reach.secrets.map((s) => (
              <li key={s.secretId} className="agent-permissions__rule agent-secrets__row">
                <span className="agent-secrets__text">
                  <Tooltip content={`Saved as ${s.name} · ${s.variables.join(', ')}`}>
                    <span className="agent-secrets__name" tabIndex={0}>
                      {s.purpose || s.name}
                    </span>
                  </Tooltip>
                  <span className="agent-secrets__meta">
                    {s.lastUsedAt ? `Used ${formatAgo(s.lastUsedAt, now)}` : 'Not used yet'}
                  </span>
                </span>
                {/* The only Remove here that can't be undone: the key leaves the
                    Keychain. So it asks once, in place, as Apps' Remove does. */}
                <TextButton
                  tabIndex={0}
                  className="agent-permissions__revoke"
                  data-confirming={confirmKey === s.secretId || undefined}
                  aria-label={
                    confirmKey === s.secretId
                      ? `Confirm deleting ${s.purpose || s.name}`
                      : `Remove ${s.purpose || s.name} from ${agent.name}`
                  }
                  title="Deletes the key from your Keychain. To use it again, you paste it again."
                  onBlur={() => setConfirmKey(null)}
                  onClick={() => {
                    if (confirmKey !== s.secretId) {
                      setConfirmKey(s.secretId);
                      return;
                    }
                    setConfirmKey(null);
                    void remove({ kind: 'secret', secretId: s.secretId });
                  }}
                >
                  {confirmKey === s.secretId ? 'Delete key?' : 'Remove'}
                </TextButton>
              </li>
            ))}
          </ul>
        </section>
      )}
      {reach && reach.blockedApps.length > 0 && (
        <section className="agent-reach__section" aria-label="Kept from it">
          <span className="agent-reach__heading">Apps kept from {agent.name}</span>
          <ul className="agent-permissions">
            {reach.blockedApps.map((name) => (
              <li key={name} className="agent-permissions__rule">
                <span className="agent-permissions__what">{name}</span>
                <TextButton
                  tabIndex={0}
                  className="agent-permissions__revoke"
                  onClick={() => void remove({ kind: 'unblock_app', name })}
                >
                  Allow again
                </TextButton>
              </li>
            ))}
          </ul>
        </section>
      )}
      {reach && (reach.declined?.length ?? 0) > 0 && (
        <section className="agent-reach__section" aria-label="Not connecting">
          <span className="agent-reach__heading">You chose not to connect (every agent)</span>
          <ul className="agent-permissions">
            {reach.declined!.map((d) => (
              <li key={d.key} className="agent-permissions__rule">
                <span className="agent-permissions__what">{d.title}</span>
                <TextButton
                  tabIndex={0}
                  className="agent-permissions__revoke"
                  onClick={() => void remove({ kind: 'undecline', key: d.key })}
                >
                  Turn back on
                </TextButton>
              </li>
            ))}
          </ul>
        </section>
      )}
      {error && (
        <p className="agent-editor__error" role="alert">
          <ErrorIcon size={12} className="inline-error-icon" />
          {error}
        </p>
      )}
    </div>
  );
}

/**
 * The browser row's line: where it works, what it reads without asking, and
 * that everything else asks. Plain sentences, not a chain of fragments.
 */
export function browserLine(sites: string[]): string {
  const reads = sites.length ? ` It reads ${sites.join(', ')} without asking.` : '';
  return `Your own Chrome, where you’re already signed in.${reads} Any other site, and every click, post or send, asks you first. Never used while it answers someone else’s message.`;
}
