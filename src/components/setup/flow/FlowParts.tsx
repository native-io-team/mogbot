/**
 * The pieces every onboarding screen is built from: the full-screen frame
 * (Back, the progress bar, one question, one big button), and the check
 * line that says "Done" or "Not done yet — here's the one fix", with a
 * Check again that always answers (never a silent reload).
 *
 * @module components/setup/flow/FlowParts
 */

import { useEffect, useRef, type CSSProperties, type ReactNode } from 'react';
import { openUrl } from '@tauri-apps/plugin-opener';
import { clockFormat } from '../../../../packages/companion-protocol/src/clock';
import { Button } from '../../primitives/Button';
import { Spinner } from '../../primitives/Spinner';
import {
  ArrowLeftIcon,
  CheckIcon,
  ExternalLinkIcon,
  PendingCircleIcon,
  WarningIcon,
} from '@/components/icons';
import {
  DONE,
  FLOW_SECTIONS,
  NOT_DONE,
  WAITING,
  progressOf,
  SECTION_LABEL,
  type CheckResult,
  type FlowStep,
} from '../../../lib/onboardingFlow';

/** How long "Done" stays before the next screen, when it was just done here. */
export const ADVANCE_MS = 1200;

/**
 * What takes focus on a screen, best first: its big button, the first
 * answer when the big button is a choice of cards, the fix a failed check
 * names, then any action but the way out. "Skip for now" never takes focus
 * on its own: Enter on a screen whose only button was Skip skipped the step
 * (the Funnel switch, the pairing code) for someone who meant to go on.
 */
export const FLOW_FOCUS_TARGET = [
  '.flow-actions [data-flow-primary]:not(:disabled)',
  '.flow-content .agent-pick-card:not(:disabled)',
  '.flow-content [data-flow-choice]:not(:disabled)',
  '.flow-content [data-flow-fix]:not(:disabled)',
  '.flow-actions button:not(:disabled):not([data-flow-skip])',
] as const;

interface FlowShellProps {
  step: FlowStep;
  title: ReactNode;
  /** One sentence. */
  lede?: ReactNode;
  children?: ReactNode;
  /** The big button (or the check that replaces it). */
  primary?: ReactNode;
  /** One quiet way out: Use a different one. */
  secondary?: ReactNode;
  onBack?: () => void;
  /** Wider body, for the choice of engines. */
  wide?: boolean;
  /** Above the title: the Chief's key cap on the welcome. */
  mark?: ReactNode;
}

export function FlowShell({
  step,
  title,
  lede,
  children,
  primary,
  secondary,
  onBack,
  wide = false,
  mark,
}: FlowShellProps) {
  const { section, sections, within } = progressOf(step);
  const screen = useRef<HTMLDivElement>(null);
  // Keyboard first: whenever nothing has focus (a new screen, a button that
  // just disappeared, a check that just passed), the screen's one answer
  // takes it, so Enter always means "the big button" and Tab starts there.
  // Never takes focus from something the user is in.
  useEffect(() => {
    const active = document.activeElement;
    // A quiet way out that took focus while the big button was still
    // loading gives it back once the big button is there.
    const skipFocused =
      active instanceof HTMLElement &&
      active.hasAttribute('data-flow-skip') &&
      !!screen.current?.querySelector('.flow-actions [data-flow-primary]:not(:disabled)');
    if (active && active !== document.body && !skipFocused) return;
    for (const target of FLOW_FOCUS_TARGET) {
      const el = screen.current?.querySelector<HTMLElement>(target);
      if (el) {
        el.focus();
        return;
      }
    }
  });
  return (
    <div className="onboarding-screen flow-screen" data-flow-step={step} ref={screen}>
      <header className="flow-top">
        <div className="flow-top__back">
          {onBack && (
            <Button
              variant="ghost"
              size="compact"
              leftIcon={<ArrowLeftIcon size={14} />}
              onClick={onBack}
              data-flow-back
            >
              Back
            </Button>
          )}
        </div>
        <div
          className="flow-progress"
          // One column per section: a fixed count left the bar off-centre, and
          // its label under the last segment, when the line got shorter.
          style={{ '--flow-progress-sections': sections } as CSSProperties}
          role="progressbar"
          aria-label="Setup progress"
          aria-valuemin={1}
          aria-valuemax={sections}
          aria-valuenow={section}
          aria-valuetext={`Step ${section} of ${sections}: ${SECTION_LABEL[FLOW_SECTIONS[section - 1]]}`}
        >
          {FLOW_SECTIONS.map((s, i) => (
            <span
              key={s}
              className="flow-progress__segment"
              data-state={i + 1 < section ? 'done' : i + 1 === section ? 'current' : 'todo'}
              style={
                i + 1 === section
                  ? ({ '--flow-progress-fill': `${Math.round(within * 100)}%` } as CSSProperties)
                  : undefined
              }
            />
          ))}
          <span className="flow-progress__label">{SECTION_LABEL[FLOW_SECTIONS[section - 1]]}</span>
        </div>
        <div className="flow-top__back" aria-hidden />
      </header>
      {/* Keyed by the screen, so each one arrives (the same short rise every
          time) rather than its words swapping in place. Three fixed regions:
          the question at the frame's top, what it needs under it, and the
          answers at its foot, so the title and the big button land in the
          same place on every screen and the eye and cursor never hunt. */}
      <main key={step} className={`flow-body${wide ? ' flow-body--wide' : ''}`}>
        <div className="flow-head">
          {mark && <div className="flow-mark">{mark}</div>}
          <h1 className="flow-title">{title}</h1>
          {lede && <p className="flow-lede">{lede}</p>}
        </div>
        {children && <div className="flow-content">{children}</div>}
        <div className="flow-actions">
          {/* Held open when empty, so a lone Skip sits where Skip always does. */}
          <div className="flow-actions__primary">{primary}</div>
          {secondary && <div className="flow-actions__secondary">{secondary}</div>}
        </div>
      </main>
    </div>
  );
}

interface CheckLineProps {
  result: CheckResult;
  /** Ask again now. Shown on a failed check; the answer always says when it was checked. */
  onCheckAgain?: () => void;
  checking?: boolean;
  checkedAt?: number | null;
  /** What Check again says when it does something more (Try again, Ask Tailscale again). */
  againLabel?: string;
}

const timeOf = (ms: number) =>
  clockFormat({ hour: 'numeric', minute: '2-digit', second: '2-digit' }).format(ms);

/**
 * "Done ✓", "Checking…", "Waiting for you" (the user's move: neutral, a
 * hollow mark, never amber), or "Not done yet" with the one fix and Check
 * again.
 */
export function CheckLine({
  result,
  onCheckAgain,
  checking = false,
  checkedAt,
  againLabel = 'Check again',
}: CheckLineProps) {
  if (checking || result.state === 'checking') {
    return (
      <div className="flow-check" data-state="checking" role="status">
        <Spinner size="sm" />
        <span className="flow-check__line">{checking ? 'Checking…' : result.line}</span>
      </div>
    );
  }
  if (result.state === 'pass') {
    return (
      <div className="flow-check" data-state="pass" role="status">
        <span className="flow-check__mark" aria-hidden>
          <CheckIcon size={14} />
        </span>
        <span className="flow-check__line">
          <strong>{DONE}.</strong> {result.line}
        </span>
      </div>
    );
  }
  const waiting = result.state === 'waiting';
  return (
    <div
      className="flow-check"
      data-state={waiting ? 'waiting' : 'fail'}
      role={waiting ? 'status' : 'alert'}
    >
      <span className="flow-check__mark" aria-hidden>
        {waiting ? <PendingCircleIcon size={14} /> : <WarningIcon size={14} />}
      </span>
      <div className="flow-check__body">
        <span className="flow-check__line">
          <strong>{waiting ? WAITING : NOT_DONE}.</strong> {result.line}
        </span>
        {result.fix && <span className="flow-check__fix">{result.fix}</span>}
        {(result.action || onCheckAgain) && (
          <div className="flow-check__actions">
            {result.action && (
              <Button
                variant="secondary"
                rightIcon={<ExternalLinkIcon size={12} />}
                onClick={() => void openUrl(result.action!.url)}
                data-flow-fix
              >
                {result.action.label}
              </Button>
            )}
            {onCheckAgain && (
              <Button variant="secondary" onClick={onCheckAgain} data-flow-check-again>
                {againLabel}
              </Button>
            )}
          </div>
        )}
        {checkedAt && <span className="flow-check__when">Checked at {timeOf(checkedAt)}</span>}
      </div>
    </div>
  );
}
