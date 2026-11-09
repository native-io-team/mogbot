/**
 * Usage, from the agent chat's header: a small ring (the current 5-hour
 * window, as the engine reported it) that opens a popover with what the
 * phone's Usage sheet shows: this agent's context (only when its engine
 * reported it), the 5-hour and weekly limits of the account its turns run
 * on, every other account the wallet knows with its own limits (each
 * reading once, never the top account again), and under a limit the Mac's pace line
 * when it has one ("At this pace you'll hit the limit this afternoon, before
 * it resets at 4:00 PM"), always with what that estimate rests on.
 *
 * The figures and words are the phone's (`companion-protocol/usageSheet.ts`):
 * one source, so the two never disagree. Nothing is filled in: no reading,
 * no section; no 5-hour reading, the control is the word "Usage" rather than
 * a 0% ring that wasn't reported.
 *
 * ⌘K "Show usage" opens it.
 *
 * @module components/agents/AgentUsageRing
 */

import type { CSSProperties, ReactNode } from 'react';
import { Dropdown } from '../primitives/Dropdown';
import { Button } from '../primitives/Button';
import { IconButton } from '../primitives/IconButton';
import { ENGINE_LABEL, type Agent, type Quota } from '../../lib/agents';
import {
  computeView,
  contextMeter,
  ringPercent,
  usageSheet,
  type AccountBlock,
  type UsageMeter,
} from '../../lib/agentsUsage';
import { ComputeTotal } from './AgentsCompute';
import { useQuotas } from './AgentsQuota';
import { useUsageInventory } from './AgentsUsage';

interface AgentUsageRingProps {
  agent: Agent;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function AgentUsageRing({ agent, open, onOpenChange }: AgentUsageRingProps) {
  const { quotas, now } = useQuotas();
  const ring = ringPercent(quotas, agent.engine, now);
  const label = ring
    ? `Usage: ${ring.percent}% of the 5-hour limit`
    : 'Usage: no 5-hour reading yet';
  return (
    <Dropdown
      align="right"
      portal
      presentation="popover"
      ariaLabel="Usage"
      open={open}
      onOpenChange={onOpenChange}
      menuClassName="agent-usage"
      trigger={(p) =>
        // No 5-hour reading yet: the word, not an empty dashed ring (it read
        // as a spinner). The ring comes back with the first reading.
        !ring ? (
          <Button
            {...p}
            tabIndex={0}
            variant="ghost"
            className="agent-usage-ring agent-usage-ring--word"
            title={label}
            aria-label={label}
          >
            Usage
          </Button>
        ) : (
          <IconButton
            {...p}
            tabIndex={0}
            variant="ghost"
            className="agent-usage-ring"
            title={label}
            aria-label={label}
            icon={
              <span
                className="agent-usage-ring__dial"
                data-tone={ring?.tone}
                data-empty={ring ? undefined : true}
                style={{ '--agent-usage-ring-percent': ring?.percent ?? 0 } as CSSProperties}
                aria-hidden
              />
            }
          />
        )
      }
    >
      {open && <UsageBody agent={agent} quotas={quotas} quotasNow={now} />}
    </Dropdown>
  );
}

/** Mounted while open, so the inventory is read when it's looked at. */
function UsageBody({
  agent,
  quotas,
  quotasNow,
}: {
  agent: Agent;
  quotas: Quota[] | null;
  quotasNow: number;
}) {
  const { inventory, now } = useUsageInventory();
  const at = Math.max(now, quotasNow);
  const context = contextMeter(agent.context);
  const total = computeView(inventory, at);
  const { active, others } = usageSheet(quotas, agent.engine, inventory, at);
  const nothing = !context && !active && others.length === 0;

  // Every account at once, each reading once: the account turns run on next
  // is marked in the list rather than drawn again above it.
  if (total) {
    return (
      <div className="agent-usage__body">
        <p className="agent-usage__title">Usage</p>
        {context && (
          <Section title="Context">
            <Meter meter={context} title={`${agent.name}’s conversation`} />
          </Section>
        )}
        <Section title="All accounts">
          <ComputeTotal view={total} />
        </Section>
        <p className="agent-usage__muted">
          As each account last reported it. Use of the same plan anywhere else counts too.
        </p>
      </div>
    );
  }

  return (
    <div className="agent-usage__body">
      <p className="agent-usage__title">Usage</p>
      {context && (
        <Section title="Context">
          <Meter meter={context} title={`${agent.name}’s conversation`} />
        </Section>
      )}
      {active && (
        <Section title={`Plan usage · ${ENGINE_LABEL[agent.engine]}`}>
          {active.account && <span className="agent-usage__muted">{active.account}</span>}
          {active.state && (
            <span className="agent-usage__state" data-tone={active.tone}>
              {active.state}
            </span>
          )}
          {active.meters.map((m) => (
            <Meter key={m.key} meter={m} />
          ))}
        </Section>
      )}
      {others.length > 0 && (
        <Section title={active ? 'Other accounts' : 'Accounts'}>
          {others.map((a) => (
            <Account key={a.key} account={a} />
          ))}
        </Section>
      )}
      <p className="agent-usage__muted">
        {nothing
          ? 'Nothing reported yet. Figures appear once an engine reports them after a turn.'
          : 'As each engine last reported it. Use of the same plan anywhere else counts too.'}
      </p>
    </div>
  );
}

function Account({ account: a }: { account: AccountBlock }) {
  return (
    <div className="agent-usage__account">
      <div className="agent-usage__account-head">
        <span className="agent-usage__account-name">{a.title}</span>
        {a.tags.length > 0 && <span className="agent-usage__muted">{a.tags.join(' · ')}</span>}
      </div>
      {a.state && (
        <span className="agent-usage__state" data-tone={a.tone}>
          {a.state}
        </span>
      )}
      {a.meters.map((m) => (
        <Meter key={m.key} meter={m} />
      ))}
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="agent-usage__section" aria-label={title}>
      <h4 className="agent-usage__heading">{title}</h4>
      {children}
    </section>
  );
}

/** "5-hour limit  38%", its bar, "Resets at 3:20 PM", and the pace line when there is one. */
function Meter({ meter, title }: { meter: UsageMeter; title?: string }) {
  return (
    <div className="agent-usage__meter" data-tone={meter.tone}>
      <div className="agent-usage__meter-head">
        <span className="agent-usage__meter-name">{title ?? meter.label}</span>
        <span className="agent-usage__meter-figure">
          {title ? meter.label : `${meter.percent}%`}
        </span>
      </div>
      <div
        className="agent-usage__bar"
        role="meter"
        aria-label={title ?? meter.label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={meter.percent}
      >
        <span
          className="agent-usage__fill"
          style={{ '--agent-usage-fill': `${meter.percent}%` } as CSSProperties}
        />
      </div>
      <span className="agent-usage__muted">{meter.detail}</span>
      {meter.pace && (
        <span className="agent-usage__pace">
          <span className="agent-usage__pace-text">{meter.pace.text}</span>
          <span className="agent-usage__muted">{meter.pace.basis}</span>
        </span>
      )}
    </div>
  );
}
