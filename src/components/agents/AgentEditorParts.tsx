/**
 * The parts Edit agent and New agent are made of, in the Settings kit
 * (`AgentSettingsRows`): the sheet's own bar (Cancel · title · Done, or
 * "‹ Edit agent" on a page that opened in place), the contact card (its key
 * big, its name, "Change look · on Claude Code · Steady"), a row that opens a
 * page, a row with a menu, a text field set into a row, and the Usage tab.
 *
 * @module components/agents/AgentEditorParts
 */

import { Fragment, useState, type ReactNode } from 'react';
import { CheckIcon, ChevronIcon, ChevronRightIcon, ErrorIcon } from '@/components/icons';
import { Button } from '../primitives/Button';
import { TextButton } from '../primitives/TextButton';
import { Dropdown, DropdownItem } from '../primitives/Dropdown';
import { MenuButton } from '../primitives/MenuButton';
import { Group, Row } from './AgentSettingsRows';
import { useQuotaLines } from './AgentsQuota';
import {
  COST_BASIS_NOTE,
  ENGINE_LABEL,
  SCOPE_KIND_LABEL,
  formatContext,
  formatUsage,
  onClaudePlan,
  revokePermission,
  routineWeekLine,
  sumTotals,
  type Agent,
  type PermissionRule,
  type UsageSummary,
  type UsageTotals,
} from '../../lib/agents';
import { asCommandError, formatCommandError } from '../../lib/errors';

/** The sheet's bar: Cancel and the answer either side of the title, as iOS. */
export function SheetBar({
  title,
  onCancel,
  onBack,
  backLabel,
  done,
}: {
  title: string;
  onCancel?: () => void;
  /** On a page opened in place: back to the sheet instead of Cancel. */
  onBack?: () => void;
  backLabel?: string;
  /** The answer (Done / Create), or nothing on a page opened in place. */
  done?: ReactNode;
}) {
  return (
    <div className="agent-sheet__bar">
      <div className="agent-sheet__bar-side">
        {onBack ? (
          <TextButton
            tabIndex={0}
            className="agent-sheet__back"
            leftIcon={<ChevronRightIcon size={12} className="agent-sheet__back-chevron" />}
            onClick={onBack}
          >
            {backLabel}
          </TextButton>
        ) : (
          onCancel && (
            <TextButton tabIndex={0} className="agent-sheet__cancel" onClick={onCancel}>
              Cancel
            </TextButton>
          )
        )}
      </div>
      <h2 className="agent-sheet__title">{title}</h2>
      <div className="agent-sheet__bar-side agent-sheet__bar-side--end">{done}</div>
    </div>
  );
}

/** A row that opens a page in place: its value, then a chevron. */
export function NavRow({
  label,
  value,
  description,
  onOpen,
}: {
  label: string;
  value?: ReactNode;
  description?: ReactNode;
  onOpen: () => void;
}) {
  return (
    <button type="button" className="settings-row agent-sheet__nav-row" onClick={onOpen}>
      <span className="settings-row-info">
        <span className="settings-row-label">{label}</span>
        {description != null && <span className="settings-row-description">{description}</span>}
      </span>
      {value != null && value !== '' && <span className="agent-sheet__value">{value}</span>}
      <ChevronRightIcon size={12} className="agent-sheet__chevron" />
    </button>
  );
}

/** A row whose value is picked from a short menu (engine, model). */
export function MenuRow<T extends string>({
  label,
  value,
  choices,
  onChange,
  description,
}: {
  label: string;
  value: T;
  choices: readonly { value: T; label: string; detail?: string; disabled?: boolean }[];
  onChange: (value: T) => void;
  description?: ReactNode;
}) {
  const current = choices.find((c) => c.value === value) ?? choices[0];
  return (
    <Row label={label} description={description}>
      <Dropdown
        align="right"
        menuClassName="agent-defaults-menu"
        trigger={(props) => (
          <MenuButton
            variant="ghost"
            className="agent-sheet__menu"
            aria-label={`${label}: ${current?.label ?? ''}`}
            expanded={props['aria-expanded']}
            {...props}
          >
            <span className="agent-sheet__value">{current?.label}</span>
            <ChevronIcon
              size={10}
              className={props['aria-expanded'] ? 'chevron-flipped' : undefined}
            />
          </MenuButton>
        )}
      >
        {choices.map((c) => {
          const on = c.value === current?.value;
          return (
            <DropdownItem
              key={c.value || 'default'}
              active={on}
              disabled={c.disabled}
              icon={
                <span className="agent-defaults-menu__check" aria-hidden="true">
                  {on && <CheckIcon size={14} />}
                </span>
              }
              onSelect={() => onChange(c.value)}
            >
              <span className="agent-defaults-menu__label">{c.label}</span>
              {c.detail && <span className="agent-defaults-menu__detail">{c.detail}</span>}
            </DropdownItem>
          );
        })}
      </Dropdown>
    </Row>
  );
}

/** A text field set into a row: the label left, the words right, no box. */
export function FieldRow({
  label,
  value,
  onChange,
  placeholder,
  disabled,
  autoFocus,
  maxLength,
  ariaLabel,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  autoFocus?: boolean;
  maxLength?: number;
  ariaLabel?: string;
}) {
  return (
    <label className="settings-row agent-sheet__field-row">
      <span className="settings-row-label">{label}</span>
      <input
        className="agent-sheet__field"
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        autoFocus={autoFocus}
        maxLength={maxLength}
        aria-label={ariaLabel ?? label}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}

/** A page's own card: a component that isn't rows, on the card surface. */
export function SheetCard({ children }: { children: ReactNode }) {
  return <div className="agent-sheet__card">{children}</div>;
}

/** The red row at the foot of the sheet. */
export function DeleteRow({ label, onDelete }: { label: string; onDelete: () => void }) {
  return (
    <Button variant="ghost" width="fill" className="agent-sheet__delete" onClick={onDelete}>
      {label}
    </Button>
  );
}

/**
 * The Usage tab: this week and all time as its engine reported them, then
 * how full its conversation is, only when the engine said. Nothing invented
 * before a turn has run.
 */
export function UsagePage({ usage, agent }: { usage: UsageSummary | null; agent: Agent }) {
  // On a Claude plan a dollar figure is a list price, not the bill: tokens instead.
  const onPlan = onClaudePlan(useQuotaLines());
  const week = usage && formatUsage(usage.week, onPlan);
  const allTime = usage && formatUsage(usage.allTime, onPlan);
  const routines = routineWeekLine(sumTotals((usage?.routines ?? []).map((r) => r.week)), onPlan);
  const context = formatContext(agent);
  const priced = (t: UsageTotals | undefined) =>
    !onPlan && t && t.pricedTurns + (t.pricedChecks ?? 0) > 0 ? COST_BASIS_NOTE : undefined;
  if (!allTime && !context) {
    return (
      <p className="agent-sheet__empty">
        Nothing yet. What {agent.name} uses shows here after its first reply, as{' '}
        {ENGINE_LABEL[agent.engine]} reports it.
      </p>
    );
  }
  const note = priced(usage?.week) ?? priced(usage?.allTime);
  return (
    <div className="agent-sheet__groups">
      {allTime && (
        <Group id="agent-usage" title="Usage" footnote={note}>
          <Row label="This week">
            <span className="agent-sheet__value agent-sheet__value--wrap">
              {week ?? 'Nothing run yet'}
            </span>
          </Row>
          {routines && (
            <Row label="Its routines">
              <span className="agent-sheet__value agent-sheet__value--wrap">{routines}</span>
            </Row>
          )}
          <Row label="All time">
            <span className="agent-sheet__value agent-sheet__value--wrap">{allTime}</span>
          </Row>
        </Group>
      )}
      {context && (
        <Group id="agent-context" title="This conversation">
          <Row label="Conversation">
            <span className="agent-sheet__value agent-sheet__value--wrap">{context}</span>
          </Row>
        </Group>
      )}
    </div>
  );
}

/**
 * What it can use, as its engine listed it for its last turn
 * (`agents/capabilities.rs`). Nothing is claimed before a turn has said.
 */
export function CanDo({ agent }: { agent: Agent }) {
  const lines = agent.capabilities?.lines ?? [];
  return (
    <Group
      id="agent-can-do"
      title={`What ${agent.name} can do`}
      footnote={
        lines.length === 0
          ? `Shown after its first reply, from what ${ENGINE_LABEL[agent.engine]} says it can use.`
          : undefined
      }
    >
      {lines.length === 0 ? (
        <Row label="Not known yet" />
      ) : (
        lines.map((line) => (
          <Fragment key={line.what}>
            <Row label={line.what} description={line.detail} />
          </Fragment>
        ))
      )}
    </Group>
  );
}

/**
 * What this agent may do without asking, each with Revoke. Revoking is
 * immediate, not part of Done: it's a permission, not a draft.
 */
export function Permissions({ agent }: { agent: Agent }) {
  const [rules, setRules] = useState<PermissionRule[]>(agent.permissions ?? []);
  const [error, setError] = useState<string | null>(null);
  const revoke = async (rule: PermissionRule) => {
    setError(null);
    try {
      await revokePermission(agent.id, rule.id);
      setRules((list) => list.filter((r) => r.id !== rule.id));
    } catch (err) {
      setError(formatCommandError(asCommandError(err)));
    }
  };
  return (
    <Group
      id="agent-permissions"
      title="Always allowed"
      footnote={
        error ? (
          <span className="agent-editor__error" role="alert">
            <ErrorIcon size={12} className="inline-error-icon" />
            {error}
          </span>
        ) : (
          'Choose “Always allow” on a request in the chat to add one. Revoke takes it back at once.'
        )
      }
    >
      {rules.length === 0 ? (
        <Row label="Nothing is always allowed" />
      ) : (
        rules.map((rule) => (
          <Row
            key={rule.id}
            label={
              <>
                {SCOPE_KIND_LABEL[rule.kind] && `${SCOPE_KIND_LABEL[rule.kind]} `}
                {rule.kind.startsWith('command') ? <code>{rule.label}</code> : rule.label}
              </>
            }
          >
            <TextButton tabIndex={0} onClick={() => void revoke(rule)}>
              Revoke
            </TextButton>
          </Row>
        ))
      )}
    </Group>
  );
}
