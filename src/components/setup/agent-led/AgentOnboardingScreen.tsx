/**
 * Onboarding: from nothing to talking with the Chief of Staff.
 *
 * It asks for exactly one thing, an engine Agents can run on (Claude Code or
 * Codex), installed and signed in. That is the only part that can't be
 * agent-led, and it is all a person needs before their Chief of Staff can
 * answer. Everything a project needs (a package manager, Node, Git, a GitHub
 * sign-in, hosting) is asked for later, when work first becomes a project
 * (`ProjectToolsModal`).
 *
 * The app verifies; nothing self-certifies: an engine counts as set up when
 * the app's own checks say it is installed and signed in.
 *
 * States: loading → pick (grid → per-engine detail) → complete, which hands
 * off to Agents. A machine that already has an engine ready fast-paths to
 * complete — except under SHIPSTUDIO_FORCE_ONBOARDING, where the pick phase
 * is always shown so the flow can be eyeballed on a dev machine.
 */

import { ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { CelebrationScreen } from '../CelebrationScreen';
import { OnboardingTerminal } from '../OnboardingTerminal';
import { AgentPickGrid, AgentCardKey } from './AgentPickGrid';
import { AgentSetupDetail } from './AgentSetupDetail';
import { useAgentSetupActions } from './useAgentSetupActions';
import { Button } from '../../primitives/Button';
import { Spinner } from '../../primitives/Spinner';
import {
  SetupItem,
  FullSetupStatus,
  getFullSetupStatus,
  setDefaultAgentId,
  SETUP_FRIENDLY_NAMES,
} from '../../../lib/setup';
import {
  getOnboardingTestMode,
  isEnginePairReady,
  readyAgentsEngine,
  OnboardingTestMode,
} from '../../../lib/agentOnboarding';
import { initDefaultAgent, getAgentById } from '../../../lib/agent';
import { ClaudeIcon, CodexIcon } from '@/components/icons';
import { withTimeout, TimeoutError } from '../../../lib/withTimeout';
import { trackEvent, setActiveScreen } from '../../../lib/analytics';
import { logger } from '../../../lib/logger';

type Phase = 'loading' | 'pick' | 'complete';

const SETUP_STATUS_TIMEOUT_MS = 15_000;

// Session-scoped guard mirroring setup_started dedupe (module scope survives
// StrictMode remounts, resets per app process).
let agentSetupStartedFired = false;

/** Agent-config id for a setup pair's binary id (claude → claude-code). */
function agentIdForBinary(binaryId: string): string {
  return binaryId === 'claude' ? 'claude-code' : binaryId;
}

const DETAIL_ICONS: Record<AgentCardKey, ReactNode> = {
  claude: <ClaudeIcon size={28} />,
  codex: <CodexIcon size={28} />,
};

/** How it works, in one line: the three things a person does. */
const HOW_IT_WORKS =
  'Talk to your Chief of Staff. It builds a team. Anything risky waits for your OK.';

interface AgentOnboardingScreenProps {
  /** Called when setup is complete and the user continues. */
  onComplete: () => void;
}

export function AgentOnboardingScreen({ onComplete }: AgentOnboardingScreenProps) {
  const [phase, setPhase] = useState<Phase>('loading');
  const [items, setItems] = useState<SetupItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  /** Engine card being set up in the detail view (grid shown when null). */
  const [detailAgent, setDetailAgent] = useState<AgentCardKey | null>(null);
  /** The engine committed to; named on the hand-off screen. */
  const [chosenKey, setChosenKey] = useState<AgentCardKey | null>(null);
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
          ? 'Checking this computer took too long. Try again, and if it keeps happening, quit and reopen the app.'
          : 'Couldn’t check this computer. Try again.'
      );
      return null;
    }
  }, []);

  const updateItemStatus = useCallback((itemId: string, updates: Partial<SetupItem>) => {
    setItems((prev) => prev.map((item) => (item.id === itemId ? { ...item, ...updates } : item)));
  }, []);

  const actions = useAgentSetupActions({ fetchStatus, updateItemStatus, mock: testMode.mock });

  /** Commit a verified engine as the default and hand off. */
  const finishWith = useCallback(async (binaryId: AgentCardKey, entryPath: string) => {
    const agentId = agentIdForBinary(binaryId);
    await setDefaultAgentId(agentId);
    initDefaultAgent(agentId);
    setChosenKey(binaryId);
    setDetailAgent(null);
    void trackEvent('onboarding_completed', {
      agents: [agentId],
      entry_path: entryPath,
      $screen_name: 'Onboarding',
    });
    setPhase('complete');
  }, []);

  // Initial load: test mode + status, then route.
  useEffect(() => {
    const init = async () => {
      const mode = await getOnboardingTestMode().catch(() => ({
        mock: false,
        forceOnboarding: false,
      }));
      setTestMode(mode);
      const status = await fetchStatus();
      if (!status) {
        setPhase('pick'); // show the error banner with Retry
        return;
      }
      if (!agentSetupStartedFired) {
        agentSetupStartedFired = true;
        void trackEvent('setup_started', { entry_path: 'agent_led', entry_step: null });
      }

      // Fast path: an engine is already ready — except under
      // force-onboarding, where showing the pick phase is the whole point.
      const ready = readyAgentsEngine(status.items);
      if (!mode.forceOnboarding && ready) {
        await finishWith(ready, 'agent_led_fast_path');
        return;
      }
      setActiveScreen('Onboarding - Agent Pick');
      setPhase('pick');
    };
    void init();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleCardSelect = useCallback(
    (key: AgentCardKey) => {
      const pairReady = isEnginePairReady(items, key);
      void trackEvent('agent_card_selected', { key, already_ready: pairReady });
      if (pairReady) void finishWith(key, 'agent_led');
      else setDetailAgent(key);
    },
    [items, finishWith]
  );

  // Detail view: the moment the chosen engine is verified installed and
  // signed in, finish — the user already committed by clicking the card.
  // Guarded to fire once.
  const advancedFromDetailRef = useRef(false);
  useEffect(() => {
    if (!detailAgent || phase !== 'pick') {
      advancedFromDetailRef.current = false;
      return;
    }
    const busy = actions.activeItemId !== null || actions.terminalConfig !== null;
    if (isEnginePairReady(items, detailAgent) && !busy && !advancedFromDetailRef.current) {
      advancedFromDetailRef.current = true;
      void finishWith(detailAgent, 'agent_led');
    }
  }, [detailAgent, phase, items, actions.activeItemId, actions.terminalConfig, finishWith]);

  if (phase === 'loading') {
    return (
      <div className="onboarding-screen onboarding-loading">
        <Spinner size="lg" style={{ color: 'var(--text-muted)' }} />
        <p>Getting things ready…</p>
      </div>
    );
  }

  if (phase === 'complete') {
    return (
      <CelebrationScreen
        onContinue={onComplete}
        engineName={chosenKey ? getAgentById(agentIdForBinary(chosenKey)).displayName : null}
      />
    );
  }

  return (
    <div className="onboarding-screen">
      <div className="onboarding-content agent-onboarding-content">
        {!detailAgent && (
          <div className="onboarding-header">
            <h1>Your own team of AI agents</h1>
            <p className="onboarding-how">{HOW_IT_WORKS}</p>
            <p className="onboarding-reassurance">
              Your agents run on this computer, on an AI account of your own. Pick one to start; you
              can add the other later.
            </p>
          </div>
        )}

        {error && (
          <div className="onboarding-error">
            <p>{error}</p>
            <Button variant="secondary" onClick={() => void fetchStatus()}>
              Try again
            </Button>
          </div>
        )}

        {!detailAgent && (
          <AgentPickGrid
            items={items}
            onSelect={handleCardSelect}
            disabled={actions.activeItemId !== null || actions.terminalConfig !== null}
          />
        )}

        {detailAgent && (
          <AgentSetupDetail
            binaryId={detailAgent}
            displayName={getAgentById(agentIdForBinary(detailAgent)).displayName}
            icon={DETAIL_ICONS[detailAgent]}
            items={items}
            onItemAction={(id) => void actions.handleItemAction(id)}
            activeItemId={actions.activeItemId}
            terminalActive={actions.terminalConfig !== null}
            onBack={() => setDetailAgent(null)}
          />
        )}

        {/* Terminal modal for install/sign-in commands (shared CSS classes
            from setup.css). */}
        {actions.terminalConfig && (
          <div className="onboarding-terminal-overlay">
            <div className="onboarding-terminal-modal">
              <div className="onboarding-terminal-header">
                <span className="onboarding-terminal-title">
                  {SETUP_FRIENDLY_NAMES[actions.terminalConfig.itemId] ||
                    actions.terminalConfig.itemId}
                </span>
                <Button variant="ghost" size="compact" onClick={actions.handleTerminalCancel}>
                  {actions.terminalExitCode ? 'Close' : 'Cancel'}
                </Button>
              </div>
              <OnboardingTerminal
                command={actions.terminalConfig.command}
                args={actions.terminalConfig.args}
                onExit={(exitCode, outputTail) =>
                  void actions.handleTerminalExit(exitCode, outputTail)
                }
              />
              <div className="onboarding-terminal-hint">
                <strong>If you're asked for a password</strong>, type it and press Enter. It stays
                hidden as you type — no dots or characters appear — but it is being entered.
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
