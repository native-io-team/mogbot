/**
 * Onboarding: from nothing to talking with the Chief of Staff, as one
 * straight line of one-question screens (`lib/onboardingFlow`).
 *
 * Welcome → the engine (pick, then install and sign in, a screen each) →
 * how independent agents are → your phone (optional: Tailscale here,
 * Tailscale there, the app, scan and Allow) → "You're ready: bring your
 * agents, or start fresh?" The import is its own short line off the end.
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
import { Button } from '../../primitives/Button';
import { EngineStep, engineName } from '../flow/EngineStep';
import { IndependenceStep, ReadyStep, WelcomeStep } from '../flow/SimpleSteps';
import {
  PhoneAppStep,
  PhoneIntroStep,
  PhonePairStep,
  TailscaleMacStep,
  TailscalePhoneStep,
} from '../flow/PhoneSteps';
import { ImportConnectStep, ImportRemoteStep, ImportStartStep } from '../flow/ImportSteps';
import type { AgentCardKey } from './AgentPickGrid';
import {
  SetupItem,
  FullSetupStatus,
  getFullSetupStatus,
  setDefaultAgentId,
} from '../../../lib/setup';
import {
  getOnboardingTestMode,
  readyAgentsEngine,
  OnboardingTestMode,
} from '../../../lib/agentOnboarding';
import {
  nextStep,
  prevStep,
  readProgress,
  resumeStep,
  saveProgress,
  skipPhone,
  type FlowStep,
} from '../../../lib/onboardingFlow';
import { setImportChoice } from '../../../lib/agents';
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
  /** Called at the end of the line: Start fresh, or into the Chief's chat. */
  onComplete: () => void | Promise<void>;
}

export function AgentOnboardingScreen({ onComplete }: AgentOnboardingScreenProps) {
  const [step, setStep] = useState<FlowStep | null>(null);
  const [items, setItems] = useState<SetupItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [chosen, setChosen] = useState<AgentCardKey | null>(null);
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
          ? 'Checking this Mac took too long. Try again, and if it keeps happening, quit and reopen the app.'
          : 'Couldn’t check this Mac. Try again.'
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
      const status = await fetchStatus();
      if (!agentSetupStartedFired) {
        agentSetupStartedFired = true;
        void trackEvent('setup_started', { entry_path: 'agent_led', entry_step: null });
      }
      const ready = status ? readyAgentsEngine(status.items) : null;
      if (ready) setChosen(ready);
      setStep(resumeStep(readProgress(), ready !== null));
    };
    void init();
  }, [fetchStatus]);

  /** The engine is installed and signed in: make it the default and go on. */
  const engineReady = useCallback(
    async (key: AgentCardKey) => {
      const agentId = agentIdForBinary(key);
      await setDefaultAgentId(agentId);
      initDefaultAgent(agentId);
      setChosen(key);
      void trackEvent('onboarding_completed', {
        agents: [agentId],
        entry_path: 'agent_led',
        $screen_name: 'Onboarding',
      });
      go(nextStep('engine'));
    },
    [go]
  );

  /** The end of the line: saved as finished, then off to Agents. */
  const finish = useCallback(async () => {
    saveProgress('ready', true);
    await onComplete();
  }, [onComplete]);

  const startFresh = useCallback(async () => {
    await setImportChoice('declined').catch((e: unknown) =>
      logger.warn('Could not save the import choice', { error: String(e) })
    );
    await finish();
  }, [finish]);

  if (!step) {
    return (
      <div className="onboarding-screen onboarding-loading">
        <Spinner size="lg" style={{ color: 'var(--text-muted)' }} />
        <p>Getting things ready…</p>
      </div>
    );
  }

  const back = () => go(prevStep(step));
  const forward = () => go(nextStep(step));
  const skip = () => go(skipPhone());
  const phone = { onNext: forward, onBack: back, onSkip: skip };
  const importing = { onNext: forward, onBack: back, onStartFresh: () => void startFresh() };

  const screen = (() => {
    switch (step) {
      case 'welcome':
        return <WelcomeStep onNext={forward} />;
      case 'engine':
        return (
          <EngineStep
            items={items}
            fetchStatus={fetchStatus}
            updateItemStatus={updateItemStatus}
            mock={testMode.mock}
            forcePick={testMode.forceOnboarding}
            onEngineReady={engineReady}
            onBack={back}
          />
        );
      case 'independence':
        return <IndependenceStep onNext={forward} onBack={back} />;
      case 'phone':
        return <PhoneIntroStep {...phone} />;
      case 'tailscaleMac':
        return <TailscaleMacStep {...phone} />;
      case 'tailscalePhone':
        return <TailscalePhoneStep {...phone} />;
      case 'phoneApp':
        return <PhoneAppStep {...phone} />;
      case 'phonePair':
        return <PhonePairStep {...phone} />;
      case 'ready':
        return (
          <ReadyStep
            engineName={chosen ? engineName(chosen) : null}
            onImport={() => go('importRemote')}
            onStartFresh={startFresh}
            onBack={back}
          />
        );
      case 'importRemote':
        return <ImportRemoteStep {...importing} />;
      case 'importConnect':
        return <ImportConnectStep {...importing} />;
      case 'importStart':
        return <ImportStartStep {...importing} onOpenChief={finish} />;
    }
  })();

  return (
    <>
      {error && (
        <div className="onboarding-error flow-error" role="alert">
          <p>{error}</p>
          <Button variant="secondary" onClick={() => void fetchStatus()}>
            Try again
          </Button>
        </div>
      )}
      {screen}
    </>
  );
}
