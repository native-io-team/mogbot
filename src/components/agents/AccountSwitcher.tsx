/**
 * Usage at a glance, always in sight: the row at the foot of the Agents
 * sidebar, answering "how much can my agents still do, and when does it
 * refill" in words anyone reads, said as what is USED (`glanceUsed`): "8%
 * used · refills in 6d" over one bar that fills with use, so a short fill is
 * light use and a full bar is out ("92% left" beside a nearly full bar read
 * as 92% used). The warning role from 80% used; never accent. The whole
 * sentence (of what, how many accounts, any not read, the exact refill) is
 * the tooltip and the VoiceOver label. A status dot only when the user must
 * act, or agents are out. First in the sidebar's foot. It opens the
 * Usage view (`AgentsUsageView`), where every account is a key in order.
 *
 * Words and figures are the phone's too (`companion-protocol/usageGlance`
 * `row`): only what an engine reported; an account nobody has read is an
 * empty, dashed segment, never a full one. Before anything was read (a
 * first run) the row is the word "Usage" alone: no "Not read yet", no empty
 * bar, nothing that asks to be looked at before an agent has run. This row
 * never asks for a reading itself (`glance`); opening the view does.
 *
 * ⌘K "Usage and accounts…", "Switch account…" and "Add an account…" open
 * the view (`requestSwitcher`), as does the chat header's account chip.
 *
 * @module components/agents/AccountSwitcher
 */

import { useEffect, useMemo } from 'react';
import { ActivityIcon, ClaudeIcon, CodexIcon, OpencodeIcon } from '@/components/icons';
import { Button } from '../primitives/Button';
import { Tooltip } from '../primitives/Tooltip';
import { FooterRowIcon, type FooterRowStatus } from '../workspace/FooterRowIcon';
import { useUsageAccounts } from './useUsageAccounts';
import { useUsageInventory } from './AgentsUsage';
import { UsedBar } from './UsageStack';
import { useAgentsSelector } from '../../lib/agentsStore';
import type { Agent, AgentEngine, EngineInfo } from '../../lib/agents';
import {
  onSwitcherRequest,
  requestUsageAccount,
  requestUsageAdd,
  type UsageAccount,
} from '../../lib/agentAccounts';
import { usageGlance, type UsageGlance } from '../../lib/agentsUsage';
import { HOST_COMPUTER } from '../../lib/computer';
import { glanceUsed } from '../../../packages/companion-protocol/src/usageGlance';
import {
  ranOnName,
  type WorkingLine,
} from '../../../packages/companion-protocol/src/accountSwitcher';
import type { StatusTone } from '../primitives/StatusPill';

const ENGINE_ICON: Record<AgentEngine, typeof ClaudeIcon> = {
  claude: ClaudeIcon,
  codex: CodexIcon,
  opencode: OpencodeIcon,
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
 * running. A plain "38% used" stays text.
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
        computer: HOST_COMPUTER,
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
  // Signed in, nothing read yet, nothing to do: calm, the label alone.
  const quiet = glance.unread && !words.needsYou;
  // Said as what is used, its bar filling with use (`glanceUsed`).
  const used = glanceUsed(glance);
  const label = `Usage: ${used.detail}`;

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
      data-quiet={quiet || undefined}
      data-tone={used.tone}
      onClick={() => onOpen?.()}
      leftIcon={<FooterRowIcon icon={<ActivityIcon size={14} />} status={glanceStatus(glance)} />}
    >
      {!collapsed && quiet && (
        <span className="usage-glance__body">
          <span className="usage-glance__label">Usage</span>
        </span>
      )}
      {!collapsed && !quiet && (
        <span className="usage-glance__body">
          {/* "8% used · refills in 6d": the figure, then when it refills. */}
          <span className="usage-glance__headline">
            <span className="usage-glance__figure">{used.figure}</span>
            {used.refill && <span className="usage-glance__count"> · {used.refill}</span>}
          </span>
          <UsedBar used={used} />
        </span>
      )}
    </Button>
  );
  return <Tooltip content={label}>{row}</Tooltip>;
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
  const name = ranOnName(agent, HOST_COMPUTER);
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
        onClick={() => {
          if (agent.ranOn) requestUsageAccount(agent.engine, agent.ranOn.id);
        }}
        aria-label={tip}
        data-testid="agent-account-chip"
      >
        {/* A short label: an email's name part. The whole of it is in the
            tooltip and the label, so the header band never carries it. */}
        <span className="agent-chat__account-name">{shortAccountLabel(name)}</span>
        {only && <span className="agent-chat__project-copy">· only</span>}
      </Button>
    </Tooltip>
  );
}

/** An account's label for a chip: an email's name part, anything else as it is. */
export function shortAccountLabel(name: string): string {
  const at = name.indexOf('@');
  return at > 0 ? name.slice(0, at) : name;
}
