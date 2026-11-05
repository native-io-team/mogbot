/**
 * The agent editor's "What it can reach": every app it was connected to on a
 * login card (which account, read or also send, where the sign-in is kept),
 * its browser (Claude in Chrome: on or off, and the sites it was given it
 * for), its API keys in the Keychain, and the Claude Code apps kept from it.
 * Each comes off in one click (`agents_reach_remove`), from its next turn.
 * Removing a connection here takes it from this agent only; the account stays
 * connected for the others.
 *
 * Replaces the old Logins list: secrets are one kind of thing it can reach.
 *
 * @module components/agents/AgentReach
 */

import { useCallback, useEffect, useState } from 'react';
import { ErrorIcon } from '@/components/icons';
import { TextButton } from '../primitives/TextButton';
import { Tooltip } from '../primitives/Tooltip';
import { useAsyncState } from '../../hooks/useAsyncState';
import { asCommandError, formatCommandError } from '../../lib/errors';
import { formatAgo } from '../../lib/workflows';
import {
  accessLabel,
  agentReach,
  removeReach,
  type Reach,
  type Removal,
} from '../../lib/agentLogins';
import type { Agent } from '../../lib/agents';

export function AgentReach({ agent }: { agent: Agent }) {
  const load = useCallback(() => agentReach(agent.id), [agent.id]);
  const { data, setData, error: loadError, execute } = useAsyncState<Reach>(load);
  useEffect(() => {
    void execute();
  }, [execute]);
  const [error, setError] = useState<string | null>(null);
  const [now] = useState(() => Date.now());
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
    (!reach.browser || (reach.browser.on && reach.browser.sites.length === 0));

  return (
    <div className="agent-editor__label" role="group" aria-label="What it can reach">
      What it can reach
      {loadError && !reach && (
        <p className="agent-editor__error" role="alert">
          <ErrorIcon size={12} className="inline-error-icon" />
          {formatCommandError(asCommandError(loadError))}
        </p>
      )}
      {empty && (
        <p className="agent-editor__hint">
          Nothing connected yet. When {agent.name} needs an app, it asks on a sign-in card in the
          chat: you connect it on this Mac and it never sees a password.
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
                    {accessLabel(c.access)} · {c.kept}
                    {c.lastUsedAt ? ` · used ${formatAgo(c.lastUsedAt, now)}` : ''}
                  </span>
                  {c.needsSignIn && (
                    <span className="agent-secrets__meta agent-reach__warn">
                      Needs signing in again: {agent.name} will ask on a card.
                    </span>
                  )}
                </span>
                <TextButton
                  tabIndex={0}
                  className="agent-permissions__revoke"
                  onClick={() => void remove({ kind: 'connection', connectionId: c.connectionId })}
                >
                  Remove
                </TextButton>
              </li>
            ))}
          </ul>
        </section>
      )}
      {reach?.browser && (!reach.browser.on || reach.browser.sites.length > 0) && (
        <section className="agent-reach__section" aria-label="Browser">
          <span className="agent-reach__heading">Your browser</span>
          <ul className="agent-permissions">
            <li className="agent-permissions__rule agent-secrets__row">
              <span className="agent-secrets__text">
                <span className="agent-secrets__name">
                  {reach.browser.on ? 'Chrome, through Claude in Chrome' : 'Off'}
                </span>
                <span className="agent-secrets__meta">
                  {reach.browser.on
                    ? `Where you’re signed in${
                        reach.browser.sites.length ? ` · for ${reach.browser.sites.join(', ')}` : ''
                      } · every click, post or send asks you first`
                    : `${agent.name} can’t use your browser.`}
                </span>
                {reach.browser.on && !reach.browser.helperInstalled && (
                  <span className="agent-secrets__meta agent-reach__warn">
                    The Claude in Chrome extension isn’t set up on this Mac yet.
                  </span>
                )}
              </span>
              {reach.browser.on && (
                <TextButton
                  tabIndex={0}
                  className="agent-permissions__revoke"
                  onClick={() => void remove({ kind: 'browser' })}
                >
                  Remove
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
                <TextButton
                  tabIndex={0}
                  className="agent-permissions__revoke"
                  onClick={() => void remove({ kind: 'secret', secretId: s.secretId })}
                >
                  Remove
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
      {error && (
        <p className="agent-editor__error" role="alert">
          <ErrorIcon size={12} className="inline-error-icon" />
          {error}
        </p>
      )}
    </div>
  );
}
