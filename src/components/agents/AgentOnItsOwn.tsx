/**
 * "What can this agent do without asking me?" on the desk
 * (`agents/on_its_own.rs`, words in `companion-protocol/src/onItsOwn.ts`):
 *
 * - **The modal** (`AgentOnItsOwnModal`): one agent's level and its line,
 *   what always asks, then every standing rule in plain words, grouped
 *   (rules, plans you OK'd with time left, apps, browser, team and
 *   accounts), each with the one tap that takes it away. Opened from the
 *   agent's … menu and right-click menu, and ⌘K "What can <agent> do on its
 *   own?".
 * - **Settings → Agents** (`OnItsOwnTeamSettings`): the team's level, the
 *   rules every agent shares, and each agent in a line that opens to its
 *   own list.
 *
 * Nothing here gives: each button narrows, applied at once by the Mac with a
 * line in the agent's chat. Giving more stays on cards and in Settings.
 *
 * @module components/agents/AgentOnItsOwn
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { ErrorIcon } from '@/components/icons';
import { ModalFrame } from '../primitives/ModalFrame';
import { TextButton } from '../primitives/TextButton';
import { Spinner } from '../primitives/Spinner';
import { useAsyncState } from '../../hooks/useAsyncState';
import { usePolling } from '../../hooks/usePolling';
import { asCommandError, formatCommandError } from '../../lib/errors';
import { useAgentsSelector } from '../../lib/agentsStore';
import { takeSettingsSectionRequest } from '../../lib/settings';
import { INDEPENDENCE_LABEL } from '../../../packages/companion-protocol/src/independence';
import {
  ON_ITS_OWN_ALWAYS_ASKS,
  ON_ITS_OWN_FOOT,
  ON_ITS_OWN_NONE,
  ON_ITS_OWN_STANDING,
  ON_ITS_OWN_TEAM_TITLE,
  agentOnItsOwn,
  narrowA11y,
  narrowKey,
  narrowLabel,
  narrowOnItsOwn,
  onItsOwnIsBare,
  onItsOwnLevel,
  onItsOwnSections,
  onItsOwnTeamRowLine,
  onItsOwnTitle,
  teamOnItsOwn,
  timeLeftLine,
  type OnItsOwn,
  type OnItsOwnItem,
  type OnItsOwnNarrow,
  type OnItsOwnTeam,
} from '../../lib/agentOnItsOwn';

/** Re-read while shown: a plan's time left, and anything changed elsewhere. */
const REFRESH_MS = 30_000;

function ItemRow({
  item,
  now,
  busy,
  onNarrow,
}: {
  item: OnItsOwnItem;
  now: number;
  busy: string | null;
  onNarrow: (n: OnItsOwnNarrow) => void;
}) {
  return (
    <li className="on-its-own__item">
      <span className="on-its-own__text">
        <span className="on-its-own__what">{item.text}</span>
        {(item.detail || item.endsAt) && (
          <span className="on-its-own__detail">
            {[item.detail, item.endsAt ? timeLeftLine(item.endsAt, now) : null]
              .filter(Boolean)
              .join(' · ')}
          </span>
        )}
      </span>
      {item.narrow.length > 0 && (
        <span className="on-its-own__actions">
          {item.narrow.map((n) => {
            const key = narrowKey(n);
            return (
              <TextButton
                key={key}
                tabIndex={0}
                className="on-its-own__narrow"
                aria-label={narrowA11y(n, item)}
                disabled={busy !== null}
                onClick={() => onNarrow(n)}
              >
                {busy === key ? <Spinner size="sm" /> : narrowLabel(n)}
              </TextButton>
            );
          })}
        </span>
      )}
    </li>
  );
}

/** The list itself: the modal's body, and an agent opened in Settings. */
export function OnItsOwnBody({ agentId }: { agentId: string }) {
  const load = useCallback(() => agentOnItsOwn(agentId), [agentId]);
  const { data, setData, error: loadError, execute } = useAsyncState<OnItsOwn>(load);
  // The registry entry changes when a rule, admin or browser does.
  const entry = useAgentsSelector((s) => s.agents?.find((a) => a.id === agentId));
  useEffect(() => {
    void execute();
  }, [execute, entry]);
  const [now, setNow] = useState(() => Date.now());
  usePolling(
    async () => {
      setNow(Date.now());
      await execute();
    },
    { intervalMs: REFRESH_MS, name: 'on-its-own' }
  );
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const narrow = async (n: OnItsOwnNarrow) => {
    setBusy(narrowKey(n));
    setError(null);
    try {
      setData(await narrowOnItsOwn(agentId, n));
      setNow(Date.now());
    } catch (e) {
      setError(formatCommandError(asCommandError(e)));
    } finally {
      setBusy(null);
    }
  };

  if (!data) {
    return loadError ? (
      <p className="on-its-own__error" role="alert">
        <ErrorIcon size={12} className="inline-error-icon" />
        {formatCommandError(asCommandError(loadError))}
      </p>
    ) : (
      <div className="on-its-own__loading">
        <Spinner size="sm" />
      </div>
    );
  }

  const sections = onItsOwnSections(data.items);
  return (
    <div className="on-its-own" data-testid="on-its-own">
      <section className="on-its-own__level" aria-label="Its level">
        <span className="on-its-own__level-name">{onItsOwnLevel(data.level, data.ownLevel)}</span>
        <span className="on-its-own__level-line">{data.levelLine}</span>
      </section>

      <section className="on-its-own__section" aria-label={ON_ITS_OWN_ALWAYS_ASKS}>
        <h4 className="on-its-own__heading">{ON_ITS_OWN_ALWAYS_ASKS}</h4>
        <ul className="on-its-own__asks">
          {data.alwaysAsks.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      </section>

      <h4 className="on-its-own__heading on-its-own__heading--lead">{ON_ITS_OWN_STANDING}</h4>
      {onItsOwnIsBare(data) && <p className="on-its-own__none">{ON_ITS_OWN_NONE}</p>}
      {sections.map((s) => (
        <section key={s.title} className="on-its-own__section" aria-label={s.title}>
          <h5 className="on-its-own__subheading">{s.title}</h5>
          <ul className="on-its-own__list">
            {s.items.map((item) => (
              <ItemRow
                key={item.key}
                item={item}
                now={now}
                busy={busy}
                onNarrow={(n) => void narrow(n)}
              />
            ))}
          </ul>
        </section>
      ))}

      {error && (
        <p className="on-its-own__error" role="alert">
          <ErrorIcon size={12} className="inline-error-icon" />
          {error}
        </p>
      )}
      <p className="on-its-own__foot">{ON_ITS_OWN_FOOT}</p>
    </div>
  );
}

export function AgentOnItsOwnModal({
  agentId,
  onClose,
}: {
  /** The agent shown; `null` closes it. */
  agentId: string | null;
  onClose: () => void;
}) {
  const name = useAgentsSelector(
    (s) => s.agents?.find((a) => a.id === agentId)?.name ?? 'this agent'
  );
  return (
    <ModalFrame
      isOpen={agentId !== null}
      onClose={onClose}
      title={onItsOwnTitle(name)}
      className="on-its-own-modal"
    >
      <div className="on-its-own-modal__body">{agentId && <OnItsOwnBody agentId={agentId} />}</div>
    </ModalFrame>
  );
}

/** Settings → Agents: the team's answer, each agent opening in place. */
export function OnItsOwnTeamSettings() {
  const load = useCallback(() => teamOnItsOwn(), []);
  const { data, setData, error: loadError, execute } = useAsyncState<OnItsOwnTeam>(load);
  const registry = useAgentsSelector((s) => s.agents);
  useEffect(() => {
    void execute();
  }, [execute, registry]);
  const chief = useAgentsSelector((s) => s.agents?.find((a) => a.isMain)?.id ?? null);
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    if (data && takeSettingsSectionRequest('agent-on-its-own')) {
      ref.current?.scrollIntoView?.({ block: 'start' });
    }
  }, [data]);

  // A team rule is taken back through the Chief: the line lands in its chat.
  const narrowTeam = async (n: OnItsOwnNarrow) => {
    if (!chief) return;
    setBusy(narrowKey(n));
    setError(null);
    try {
      await narrowOnItsOwn(chief, n);
      setData(await teamOnItsOwn());
    } catch (e) {
      setError(formatCommandError(asCommandError(e)));
    } finally {
      setBusy(null);
    }
  };

  return (
    <section
      ref={ref}
      className="settings-group on-its-own-team"
      aria-labelledby="agents-settings-on-its-own"
    >
      <h3 className="settings-group__title" id="agents-settings-on-its-own">
        {ON_ITS_OWN_TEAM_TITLE}
      </h3>
      {loadError && !data && (
        <p className="on-its-own__error" role="alert">
          <ErrorIcon size={12} className="inline-error-icon" />
          {formatCommandError(asCommandError(loadError))}
        </p>
      )}
      {data && (
        <div className="on-its-own">
          <section className="on-its-own__level" aria-label="The team’s level">
            <span className="on-its-own__level-name">{INDEPENDENCE_LABEL[data.level]}</span>
            <span className="on-its-own__level-line">{data.levelLine}</span>
            <span className="on-its-own__level-line">{data.alwaysAsks.join(' ')}</span>
          </section>
          {data.teamRules.length > 0 && (
            <section className="on-its-own__section" aria-label="Rules for every agent">
              <h5 className="on-its-own__subheading">Rules for every agent</h5>
              <ul className="on-its-own__list">
                {data.teamRules.map((item) => (
                  <ItemRow
                    key={item.key}
                    item={item}
                    now={Date.now()}
                    busy={busy}
                    onNarrow={(n) => void narrowTeam(n)}
                  />
                ))}
              </ul>
            </section>
          )}
          <ul className="on-its-own__list on-its-own__agents">
            {data.agents.map((row) => (
              <li key={row.agentId} className="on-its-own__agent">
                <button
                  type="button"
                  className="on-its-own__agent-head"
                  aria-expanded={open === row.agentId}
                  onClick={() => setOpen((o) => (o === row.agentId ? null : row.agentId))}
                >
                  <span className="on-its-own__what">{row.name}</span>
                  <span className="on-its-own__detail">{onItsOwnTeamRowLine(row)}</span>
                </button>
                {open === row.agentId && (
                  <div className="on-its-own__agent-body">
                    <OnItsOwnBody agentId={row.agentId} />
                  </div>
                )}
              </li>
            ))}
          </ul>
          {error && (
            <p className="on-its-own__error" role="alert">
              <ErrorIcon size={12} className="inline-error-icon" />
              {error}
            </p>
          )}
        </div>
      )}
    </section>
  );
}
