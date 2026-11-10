/**
 * Usage, from the agent chat's header: a small ring (what is used of the
 * current 5-hour window, as the engine reported it) that opens a popover:
 * this agent's context (only when its engine reported it), then the whole
 * stack of accounts as the Usage view's hero says it (`totalWords`: the
 * total used and across what, the one bar, the next refill), and a way
 * into the Usage view. One rendering of usage, so
 * the popover, the sidebar, Settings and the phone never disagree, and
 * every limit is said as what is used.
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
import { ActivityIcon, ChevronRightIcon } from '@/components/icons';
import type { Agent } from '../../lib/agents';
import { contextMeter, ringPercent, totalWords } from '../../lib/agentsUsage';
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
  // Said, and drawn, as what is used: the same as every other usage figure.
  const used = ring ? ring.percent : null;
  const label =
    used !== null ? `Usage: ${used}% of the 5-hour limit used` : 'Usage: no 5-hour reading yet';
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
                style={{ '--agent-usage-ring-percent': used ?? 0 } as CSSProperties}
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
  const words = totalWords(glance);
  // "across 2 Max accounts" → "2 Max accounts"; "this week" → "This week".
  const across = words.across ? words.across.replace(/^across /, '') : null;
  const tone = glance.tone === 'calm' ? glance.total.tone : glance.tone;

  return (
    <div className="agent-usage__body">
      <p className="agent-usage__title">Usage</p>
      {context && (
        <Section title="Conversation length">
          <MeterHead
            name={`${agent.name}’s conversation`}
            figure={context.label}
            tone={context.tone}
          />
          <div
            className="agent-usage__bar"
            data-tone={context.tone}
            role="meter"
            aria-label={`${agent.name}’s conversation`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={context.percent}
          >
            <span
              className="agent-usage__fill"
              style={{ '--agent-usage-fill': `${context.percent}%` } as CSSProperties}
            />
          </div>
          <span className="agent-usage__muted">{context.detail}</span>
        </Section>
      )}
      {stacked && (
        <Section title={glance.keys.length === 1 ? 'Your account' : 'Your accounts'}>
          {/* The Usage view's hero, small: the same figure and the same refill. */}
          {across ? (
            <MeterHead
              name={across.charAt(0).toUpperCase() + across.slice(1)}
              figure={words.figure}
              tone={tone}
            />
          ) : (
            <p className="agent-usage__headline" data-tone={tone}>
              {words.figure}
            </p>
          )}
          <TotalBar total={glance.total} />
          {words.refill && <span className="agent-usage__muted">{words.refill}</span>}
          {glance.estimate && (
            <span className="agent-usage__muted">
              {glance.headline}. {glance.estimate}: an estimate, not a reading.
            </span>
          )}
          {glance.total.unread && (
            <span className="agent-usage__muted">{glance.total.unread}.</span>
          )}
          <SameNotes notes={glance.sameNotes} />
        </Section>
      )}
      {!context && !stacked && (
        <p className="agent-usage__muted">
          Nothing reported yet. Figures appear once an engine reports them after a turn.
        </p>
      )}
      <div className="agent-usage__foot">
        <Button
          variant="secondary"
          width="fill"
          rightIcon={<ChevronRightIcon size={12} />}
          onClick={() => {
            onClose();
            requestSwitcher('open');
          }}
        >
          Usage and accounts
        </Button>
      </div>
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

/** A meter's first line: what it is at the left, its figure at the right. */
function MeterHead({ name, figure, tone }: { name: string; figure: string; tone: string }) {
  return (
    <div className="agent-usage__meter-head" data-tone={tone}>
      <span className="agent-usage__meter-name">{name}</span>
      <span className="agent-usage__meter-figure">{figure}</span>
    </div>
  );
}
