/**
 * "Setting up your team": the one card in the Chief's chat after an import
 * (`agents/team_setup.rs`, `lib/teamSetup.ts`). Everything the new agents
 * need from the user, in a fixed order — logins, routines to switch on,
 * what they said they're missing, then saying hi to each — instead of a
 * request in every chat. It sits in the conversation where it was posted,
 * like a message (`setupItemIndex`), and scrolls up with the history; it
 * updates in place there: a login saved in an agent's own chat ticks it off
 * here. The bar above the composer brings it back into view.
 *
 * Every step can be skipped and opened again; the first open one is
 * expanded. Progress counts steps ("2 steps left"), never requests. The
 * agents stay quiet until the user says hi, one at a time.
 *
 * Seams: the Logins step lists each login and opens its secure card in
 * place; the Logins screen built for the import review (login cards, the
 * `request_login` tool) replaces that list when it lands. The collapsed
 * review Bar for pending requests sits above the composer; this card's
 * logins are left out of it and of the "Review X's request" chips.
 *
 * @module components/agents/TeamSetupCard
 */

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { CheckIcon, ChevronRightIcon, ListIcon } from '@/components/icons';
import { Button } from '../primitives/Button';
import { TextButton } from '../primitives/TextButton';
import { useOptionalToast } from '../../contexts/ToastContext';
import { asCommandError, formatCommandError } from '../../lib/errors';
import { answerApproval, type AgentMessage } from '../../lib/agents';
import { loadMessages, useAgentsSelector } from '../../lib/agentsStore';
import {
  askChiefAboutMissing,
  dismissTeamSetup,
  groupLogins,
  helloBusy,
  progressLine,
  sayHiFromSetup,
  setTeamSetupRoutine,
  setTeamSetupStep,
  SETUP_TITLE,
  sourceLine,
  stepStatus,
  stepWords,
  type SetupLogin,
  type SetupStep,
  type SetupStepId,
  type TeamSetupView,
} from '../../lib/teamSetup';
import { AgentCard, AgentLine } from './AgentCard';
import { AgentKey } from './AgentKey';
import { ApprovalCard } from './AgentChatItems';
import { SetupReach } from './TeamSetupReach';
import { TeamLogins } from './TeamLogins';

interface TeamSetupCardProps {
  view: TeamSetupView;
  chief: string;
  /** Open an agent's own chat (after saying hi, or from a login's row). */
  onOpenAgent?: (agentId: string) => void;
}

export function TeamSetupCard({ view, chief, onOpenAgent }: TeamSetupCardProps) {
  const { showToast } = useOptionalToast();
  // The step the user opened, else the first open one.
  const [picked, setPicked] = useState<SetupStepId | 'none' | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const run = async (key: string, f: () => Promise<unknown>) => {
    setBusy(key);
    try {
      await f();
    } catch (e) {
      showToast(formatCommandError(asCommandError(e)), 'error');
    } finally {
      setBusy(null);
    }
  };

  if (view.complete) {
    return (
      <AgentLine className="team-setup__done" data-testid="team-setup-done">
        <CheckIcon size={12} aria-hidden="true" /> Done · Your team is set up.{' '}
        <TextButton tabIndex={0} onClick={() => void run('dismiss', dismissTeamSetup)}>
          Hide
        </TextButton>
      </AgentLine>
    );
  }

  const expanded = picked === 'none' ? null : (picked ?? view.current ?? null);
  return (
    <div className="agent-chat__row agent-chat__row--agent agent-chat__row--card" data-team-setup>
      <AgentCard
        as="section"
        className="team-setup"
        aria-label={SETUP_TITLE}
        data-testid="team-setup"
        data={{ current: view.current }}
        icon={<ListIcon size={14} />}
        title={SETUP_TITLE}
        meta={progressLine(view)}
        source={sourceLine(view)}
      >
        <ol className="team-setup__steps">
          {view.steps.map((step) => (
            <StepRow
              key={step.id}
              step={step}
              chief={chief}
              open={expanded === step.id}
              onToggle={() => setPicked(expanded === step.id ? 'none' : step.id)}
            >
              <StepBody
                step={step}
                view={view}
                chief={chief}
                busy={busy}
                run={run}
                onOpenAgent={onOpenAgent}
                onMoved={() => setPicked(null)}
              />
            </StepRow>
          ))}
        </ol>
      </AgentCard>
    </div>
  );
}

function StepRow({
  step,
  chief,
  open,
  onToggle,
  children,
}: {
  step: SetupStep;
  chief: string;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  const words = stepWords(step.id, chief);
  const status = stepStatus(step, chief);
  return (
    <li
      className="team-setup__step"
      data-step={step.id}
      data-state={step.state}
      data-open={open || undefined}
    >
      <button
        type="button"
        tabIndex={0}
        className="team-setup__step-head"
        aria-expanded={open}
        onClick={onToggle}
      >
        <span className="team-setup__mark" aria-hidden="true">
          {step.state === 'done' && <CheckIcon size={12} />}
        </span>
        <span className="team-setup__step-title">{words.title}</span>
        {status && <span className="team-setup__step-status">{status}</span>}
        <ChevronRightIcon size={10} className="team-setup__chevron" />
      </button>
      {open && <div className="team-setup__step-body">{children}</div>}
    </li>
  );
}

function StepBody({
  step,
  view,
  chief,
  busy,
  run,
  onOpenAgent,
  onMoved,
}: {
  step: SetupStep;
  view: TeamSetupView;
  chief: string;
  busy: string | null;
  run: (key: string, f: () => Promise<unknown>) => Promise<void>;
  onOpenAgent?: (agentId: string) => void;
  onMoved: () => void;
}) {
  const words = stepWords(step.id, chief);
  const mark = (state: 'done' | 'skipped' | 'open') =>
    run(`step:${step.id}`, async () => {
      await setTeamSetupStep(step.id, state);
      onMoved();
    });
  const closed = step.state !== 'open';
  const footer = (affirmative?: ReactNode) => (
    <div className="team-setup__actions">
      {closed ? (
        <TextButton tabIndex={0} disabled={!!busy} onClick={() => void mark('open')}>
          Open again
        </TextButton>
      ) : (
        <>
          <TextButton tabIndex={0} disabled={!!busy} onClick={() => void mark('skipped')}>
            Skip for now
          </TextButton>
          {affirmative}
        </>
      )}
    </div>
  );

  switch (step.id) {
    case 'logins':
      return (
        <>
          {(step.later ?? []).length > 0 ? (
            <SetupReach step={step} onOpenAgent={onOpenAgent} />
          ) : (
            <p className="team-setup__detail">{words.detail}</p>
          )}
          {((step.later ?? []).length === 0 || (step.logins ?? []).length > 0) && (
            <SetupLogins logins={step.logins ?? []} onOpenAgent={onOpenAgent} />
          )}
          {footer()}
        </>
      );
    case 'routines':
      return (
        <>
          <p className="team-setup__detail">{words.detail}</p>
          <ul className="team-setup__list">
            {(step.routines ?? []).map((r) => {
              const key = `routine:${r.agentId}:${r.checkInId}`;
              return (
                <li key={key} className="team-setup__item">
                  <div className="team-setup__item-text">
                    <span className="team-setup__item-title">
                      {r.agentName} · {r.when}
                    </span>
                    <span className="team-setup__item-detail">{r.what}</span>
                  </div>
                  <button
                    type="button"
                    tabIndex={0}
                    className={`settings-toggle ${r.on ? 'on' : 'off'}`}
                    role="switch"
                    aria-checked={r.on}
                    aria-label={`${r.agentName}: ${r.what}`}
                    disabled={busy === key}
                    onClick={() =>
                      void run(key, () => setTeamSetupRoutine(r.agentId, r.checkInId, !r.on))
                    }
                  >
                    <span className="settings-toggle-track">
                      <span className="settings-toggle-thumb" />
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
          {footer(
            <Button
              variant="strong"
              size="compact"
              disabled={!!busy}
              onClick={() => void mark('done')}
            >
              Done
            </Button>
          )}
        </>
      );
    case 'missing':
      return (
        <>
          <p className="team-setup__detail">{words.detail}</p>
          <div className="team-setup__gaps">
            {(step.gaps ?? []).map((g) => (
              <section key={g.agentId} className="team-setup__gap" aria-label={g.agentName}>
                <h4 className="team-setup__gap-name">{g.agentName}</h4>
                <ul>
                  {g.lines.map((line, i) => (
                    <li key={i}>{line}</li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
          {footer(
            <Button
              variant="strong"
              size="compact"
              disabled={!!busy}
              onClick={() => void run('missing', askChiefAboutMissing)}
            >
              Ask {chief} to sort these
            </Button>
          )}
        </>
      );
    case 'hello': {
      const replying = helloBusy(view);
      return (
        <>
          <p className="team-setup__detail">{words.detail}</p>
          <ul className="team-setup__list">
            {(step.agents ?? []).map((a) => {
              const key = `hello:${a.agentId}`;
              return (
                <li key={a.agentId} className="team-setup__item" data-hello={a.state}>
                  <AgentKey id={a.agentId} name={a.agentName} color={a.color} size="sm" />
                  <span className="team-setup__item-title">{a.agentName}</span>
                  {a.state === 'quiet' ? (
                    <Button
                      variant="secondary"
                      size="compact"
                      disabled={!!busy || !!replying}
                      title={replying ? `${replying.agentName} is still replying` : undefined}
                      onClick={() => void run(key, () => sayHiFromSetup(a.agentId))}
                    >
                      Say hi
                    </Button>
                  ) : (
                    <span className="team-setup__item-state">
                      {a.state === 'working' ? 'Replying…' : 'Said hi'}
                      {onOpenAgent && (
                        <TextButton tabIndex={0} onClick={() => onOpenAgent(a.agentId)}>
                          Open
                        </TextButton>
                      )}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
          {footer(
            <Button
              variant="strong"
              size="compact"
              disabled={!!busy}
              onClick={() => void mark('done')}
            >
              Done
            </Button>
          )}
        </>
      );
    }
  }
}

/**
 * The Logins step. Apps an agent signs in to (login cards) are "What your
 * team needs", scoped to the agents being set up: one Connect per service
 * covers every agent on the row, with "Not needed" per agent. Keys and
 * other secure inputs stay one row per service, whoever needs them
 * ("Google — Gmail (2 accounts)", "Email drafts"), with each agent's secure
 * card opened in place. A row is always named by the app, never a raw key.
 */
export function SetupLogins({
  logins,
  onOpenAgent,
}: {
  logins: SetupLogin[];
  onOpenAgent?: (agentId: string) => void;
}) {
  const signIns = logins.filter((l) => l.kind === 'login');
  const keys = logins.filter((l) => l.kind !== 'login');
  const idList = [...new Set(signIns.map((l) => l.agentId))].sort().join(',');
  const agentIds = useMemo(() => new Set(idList ? idList.split(',') : []), [idList]);
  const groups = groupLogins(keys);
  if (logins.length === 0) return <p className="team-setup__empty">Every login is in.</p>;
  return (
    <>
      {signIns.length > 0 && <TeamLogins agentIds={agentIds} empty="" />}
      {groups.length > 0 && (
        <ul className="team-setup__list">
          {groups.map((g) => (
            <LoginGroupRow key={g.key} name={g.name} items={g.items} onOpenAgent={onOpenAgent} />
          ))}
        </ul>
      )}
    </>
  );
}

function LoginGroupRow({
  name,
  items,
  onOpenAgent,
}: {
  name: string;
  items: SetupLogin[];
  onOpenAgent?: (agentId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const who = [...new Set(items.map((l) => l.agentName))].join(', ');
  return (
    <li className="team-setup__login" data-open={open || undefined}>
      <div className="team-setup__item">
        <div className="team-setup__item-text">
          <span className="team-setup__item-title">{name}</span>
          <span className="team-setup__item-detail">{who}</span>
        </div>
        <Button
          variant="secondary"
          size="compact"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          {open ? 'Close' : 'Add'}
        </Button>
      </div>
      {open &&
        items.map((l) => <LoginCard key={l.requestId} login={l} onOpenAgent={onOpenAgent} />)}
    </li>
  );
}

function LoginCard({
  login,
  onOpenAgent,
}: {
  login: SetupLogin;
  onOpenAgent?: (agentId: string) => void;
}) {
  const { showToast } = useOptionalToast();
  const lines = useAgentsSelector((s) => s.messages[login.agentId]);
  useEffect(() => {
    if (!lines) void loadMessages(login.agentId);
  }, [lines, login.agentId]);
  const card: AgentMessage | undefined = lines?.find(
    (m) => m.approval?.requestId === login.requestId
  );
  return (
    <>
      {card ? (
        <ApprovalCard
          message={card}
          agentName={login.agentName}
          paused
          compact
          arrived={false}
          onAnswer={async (requestId, allow, always, note, choice) => {
            try {
              await answerApproval(login.agentId, requestId, allow, always, note, choice);
            } catch (e) {
              showToast(formatCommandError(asCommandError(e)), 'error');
            }
          }}
        />
      ) : lines ? (
        <p className="team-setup__empty">
          It’s in {login.agentName}’s chat.{' '}
          {onOpenAgent && (
            <TextButton tabIndex={0} onClick={() => onOpenAgent(login.agentId)}>
              Open
            </TextButton>
          )}
        </p>
      ) : null}
    </>
  );
}
