/**
 * The pieces every onboarding screen is built from: the full-screen frame
 * (Back, the progress bar, one question, one big button), and the check
 * line that says "Done" or "Not done yet — here's the one fix", with a
 * Check again that always answers (never a silent reload).
 *
 * @module components/setup/flow/FlowParts
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { openUrl } from '@tauri-apps/plugin-opener';
import { Button } from '../../primitives/Button';
import { Spinner } from '../../primitives/Spinner';
import { ArrowLeftIcon, CheckIcon, ExternalLinkIcon, WarningIcon } from '@/components/icons';
import { usePolling } from '../../../hooks/usePolling';
import { PhoneQr } from '../../phone/PhoneQr';
import { getLinkQr } from '../../../lib/companion';
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

interface FlowShellProps {
  step: FlowStep;
  title: ReactNode;
  /** One sentence. */
  lede?: ReactNode;
  children?: ReactNode;
  /** The big button (or the check that replaces it). */
  primary?: ReactNode;
  /** One quiet way out: Skip, Start fresh, I already have it. */
  secondary?: ReactNode;
  onBack?: () => void;
  /** Wider body, for a terminal or a QR code beside its steps. */
  wide?: boolean;
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
}: FlowShellProps) {
  const { section, sections, sub } = progressOf(step);
  return (
    <div className="onboarding-screen flow-screen" data-flow-step={step}>
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
          role="progressbar"
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
          <span className="flow-progress__label">
            {SECTION_LABEL[FLOW_SECTIONS[section - 1]]}
            {sub && ` · ${sub.index} of ${sub.total}`}
          </span>
        </div>
        <div className="flow-top__back" aria-hidden />
      </header>
      <main className={`flow-body${wide ? ' flow-body--wide' : ''}`}>
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

/**
 * A check that keeps itself current while its screen is open, and a Check
 * again that visibly checks (at least a beat of "Checking…") and always
 * records when. `retry` runs first on Check again (ask Tailscale again).
 */
export function useFlowCheck<T>(
  load: () => Promise<T>,
  {
    intervalMs = 3000,
    retry,
    name,
  }: { intervalMs?: number; retry?: () => Promise<unknown>; name: string }
) {
  const [data, setData] = useState<T | null>(null);
  const [checking, setChecking] = useState(false);
  const [checkedAt, setCheckedAt] = useState<number | null>(null);
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  const refresh = useCallback(async () => {
    try {
      const next = await load();
      if (live.current) setData(next);
      return next;
    } catch {
      return null;
    }
  }, [load]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  usePolling(refresh, { intervalMs, enabled: !checking, name });
  const checkAgain = useCallback(async () => {
    setChecking(true);
    const beat = new Promise((r) => setTimeout(r, 500));
    try {
      if (retry) await retry().catch(() => undefined);
      await Promise.all([refresh(), beat]);
    } finally {
      if (live.current) {
        setChecking(false);
        setCheckedAt(Date.now());
      }
    }
  }, [retry, refresh]);
  return { data, setData, checking, checkedAt, checkAgain, refresh };
}

/**
 * Move on by itself once a check passes, but only when it passed while the
 * screen was open. Arriving at an already-done step (Back, a resumed launch)
 * shows "Done" and waits for Continue, so Back never bounces forward.
 * Returns whether it was already done on arrival.
 */
export function useAdvanceOnPass(
  result: CheckResult,
  onNext: () => void,
  /** The first answer has arrived: what it says decides "already done". */
  loaded: boolean
): boolean {
  const [firstSeen, setFirstSeen] = useState<CheckResult['state'] | null>(null);
  if (firstSeen === null && loaded) setFirstSeen(result.state);
  const doneOnArrival = firstSeen === 'pass';
  const passed = result.state === 'pass';
  const next = useRef(onNext);
  useLayoutEffect(() => {
    next.current = onNext;
  });
  useEffect(() => {
    if (!passed || doneOnArrival || firstSeen === null) return;
    const timer = setTimeout(() => next.current(), ADVANCE_MS);
    return () => clearTimeout(timer);
  }, [passed, doneOnArrival, firstSeen]);
  return doneOnArrival;
}

/** A store page as a QR code, for the phone's camera; the link beside it. */
export function StoreQr({ url, label }: { url: string; label: string }) {
  const [qr, setQr] = useState<{ size: number; modules: string } | null>(null);
  useEffect(() => {
    let live = true;
    getLinkQr(url)
      .then((q) => live && setQr(q))
      .catch(() => live && setQr(null));
    return () => {
      live = false;
    };
  }, [url]);
  return (
    <div className="flow-qr" data-testid="flow-store-qr">
      {qr ? (
        <PhoneQr size={qr.size} modules={qr.modules} pixels={168} label={label} />
      ) : (
        <div className="flow-qr__placeholder" aria-hidden />
      )}
    </div>
  );
}
