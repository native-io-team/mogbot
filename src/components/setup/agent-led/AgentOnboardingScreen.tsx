/**
 * Onboarding: from nothing to talking with the Chief of Staff, as one
 * straight line of one-question screens (`lib/onboardingFlow`).
 *
 * Welcome → the engine (pick, then install and sign in, a screen each) →
 * "Bring your agents from another assistant?" (Remote Access a screen per
 * step, then the import) → "Use your agents from your phone?" (a screen per
 * step, ending on Paired) → the Chief's chat. Only the engine is required;
 * each optional part has "Not now" and "Skip for now", and comes back later
 * as one card in the Chief's chat.
 *
 * Only the engine is required. Everything a project needs is asked for
 * later, when work first becomes a project (`ProjectToolsModal`). The app
 * verifies; nothing self-certifies: every check here is the app's own.
 *
 * The step is saved as it changes, so quitting halfway opens where it
 * stopped (`useAppSetup` sends a launch back here while it's unfinished).
 */

import { useCallback, useEffect, useState } from 'react';
import { Spinner } from '../../primitives/Spinner';
import { CheckLine } from '../flow/FlowParts';
import { EngineStep } from '../flow/EngineStep';
import { WelcomeStep } from '../flow/SimpleSteps';
import { AgentsFlow, type AgentsStep } from '../flow/AgentsFlow';
import { FlowShell } from '../flow/FlowParts';
import { PhoneFlow, Primary, Skip, type PhoneFlowStep } from '../../phone/PhoneFlow';
import type { AgentCardKey } from './AgentPickGrid';
import {
  SetupItem,
  FullSetupStatus,
  getFullSetupStatus,
  setDefaultAgentId,
} from '../../../lib/setup';
import { getOnboardingTestMode, OnboardingTestMode } from '../../../lib/agentOnboarding';
import { isMockFailure } from '../../../lib/installProgress';
import {
  nextStep,
  prevStep,
  skipPart,
  readProgress,
  resumeStep,
  saveProgress,
  type FlowStep,
} from '../../../lib/onboardingFlow';
import { initDefaultAgent } from '../../../lib/agent';
import { withTimeout, TimeoutError } from '../../../lib/withTimeout';
import { trackEvent, setActiveScreen } from '../../../lib/analytics';
import { logger } from '../../../lib/logger';

const SETUP_STATUS_TIMEOUT_MS = 15_000;

// Session-scoped guard mirroring setup_started dedupe (module scope survives
// StrictMode remounts, resets per app process).
let agentSetupStartedFired = false;

/** Agent-config id for a setup pair's binary id (claude → claude-code). */
function agentIdForBinary(binaryId: string): string {
  return binaryId === 'claude' ? 'claude-code' : binaryId;
}

interface AgentOnboardingScreenProps {
  /** Called at the end of the line: the engine is ready, into the Chief's chat. */
  onComplete: () => void | Promise<void>;
}

export function AgentOnboardingScreen({ onComplete }: AgentOnboardingScreenProps) {
  const [step, setStep] = useState<FlowStep | null>(null);
  const [items, setItems] = useState<SetupItem[]>([]);
  // A status check that couldn't run, said the way every other check is:
  // "Not done yet", the one fix, and Check again.
  const [error, setError] = useState<{ line: string; fix?: string } | null>(null);
  const [testMode, setTestMode] = useState<OnboardingTestMode>({
    mock: false,
    forceOnboarding: false,
  });

  const fetchStatus = useCallback(async (): Promise<FullSetupStatus | null> => {
    try {
      const status = await withTimeout(
        getFullSetupStatus(),
        SETUP_STATUS_TIMEOUT_MS,
        'Setup status check'
      );
      setItems(status.items);
      setError(null);
      return status;
    } catch (err) {
      logger.warn('Onboarding: failed to fetch setup status', { error: err });
      setError(
        err instanceof TimeoutError
          ? {
              line: 'Checking this Mac took too long.',
              fix: 'If it keeps happening, quit and reopen the app.',
            }
          : { line: 'Couldn’t check this Mac.' }
      );
      return null;
    }
  }, []);

  const updateItemStatus = useCallback((itemId: string, updates: Partial<SetupItem>) => {
    setItems((prev) => prev.map((item) => (item.id === itemId ? { ...item, ...updates } : item)));
  }, []);

  const go = useCallback((next: FlowStep | null) => {
    if (!next) return;
    saveProgress(next);
    setStep(next);
  }, []);

  useEffect(() => {
    if (step) setActiveScreen(`Onboarding - ${step}`);
  }, [step]);

  // First load: test mode and status, then where to open.
  useEffect(() => {
    const init = async () => {
      const mode = await getOnboardingTestMode().catch(() => ({
        mock: false,
        forceOnboarding: false,
      }));
      setTestMode(mode);
      await fetchStatus();
      if (!agentSetupStartedFired) {
        agentSetupStartedFired = true;
        void trackEvent('setup_started', { entry_path: 'agent_led', entry_step: null });
      }
      setStep(resumeStep(readProgress()));
    };
    void init();
  }, [fetchStatus]);

  /** The end of the line: saved as finished, then off to the Chief's chat. */
  const finish = useCallback(async () => {
    saveProgress('engine', true);
    await onComplete();
  }, [onComplete]);

  /** The engine is installed and signed in: make it the default, then the Chief's chat. */
  const engineReady = useCallback(
    async (key: AgentCardKey) => {
      const agentId = agentIdForBinary(key);
      await setDefaultAgentId(agentId);
      initDefaultAgent(agentId);
      void trackEvent('onboarding_completed', {
        agents: [agentId],
        entry_path: 'agent_led',
        $screen_name: 'Onboarding',
      });
      // Everything after the engine happens in the Chief's chat.
      await finish();
    },
    [finish]
  );

  /** "Not now" / "Skip for now": the next part, or the Chief's chat after the last. */
  const skip = useCallback(
    (from: FlowStep) => {
      const next = skipPart(from);
      if (next) go(next);
      else void finish();
    },
    [go, finish]
  );

  if (!step) {
    return (
      <div className="onboarding-screen onboarding-loading">
        <Spinner size="lg" style={{ color: 'var(--text-muted)' }} />
        <p>Getting things ready…</p>
      </div>
    );
  }

  const back = () => go(prevStep(step));
  const screen =
    step === 'welcome' ? (
      <WelcomeStep onNext={() => go(nextStep(step))} />
    ) : step.startsWith('agents') ? (
      <AgentsFlow step={step as AgentsStep} go={go} onSkip={() => skip(step)} onBack={back} />
    ) : step === 'phoneAsk' ? (
      <FlowShell
        step={step}
        onBack={back}
        title="Use your agents from your phone?"
        lede="Chat, answer and approve from anywhere. Your phone talks only to this Mac, through Tailscale on both. About five minutes."
        primary={<Primary onClick={() => go('phoneGetApp')}>Set up my phone</Primary>}
        secondary={<Skip onSkip={() => skip(step)} label="Not now" />}
      />
    ) : step !== 'engine' ? (
      <PhoneFlow
        step={step as PhoneFlowStep}
        go={go}
        onSkip={() => void finish()}
        onDone={() => void finish()}
        doneLabel="Go to your Chief of Staff"
        render={(s, view) => (
          <FlowShell
            step={s}
            onBack={s === 'phonePaired' ? undefined : () => go(prevStep(s) ?? 'phoneAsk')}
            mark={view.mark}
            title={view.title}
            lede={view.lede}
            primary={view.primary}
            secondary={view.secondary}
          >
            {view.children}
          </FlowShell>
        )}
      />
    ) : (
      <EngineStep
        items={items}
        fetchStatus={fetchStatus}
        updateItemStatus={updateItemStatus}
        mock={testMode.mock}
        mockFailure={
          testMode.mock && isMockFailure(testMode.mockFailure) ? testMode.mockFailure : null
        }
        forcePick={testMode.forceOnboarding}
        onEngineReady={engineReady}
        onBack={() => go(prevStep(step))}
      />
    );

  return (
    <>
      {error && (
        <div className="flow-error">
          <CheckLine result={{ state: 'fail', ...error }} onCheckAgain={() => void fetchStatus()} />
        </div>
      )}
      {screen}
    </>
  );
}
