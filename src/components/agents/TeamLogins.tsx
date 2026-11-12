/**
 * "What your team needs": every login card the team has waiting, one row per
 * service, not per agent. "Google · Gmail + Calendar — Recruiter, Mailroom and
 * Calendar · Connect" is one sign-in for all three; three agents asking for
 * GitHub is one "Use GitHub on this Mac". Each agent on a row can be unticked
 * (left waiting in its own chat) or answered "Not now", as its own card would; "Not needed" on a
 * row (or "Skip the rest" for the list) declines the app for the whole team,
 * remembered, with Undo on its receipt (`agents/declined.rs`); a progress
 * line says how many rows are done, and done rows fold to the end.
 *
 * Embeddable: `<TeamLogins since={importStartedAt} onDone={…} />` is what the
 * "Setting up your team" checklist hosts as its Logins step. `since` (unix ms)
 * keeps rows answered after it on the list, so progress reads "4 of 9";
 * without it only what's still waiting shows. `onDone` fires once, when every
 * row is answered. `TeamLoginsModal` is the same list in a dialog, opened by
 * ⌘K "Set up logins for agents…" and the import review card.
 *
 * Every way in runs on this Mac (`agents_logins_connect`); the rows follow it
 * through `agents://message` and `agents://registry`, and poll lightly while
 * a sign-in is under way.
 *
 * @module components/agents/TeamLogins
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { Button } from '../primitives/Button';
import { TextButton } from '../primitives/TextButton';
import { Checkbox } from '../primitives/Checkbox';
import { ModalFrame } from '../primitives/ModalFrame';
import { Spinner } from '../primitives/Spinner';
import { CheckIcon, ErrorIcon } from '@/components/icons';
import { useModal } from '../../contexts/ModalContext';
import { useAsyncState } from '../../hooks/useAsyncState';
import { SignInHelp, useNotNeeded } from './SignInHelp';
import { usePolling } from '../../hooks/usePolling';
import { asCommandError, formatCommandError } from '../../lib/errors';
import { AGENT_EVENTS } from '../../lib/agents';
import {
  connectTeamNeed,
  dismissLogin,
  listNames,
  loginsNotNeeded,
  needPrimary,
  progressLine,
  scopeTeam,
  teamBusy,
  teamCardLine,
  teamLogins,
  waitingCards,
  type LoginOption,
  type TeamLogins as Team,
  type TeamNeed,
} from '../../lib/agentLogins';
import { THIS_COMPUTER } from '../../lib/computer';

export interface TeamLoginsProps {
  /** Unix ms: rows answered since then stay on the list, for progress. */
  since?: number;
  /** Every row is answered (fires once). */
  onDone?: () => void;
  /** Only these agents' asks (the setup checklist's); a Connect skips the rest. */
  agentIds?: ReadonlySet<string>;
  /** Shown instead of the empty line when there's nothing to connect. */
  empty?: string;
}

export function TeamLogins({ since, onDone, agentIds, empty }: TeamLoginsProps) {
  const load = useCallback(async () => {
    const all = await teamLogins(since);
    return agentIds ? scopeTeam(all, agentIds) : all;
  }, [since, agentIds]);
  const { data: team, error, execute } = useAsyncState<Team>(load, { immediate: true });
  const refresh = useCallback(() => void execute(), [execute]);
  useEffect(() => {
    const offs = [AGENT_EVENTS.message, AGENT_EVENTS.registry].map((e) => listen(e, refresh));
    return () => {
      offs.forEach((off) => void off.then((f) => f()).catch(() => undefined));
    };
  }, [refresh]);
  usePolling(() => execute(), { intervalMs: 3000, enabled: teamBusy(team), name: 'team-logins' });
  const waitingKeys = (team?.needs ?? []).filter((n) => !n.done).map((n) => n.key);
  const waitingRows = waitingKeys.length;
  const told = useRef(false);
  useEffect(() => {
    if (!team || told.current || team.total === 0 || team.done < team.total) return;
    told.current = true;
    onDone?.();
  }, [team, onDone]);

  if (error && !team) {
    return (
      <p className="agent-editor__error" role="alert">
        <ErrorIcon size={12} className="inline-error-icon" />
        {formatCommandError(asCommandError(error))}
      </p>
    );
  }
  if (!team) {
    return (
      <div className="team-logins team-logins--loading">
        <Spinner size="sm" />
      </div>
    );
  }
  if (team.total === 0) {
    if (empty === '') return null;
    return (
      <p className="team-logins__empty">
        {empty ?? 'Nothing to connect. When an agent needs an app, its sign-in card shows here.'}
      </p>
    );
  }
  return (
    <div className="team-logins">
      <div className="team-logins__top">
        <p className="team-logins__progress" aria-live="polite">
          {progressLine(team)}
        </p>
        {waitingRows > 1 && <SkipRest rows={waitingKeys} onChanged={refresh} />}
      </div>
      <ul className="team-logins__rows">
        {team.needs.map((need) => (
          <NeedRow key={need.key} need={need} onChanged={refresh} />
        ))}
      </ul>
    </div>
  );
}

/**
 * "Skip the rest": every row still waiting, declined for the team. Only the
 * rows this list shows (a scoped list names its own keys).
 */
function SkipRest({ rows, onChanged }: { rows: string[]; onChanged: () => void }) {
  const notNeeded = useNotNeeded();
  const [error, setError] = useState<string | null>(null);
  return (
    <span className="team-logins__skip-rest">
      <TextButton
        tabIndex={0}
        data-skip-rest
        onClick={() => {
          setError(null);
          void notNeeded(() => loginsNotNeeded(rows))
            .then(onChanged)
            .catch((err) => setError(formatCommandError(asCommandError(err))));
        }}
      >
        Skip the rest
      </TextButton>
      {error && (
        <span className="agent-editor__error" role="alert">
          {error}
        </span>
      )}
    </span>
  );
}

function NeedRow({ need, onChanged }: { need: TeamNeed; onChanged: () => void }) {
  const notNeeded = useNotNeeded();
  const [skipped, setSkipped] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(!need.done);
  const waiting = waitingCards(need);
  const included = waitingCards(need, skipped);
  const primary = needPrimary(need);
  const others = need.options.filter((o) => o.id !== primary?.id && o.method !== 'key');
  const signingIn = waiting.some(
    (c) => c.flow?.state === 'waiting' || c.flow?.state === 'starting'
  );
  const run = async (task: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await task();
      onChanged();
    } catch (err) {
      setError(formatCommandError(asCommandError(err)));
    } finally {
      setBusy(false);
    }
  };
  // Agents this list leaves off (`agentIds`) are skipped by its Connect too.
  const hidden = (need as TeamNeed & { hidden?: string[] }).hidden ?? [];
  const connect = (o: LoginOption) =>
    run(() => connectTeamNeed(need.key, o.id, [...skipped, ...hidden]));
  const names = need.cards.map((c) => c.agentName);
  const live = waiting.find((c) => c.flow?.state === 'waiting' && c.flow.url);

  return (
    <li className="team-logins__row" data-need={need.key} data-done={need.done || undefined}>
      <div className="team-logins__head">
        <span className="team-logins__title">
          {need.done && <CheckIcon size={12} className="team-logins__done-icon" />}
          {need.title}
        </span>
        <span className="team-logins__who">Used by {listNames(names)}</span>
        {need.done && (
          <TextButton tabIndex={0} onClick={() => setOpen((v) => !v)}>
            {open ? 'Hide' : 'Show'}
          </TextButton>
        )}
      </div>
      {open && (
        <>
          <ul className="team-logins__agents">
            {need.cards.map((c) => {
              const isWaiting = c.state === 'waiting';
              return (
                <li key={c.requestId} className="team-logins__agent" data-state={c.state}>
                  {isWaiting ? (
                    <Checkbox
                      checked={!skipped.has(c.agentId)}
                      label={`Include ${c.agentName}`}
                      disabled={busy || signingIn}
                      onChange={(on) =>
                        setSkipped((s) => {
                          const next = new Set(s);
                          if (on) next.delete(c.agentId);
                          else next.add(c.agentId);
                          return next;
                        })
                      }
                    />
                  ) : (
                    <span className="team-logins__agent-mark" aria-hidden />
                  )}
                  <span className="team-logins__agent-text">
                    <span className="team-logins__agent-name">{c.agentName}</span>
                    <span className="team-logins__agent-line">{teamCardLine(c)}</span>
                  </span>
                  {isWaiting && (
                    <TextButton
                      tabIndex={0}
                      className="team-logins__dismiss"
                      disabled={busy}
                      aria-label={`Not now for ${c.agentName}`}
                      title={`Tells ${c.agentName} no, this time, as its card’s Not now does. “Not needed” below is for every agent, with Undo.`}
                      onClick={() => void run(() => dismissLogin(c.agentId, c.requestId))}
                    >
                      Not now
                    </TextButton>
                  )}
                </li>
              );
            })}
          </ul>
          {waiting.length > 0 && need.noConnector && (
            <p className="team-logins__note">{need.noConnector}</p>
          )}
          {/* The backend's detail names one agent; it reads right only when there's one. */}
          {waiting.length === 1 && primary && <p className="team-logins__note">{primary.detail}</p>}
          {live && (
            <SignInHelp agentId={live.agentId} requestId={live.requestId} flow={live.flow} />
          )}
          {waiting.length > 0 && need.options.length === 0 && (
            <p className="team-logins__note">
              Nothing on {THIS_COMPUTER} can sign these agents in. Answer each in its own chat.
            </p>
          )}
          {waiting.length > 0 && need.options.length === 0 && (
            <div className="team-logins__actions">
              <NotNeededButton
                disabled={busy}
                onClick={() => void run(() => notNeeded(() => loginsNotNeeded([need.key])))}
              />
            </div>
          )}
          {waiting.length > 0 && need.options.length > 0 && (
            <div className="team-logins__actions">
              <NotNeededButton
                disabled={busy || signingIn}
                onClick={() => void run(() => notNeeded(() => loginsNotNeeded([need.key])))}
              />
              {others.map((o) => (
                <Button
                  key={o.id}
                  tabIndex={0}
                  variant="secondary"
                  disabled={busy || signingIn || included.length === 0}
                  onClick={() => void connect(o)}
                >
                  {o.label}
                </Button>
              ))}
              {primary && primary.method !== 'key' && (
                <Button
                  tabIndex={0}
                  variant="strong"
                  data-allow
                  disabled={busy || signingIn || included.length === 0}
                  onClick={() => void connect(primary)}
                >
                  {signingIn ? `Signing in on ${THIS_COMPUTER}…` : primary.label}
                  {included.length > 1 && !signingIn ? ` for ${included.length}` : ''}
                </Button>
              )}
            </div>
          )}
          {error && (
            <p className="agent-editor__error" role="alert">
              <ErrorIcon size={12} className="inline-error-icon" />
              {error}
            </p>
          )}
        </>
      )}
    </li>
  );
}

/** A row's "Not needed": the app, for every agent, remembered. */
function NotNeededButton({ disabled, onClick }: { disabled: boolean; onClick: () => void }) {
  return (
    <Button
      tabIndex={0}
      variant="secondary"
      data-not-needed
      disabled={disabled}
      title="No agent asks for it again. Turn it back on from Settings → Agents."
      onClick={onClick}
    >
      Not needed
    </Button>
  );
}

/** The same list in a dialog: ⌘K "Set up logins for agents…" and the import card. */
export function TeamLoginsModal() {
  const modal = useModal('teamLogins');
  // Rows answered while it's open stay on it, so progress counts up.
  const [since] = useState(() => Date.now() - 60 * 60 * 1000);
  return (
    <ModalFrame
      isOpen={modal.isOpen}
      onClose={modal.close}
      title="What your team needs"
      className="team-logins-modal"
    >
      <div className="team-logins-modal__body">
        <p className="team-logins__lede">
          Each app your agents asked for, once. Connecting signs in on {THIS_COMPUTER}; no agent
          ever sees a password, and you can take any of it back from the agent’s “What it can
          reach”.
        </p>
        {modal.isOpen && <TeamLogins since={since} />}
      </div>
    </ModalFrame>
  );
}
