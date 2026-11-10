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
import { Button } from '../../primitives/Button';
import { Spinner } from '../../primitives/Spinner';
import { ArrowLeftIcon, CheckIcon, ExternalLinkIcon, WarningIcon } from '@/components/icons';
import {
  DONE,
  FLOW_SECTIONS,
  NOT_DONE,
  progressOf,
  SECTION_LABEL,
  type CheckResult,
  type FlowStep,
} from '../../../lib/onboardingFlow';

/** How long "Done" stays before the next screen, when it was just done here. */
export const ADVANCE_MS = 1200;

/**
 * What takes focus on a screen, best first: its big button, the first
 * answer when the big button is a choice of cards, then any action.
 */
export const FLOW_FOCUS_TARGET = [
  '.flow-actions [data-flow-primary]:not(:disabled)',
  '.flow-content .agent-pick-card:not(:disabled)',
  '.flow-actions button:not(:disabled)',
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
  const { section, sections } = progressOf(step);
  const screen = useRef<HTMLDivElement>(null);
  // Keyboard first: whenever nothing has focus (a new screen, a button that
  // just disappeared, a check that just passed), the screen's one answer
  // takes it, so Enter always means "the big button" and Tab starts there.
  // Never takes focus from something the user is in.
  useEffect(() => {
    const active = document.activeElement;
    if (active && active !== document.body) return;
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
            />
          ))}
          <span className="flow-progress__label">{SECTION_LABEL[FLOW_SECTIONS[section - 1]]}</span>
        </div>
        <div className="flow-top__back" aria-hidden />
      </header>
      <main className={`flow-body${wide ? ' flow-body--wide' : ''}`}>
        {mark && <div className="flow-mark">{mark}</div>}
        <h1 className="flow-title">{title}</h1>
        {lede && <p className="flow-lede">{lede}</p>}
        {children && <div className="flow-content">{children}</div>}
        {(primary || secondary) && (
          <div className="flow-actions">
            {primary}
            {secondary}
          </div>
        )}
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
}

const timeOf = (ms: number) =>
  new Date(ms).toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
  });

/** "Done ✓", "Checking…", or "Not done yet" with the one fix and Check again. */
export function CheckLine({ result, onCheckAgain, checking = false, checkedAt }: CheckLineProps) {
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
  return (
    <div className="flow-check" data-state="fail" role="alert">
      <span className="flow-check__mark" aria-hidden>
        <WarningIcon size={14} />
      </span>
      <div className="flow-check__body">
        <span className="flow-check__line">
          <strong>{NOT_DONE}.</strong> {result.line}
        </span>
        <span className="flow-check__fix">{result.fix}</span>
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
              Check again
            </Button>
          )}
        </div>
        {checkedAt && <span className="flow-check__when">Checked at {timeOf(checkedAt)}</span>}
      </div>
    </div>
  );
}
