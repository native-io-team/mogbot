/**
 * Usage at a glance, always in sight: the row at the foot of the Agents
 * sidebar, answering "how much can my agents still do, and when does it
 * refill" in words anyone reads: "Usage 57% left this week", a meter with
 * one segment per real account (a second sign-in of one never draws one),
 * and "Refills Sat 10:00 AM", with "2 accounts" only when there are. A
 * status dot only when the user must act, or agents are out. It opens the
 * Usage view (`AgentsUsageView`), where every account is a key in order.
 *
 * Words and figures are the phone's too (`companion-protocol/usageGlance`
 * `row`): only what an engine reported; an account nobody has read is an
 * empty, dashed segment, never a full one. This row never asks for a
 * reading itself (`glance`); opening the view does.
 *
 * ⌘K "Usage and accounts…", "Switch account…" and "Add an account…" open
 * the view (`requestSwitcher`), as does the chat header's account chip.
 *
 * @module components/agents/AccountSwitcher
 */

import { useEffect, useMemo } from 'react';
import { ActivityIcon, ClaudeIcon, CodexIcon } from '@/components/icons';
import { Button } from '../primitives/Button';
import { Tooltip } from '../primitives/Tooltip';
import { FooterRowIcon, type FooterRowStatus } from '../workspace/FooterRowIcon';
import { useUsageAccounts } from './useUsageAccounts';
import { useUsageInventory } from './AgentsUsage';
import { StackMeter } from './UsageStack';
import { useAgentsSelector } from '../../lib/agentsStore';
import type { Agent, AgentEngine, EngineInfo } from '../../lib/agents';
import {
  onSwitcherRequest,
  requestSwitcher,
  requestUsageAdd,
  type UsageAccount,
} from '../../lib/agentAccounts';
import { usageGlance, type UsageGlance } from '../../lib/agentsUsage';
import {
  ranOnName,
  type WorkingLine,
} from '../../../packages/companion-protocol/src/accountSwitcher';
import type { StatusTone } from '../primitives/StatusPill';

const ENGINE_ICON: Record<AgentEngine, typeof ClaudeIcon> = {
  claude: ClaudeIcon,
  codex: CodexIcon,
};

/**
 * The row's corner dot: only when the user has something to do (nearly out
 * everywhere, nothing signed in) or agents can't run (out of usage). Fine
 * is no dot: a green one said nothing anyone could read.
 */
export function glanceStatus(glance: Pick<UsageGlance, 'tone' | 'row'>): FooterRowStatus {
  if (glance.tone === 'limited') return 'down';
  return glance.row.needsYou ? 'warn' : 'off';
}

/**
 * A working line's room as the same pill as everywhere else: out of usage is
 * neutral (it resets by itself), carrying on with the other engine is
 * running. A plain "62% left" stays text.
 */
export function rowPill(line: WorkingLine): StatusTone | null {
  if (line.away) return 'running';
  if (line.tone === 'out') return 'out';
  return null;
}

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

/** Agents set to one account, by `engine:id`, for "Riley runs only on this one". */
export function pinsOf(agents: Agent[]) {
  return agents
    .filter((a) => a.account)
    .map((a) => ({ engine: a.engine, account: a.account as string, name: a.name }));
}

/** The glance, from what the Mac serves now. */
export function useUsageGlance({ look }: { look: boolean }) {
  const { accounts, attempt, remove, reload } = useUsageAccounts();
  const engines = useAgentsSelector(selectEngines);
  const agents = useAgentsSelector(selectAgents);
  const { inventory, now, reload: reloadInventory } = useUsageInventory({ glance: !look });
  const all = useMemo(() => accounts ?? [], [accounts]);
  const glance = useMemo(
    () =>
      usageGlance(all, inventory, {
        now,
        engines: shownEngines(engines, agents, all),
        pins: pinsOf(agents),
      }),
    [all, inventory, now, engines, agents]
  );
  return {
    accounts,
    all,
    glance,
    inventory,
    now,
    engines,
    agents,
    attempt,
    remove,
    reload: () => {
      reload();
      reloadInventory();
    },
  };
}

export function AccountSwitcher({
  collapsed,
  open = false,
  onOpen,
}: {
  collapsed: boolean;
  /** The Usage view is what's showing. */
  open?: boolean;
  /** Show the Usage view. */
  onOpen?: () => void;
}) {
  const { accounts, glance } = useUsageGlance({ look: false });

  useEffect(
    () =>
      onSwitcherRequest((what) => {
        if (what === 'add') requestUsageAdd();
        onOpen?.();
      }),
    [onOpen]
  );

  if (!accounts || glance.keys.length === 0) return null;
  const { row: words } = glance;
  const label = `Usage: ${[words.figure, words.refill, words.count].filter(Boolean).join('. ')}`;

  const row = (
    <Button
      variant="ghost"
      width="fill"
      className={`remote-indicator account-switcher__row usage-glance${
        collapsed ? ' remote-indicator--compact' : ''
      }`}
      aria-label={`${label}. Show usage and accounts`}
      aria-current={open ? 'page' : undefined}
      data-testid="account-switcher"
      data-needs-you={words.needsYou || undefined}
      onClick={() => onOpen?.()}
      leftIcon={<FooterRowIcon icon={<ActivityIcon size={14} />} status={glanceStatus(glance)} />}
    >
      {!collapsed && (
        <span className="usage-glance__body">
          <span className="usage-glance__top">
            <span className="usage-glance__label">Usage</span>
            {words.count && <span className="usage-glance__refill">{words.count}</span>}
          </span>
          <span className="usage-glance__headline">{words.figure}</span>
          {glance.meterKeys.length > 0 && <StackMeter keys={glance.meterKeys} size="small" paced />}
          {words.refill && <span className="usage-glance__summary">{words.refill}</span>}
        </span>
      )}
    </Button>
  );
  return <Tooltip content={collapsed ? label : 'Show usage and accounts'}>{row}</Tooltip>;
}

/**
 * The chat header's chip: the account this agent's last turn ran on, once
 * its engine has more than one (the Mac sends `ranOn` only then). Opens
 * Usage. "only" when it is set to run on that one.
 */
export function AgentAccountChip({ agent }: { agent: Agent }) {
  if (!agent.ranOn) return null;
  const only = agent.account === agent.ranOn.id;
  // As its key is named in Usage: never "This Mac".
  const name = ranOnName(agent);
  const Icon = ENGINE_ICON[agent.engine];
  const tip = only
    ? `${agent.name} runs only on ${name}. Change it in Runs on, in the … menu.`
    : `${agent.name}’s last turn ran on ${name}. Show usage`;
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
        {name}
        {only && <span className="agent-chat__project-copy">· only</span>}
      </Button>
    </Tooltip>
  );
}
