/**
 * Settings → Agents → "Slack": start agents from a Slack message, answer in
 * the thread (`agents/slack.rs`).
 *
 * Not connected: three steps, each one line. Create the Slack app (Slack
 * opens with it filled in), install it, paste its User OAuth Token into a
 * masked field. Connected: the switch, who answers, where it listens, the
 * trigger word, whether others may start it, and how replies go out.
 *
 * @module components/agents/AgentsSlackSettings
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { Button } from '../primitives/Button';
import { Checkbox } from '../primitives/Checkbox';
import { Dropdown, DropdownItem } from '../primitives/Dropdown';
import { MenuButton } from '../primitives/MenuButton';
import { TextField } from '../primitives/TextField';
import { CheckIcon, ChevronIcon } from '@/components/icons';
import { Row, Toggle } from './AgentSettingsRows';
import { useOptionalToast } from '../../contexts/ToastContext';
import { useAsyncState } from '../../hooks/useAsyncState';
import { useAgentsSelector } from '../../lib/agentsStore';
import { takeSettingsSectionRequest } from '../../lib/settings';
import {
  SLACK_EVENT,
  SLACK_TITLE,
  connectSlack,
  disconnectSlack,
  getSlackStatus,
  listSlackConversations,
  openSlackSetup,
  slackLine,
  updateSlack,
  whereLine,
  type SlackConversation,
  type SlackPatch,
  type SlackStatus,
} from '../../lib/slack';
import type { Agent } from '../../lib/agents';
import { THIS_COMPUTER } from '../../lib/computer';

type Act =
  | { kind: 'read' }
  | { kind: 'connect'; token: string }
  | { kind: 'update'; patch: SlackPatch }
  | { kind: 'disconnect' };

const act = (a: Act): Promise<SlackStatus> => {
  switch (a.kind) {
    case 'connect':
      return connectSlack(a.token);
    case 'update':
      return updateSlack(a.patch);
    case 'disconnect':
      return disconnectSlack();
    default:
      return getSlackStatus();
  }
};

const selectAgents = (s: { agents: Agent[] }) => s.agents;

export function AgentsSlackSettings() {
  const { showToast } = useOptionalToast();
  const onError = useCallback((e: Error) => showToast(e.message, 'error'), [showToast]);
  // One call at a time, in the order asked: a read that started before a
  // change never answers after it.
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const serial = useCallback((a: Act) => {
    const next = queue.current.catch(() => {}).then(() => act(a));
    queue.current = next;
    return next;
  }, []);
  const {
    data: status,
    execute,
    isLoading,
  } = useAsyncState<SlackStatus, [Act]>(serial, {
    onError,
  });
  const run = useCallback((a: Act) => execute(a).catch(() => undefined), [execute]);

  useEffect(() => {
    void run({ kind: 'read' });
    let off: (() => void) | undefined;
    let gone = false;
    void listen(SLACK_EVENT, () => void run({ kind: 'read' }))
      .then((un) => (gone ? un() : (off = un)))
      .catch(() => {});
    return () => {
      gone = true;
      off?.();
    };
  }, [run]);

  // Opened from ⌘K "Talk to your agents from Slack…": scrolled to here.
  const ref = useRef<HTMLElement>(null);
  const loaded = !!status;
  useEffect(() => {
    if (loaded && takeSettingsSectionRequest('agent-slack')) {
      ref.current?.scrollIntoView?.({ block: 'start' });
    }
  }, [loaded]);

  return (
    <section ref={ref} className="settings-group" aria-labelledby="agents-settings-slack">
      <h3 className="settings-group__title" id="agents-settings-slack">
        {SLACK_TITLE}
      </h3>
      <div className="settings-section" data-testid="slack-settings">
        {status?.connected ? (
          <Connected status={status} run={run} busy={isLoading} />
        ) : (
          <Row label="Talk to your agents from Slack" description={slackLine(status ?? null)} />
        )}
        {status && (!status.connected || status.needsSignIn) && (
          <Setup status={status} run={run} busy={isLoading} />
        )}
      </div>
    </section>
  );
}

type Run = (a: Act) => Promise<SlackStatus | null | undefined>;

function Setup({ status, run, busy }: { status: SlackStatus; run: Run; busy: boolean }) {
  const [token, setToken] = useState('');
  const { showToast } = useOptionalToast();
  const connect = async () => {
    const done = await run({ kind: 'connect', token: token.trim() });
    if (done?.connected) {
      setToken('');
      showToast(`Connected to ${done.team ?? 'Slack'}`, 'success');
    }
  };
  return (
    <div data-testid="slack-setup">
      <Row
        label="1. Create the Slack app"
        description="Slack opens with the app filled in. Pick your workspace, then Create."
      >
        <Button
          variant="secondary"
          onClick={() =>
            void openSlackSetup(status).catch((e: unknown) =>
              showToast(e instanceof Error ? e.message : String(e), 'error')
            )
          }
        >
          Open Slack…
        </Button>
      </Row>
      <Row
        label="2. Install it"
        description="In the app, choose Install to Workspace, then copy the User OAuth Token (xoxp-…)."
      />
      <Row label="3. Paste the token" description="Kept in this Mac’s Keychain, never shown again.">
        <form
          className="settings-row-actions"
          onSubmit={(e) => {
            e.preventDefault();
            if (token.trim()) void connect();
          }}
        >
          <TextField
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder="xoxp-…"
            aria-label="User OAuth Token"
            value={token}
            onChange={(e) => setToken(e.target.value)}
          />
          <Button type="submit" variant="secondary" disabled={!token.trim() || busy}>
            Connect
          </Button>
        </form>
      </Row>
    </div>
  );
}

function Connected({ status, run, busy }: { status: SlackStatus; run: Run; busy: boolean }) {
  const agents = useAgentsSelector(selectAgents);
  // What's typed but not saved; otherwise the saved trigger shows.
  const [draft, setDraft] = useState<string | null>(null);
  const trigger = draft ?? status.trigger;
  const [choosing, setChoosing] = useState(false);
  const { showToast } = useOptionalToast();
  const update = (patch: SlackPatch) => void run({ kind: 'update', patch });
  // Whether Slack signed the token out too, or only this Mac forgot it.
  const disconnect = async () => {
    const after = await run({ kind: 'disconnect' });
    if (after?.disconnected) showToast(after.disconnected, 'info');
  };
  const saveTrigger = () => {
    const t = trigger.trim();
    if (t && t !== status.trigger) update({ trigger: t });
    setDraft(null);
  };
  return (
    <div data-testid="slack-connected">
      <Row label="Listen in Slack" description={slackLine(status)}>
        <Toggle
          on={status.enabled && !status.needsSignIn}
          label="Listen in Slack"
          onChange={(on) => update({ enabled: on })}
        />
      </Row>
      <Row label="Who answers" description="Your messages there go to this agent’s chat here.">
        <AgentPicker
          agents={agents}
          current={status.agentId ?? null}
          name={status.agentName ?? 'Chief of Staff'}
          onPick={(id) => update({ agentId: id })}
        />
      </Row>
      <Row label="Where it listens" description={whereLine(status.conversations)}>
        <Button variant="secondary" onClick={() => setChoosing((c) => !c)} disabled={busy}>
          {choosing ? 'Done' : 'Choose…'}
        </Button>
      </Row>
      {choosing && (
        <ConversationPicker
          chosen={status.conversations}
          onSave={(conversations) => update({ conversations })}
        />
      )}
      <Row
        label="Trigger"
        description="Only a message that starts with this reaches your agent, so chatter never does."
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            saveTrigger();
          }}
        >
          <TextField
            aria-label="Trigger"
            className="agents-slack-trigger"
            value={trigger}
            spellCheck={false}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={saveTrigger}
          />
        </form>
      </Row>
      <Row
        label="Let others start it"
        description="When someone @-mentions you with the trigger. Their words are outside text, and replies always ask you first."
      >
        <Toggle
          on={status.othersCanStart}
          label="Let others start it"
          onChange={(on) => update({ othersCanStart: on })}
        />
      </Row>
      <Row
        label="Replies"
        description="Posted in the thread under your name after you OK the exact words. Only at Unleashed, with exact-text OK off, does a reply to your own message go by itself."
      />
      <Row
        label="Disconnect"
        description={`Signs the token out with Slack and removes it from ${THIS_COMPUTER}. Slack keeps the app.`}
      >
        <Button variant="secondary" onClick={() => void disconnect()}>
          Disconnect
        </Button>
      </Row>
    </div>
  );
}

function AgentPicker({
  agents,
  current,
  name,
  onPick,
}: {
  agents: Agent[];
  current: string | null;
  name: string;
  onPick: (id: string | null) => void;
}) {
  return (
    <Dropdown
      align="right"
      menuClassName="agent-defaults-menu"
      trigger={(props) => (
        <MenuButton
          variant="secondary"
          className="agent-defaults-trigger"
          aria-label={`Who answers in Slack: ${name}`}
          expanded={props['aria-expanded']}
          {...props}
        >
          <span className="agent-defaults-trigger__label">{name}</span>
          <ChevronIcon
            size={10}
            className={props['aria-expanded'] ? 'chevron-flipped' : undefined}
          />
        </MenuButton>
      )}
    >
      {agents.map((a) => {
        const on = a.id === current;
        return (
          <DropdownItem
            key={a.id}
            active={on}
            icon={
              <span className="agent-defaults-menu__check" aria-hidden="true">
                {on && <CheckIcon size={14} />}
              </span>
            }
            onSelect={() => onPick(a.isMain ? null : a.id)}
          >
            <span className="agent-defaults-menu__label">{a.name}</span>
          </DropdownItem>
        );
      })}
    </Dropdown>
  );
}

function ConversationPicker({
  chosen,
  onSave,
}: {
  chosen: SlackConversation[];
  onSave: (c: SlackConversation[]) => void;
}) {
  const { showToast } = useOptionalToast();
  const { data: all, execute } = useAsyncState<SlackConversation[], []>(listSlackConversations, {
    onError: (e) => showToast(e.message, 'error'),
  });
  useEffect(() => void execute().catch(() => {}), [execute]);
  const picked = new Set(chosen.map((c) => c.id));
  // Chosen ones Slack no longer lists stay visible, so they can be unticked.
  const rows = [...chosen.filter((c) => !all?.some((x) => x.id === c.id)), ...(all ?? [])];
  const toggle = (c: SlackConversation, on: boolean) =>
    onSave(on ? [...chosen, c] : chosen.filter((x) => x.id !== c.id));
  if (!all) {
    return <Row label="Your conversations" description="Reading them from Slack…" />;
  }
  return (
    <div className="agents-slack-conversations" data-testid="slack-conversations">
      {rows.map((c) => (
        <label key={c.id} className="agents-slack-conversation">
          <Checkbox checked={picked.has(c.id)} label={c.name} onChange={(on) => toggle(c, on)} />
          <span>{c.name}</span>
        </label>
      ))}
    </div>
  );
}
