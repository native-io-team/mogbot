/**
 * Usage, from the agent chat's header: a small ring (what is left of the
 * current 5-hour window, as the engine reported it) that opens a popover:
 * this agent's context (only when its engine reported it), then the whole
 * stack of accounts as the Usage view says it (`usageGlance`: the headline,
 * the segmented meter with each account named and what it has left, the
 * next reset), and a way into the Usage view. One rendering of usage, so
 * the popover, the sidebar, Settings and the phone never disagree, and
 * every limit is said as what is left.
 *
 * Nothing is filled in: no reading, no section; no 5-hour reading, the
 * control is the word "Usage" rather than a ring that wasn't reported. With
 * nothing read at all (a first run) there is no control: the sidebar's
 * Usage row is the one way in, so the first screen doesn't say it twice.
 * ⌘K still opens the popover (it shows while open).
 *
 * ⌘K "Show usage" opens it.
 *
 * @module components/agents/AgentUsageRing
 */

import type { CSSProperties, ReactNode } from 'react';
import { Dropdown } from '../primitives/Dropdown';
import { Button } from '../primitives/Button';
import { ActivityIcon } from '@/components/icons';
import type { Agent } from '../../lib/agents';
import { contextMeter, ringPercent, type UsageMeter } from '../../lib/agentsUsage';
import { requestSwitcher } from '../../lib/agentAccounts';
import { useQuotas } from './AgentsQuota';
import { useUsageGlance } from './AccountSwitcher';
import { SameNotes, TotalBar } from './UsageStack';

interface AgentUsageRingProps {
  agent: Agent;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function AgentUsageRing({ agent, open, onOpenChange }: AgentUsageRingProps) {
  const { quotas, now } = useQuotas();
  const ring = ringPercent(quotas, agent.engine, now);
  // Said, and drawn, as what is left: the same as every other usage figure.
  const left = ring ? 100 - ring.percent : null;
  const label =
    left !== null ? `Usage: ${left}% of the 5-hour limit left` : 'Usage: no 5-hour reading yet';
  const anything =
    ring !== null || contextMeter(agent.context) !== null || (quotas?.length ?? 0) > 0;
  if (!anything && !open) return null;
  return (
    <Dropdown
      align="right"
      portal
      presentation="popover"
      ariaLabel="Usage"
      open={open}
      onOpenChange={onOpenChange}
      menuClassName="agent-usage"
      trigger={(p) => (
        // One header action like the others: an icon and the word. With no
        // 5-hour reading the icon is a plain gauge, never an empty dashed ring
        // (it read as a spinner); the dial comes with the first reading.
        <Button
          {...p}
          tabIndex={0}
          variant="ghost"
          className="agent-chat__action agent-usage-ring"
          title={label}
          aria-label={label}
          leftIcon={
            ring ? (
              <span
                className="agent-usage-ring__dial"
                data-tone={ring.tone}
                style={{ '--agent-usage-ring-percent': left ?? 0 } as CSSProperties}
                aria-hidden
              />
            ) : (
              <ActivityIcon size={14} />
            )
          }
        >
          <span className="agent-chat__action-word">Usage</span>
        </Button>
      )}
    >
      {open && <UsageBody agent={agent} onClose={() => onOpenChange(false)} />}
    </Dropdown>
  );
}

/** Mounted while open, so the accounts are read when they're looked at. */
function UsageBody({ agent, onClose }: { agent: Agent; onClose: () => void }) {
  const { accounts, glance } = useUsageGlance({ look: true });
  const context = contextMeter(agent.context);
  const stacked = accounts !== null && glance.keys.length > 0;

  return (
    <div className="agent-usage__body">
      <p className="agent-usage__title">Usage</p>
      {context && (
        <Section title="Conversation length">
          <Meter meter={context} title={`${agent.name}’s conversation`} />
        </Section>
      )}
      {stacked && (
        <Section title={glance.keys.length === 1 ? 'Your account' : 'Your accounts'}>
          <p className="agent-usage__headline" data-tone={glance.tone}>
            {glance.headline}
          </p>
          {glance.estimate && (
            <span className="agent-usage__muted">{glance.estimate}. An estimate.</span>
          )}
          {glance.total.left !== null && (
            <span className="agent-usage__muted">
              {glance.total.figure} {glance.total.across}
            </span>
          )}
          <TotalBar total={glance.total} />
          <SameNotes notes={glance.sameNotes} />
          {glance.soonest && (
            <span className="agent-usage__muted">
              Next refill: {glance.soonest.account}’s {glance.soonest.label.toLowerCase()} limit,{' '}
              {glance.soonest.resetsIn} ({glance.soonest.resetsAt})
            </span>
          )}
        </Section>
      )}
      {!context && !stacked && (
        <p className="agent-usage__muted">
          Nothing reported yet. Figures appear once an engine reports them after a turn.
        </p>
      )}
      <Button
        variant="secondary"
        size="compact"
        width="fill"
        onClick={() => {
          onClose();
          requestSwitcher('open');
        }}
      >
        Usage and accounts
      </Button>
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

/** The conversation's context: "32% full", its bar, and how many tokens. */
function Meter({ meter, title }: { meter: UsageMeter; title: string }) {
  return (
    <div className="agent-usage__meter" data-tone={meter.tone}>
      <div className="agent-usage__meter-head">
        <span className="agent-usage__meter-name">{title}</span>
        <span className="agent-usage__meter-figure">{meter.label}</span>
      </div>
      <div
        className="agent-usage__bar"
        role="meter"
        aria-label={title}
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
    </div>
  );
}
