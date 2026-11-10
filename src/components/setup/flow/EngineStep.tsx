/**
 * Step 2: the engine. Pick Claude Code or Codex, then each thing it needs
 * is its own screen — get the Mac ready (Codex only), install, sign in —
 * with one button and the app's own check under it. A screen whose check
 * passes says "Done" for a beat and moves on; one that fails says "Not done
 * yet" with Try again. The install and sign-in run in a terminal window
 * over the screen, as before.
 *
 * @module components/setup/flow/EngineStep
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '../../primitives/Button';
import { Spinner } from '../../primitives/Spinner';
import { OnboardingTerminal } from '../../terminal/lazyTerminals';
import { AgentPickGrid, type AgentCardKey } from '../agent-led/AgentPickGrid';
import { useAgentSetupActions } from '../agent-led/useAgentSetupActions';
import { CheckLine, FlowShell, ADVANCE_MS } from './FlowParts';
import {
  FullSetupStatus,
  SETUP_FRIENDLY_NAMES,
  getBlockingDependencies,
  type SetupItem,
} from '../../../lib/setup';
import { isEnginePairReady, readyAgentsEngine } from '../../../lib/agentOnboarding';
import { engineItemCheck, engineItemCopy, engineScreens } from '../../../lib/onboardingFlow';

const ENGINES: Record<AgentCardKey, { binaryId: string; name: string; account: string }> = {
  claude: { binaryId: 'claude', name: 'Claude Code', account: 'Claude Pro or Max' },
  codex: { binaryId: 'codex', name: 'Codex', account: 'ChatGPT Plus or Pro' },
};

export const engineName = (key: AgentCardKey) => ENGINES[key].name;

interface EngineStepProps {
  items: SetupItem[];
  fetchStatus: () => Promise<FullSetupStatus | null>;
  updateItemStatus: (itemId: string, updates: Partial<SetupItem>) => void;
  mock: boolean;
  /** Show the choice even when an engine is ready (SHIPSTUDIO_FORCE_ONBOARDING). */
  forcePick: boolean;
  /** The engine is installed and signed in: make it the default, then move on. */
  onEngineReady: (key: AgentCardKey) => Promise<void>;
  onBack: () => void;
}

export function EngineStep({
  items,
  fetchStatus,
  updateItemStatus,
  mock,
  forcePick,
  onEngineReady,
  onBack,
}: EngineStepProps) {
  const actions = useAgentSetupActions({ fetchStatus, updateItemStatus, mock });
  const busy = actions.activeItemId !== null || actions.terminalConfig !== null;
  const [picked, setPicked] = useState<AgentCardKey | null>(null);
  const [choosing, setChoosing] = useState(forcePick);
  // The screens for this visit, fixed when the engine is picked, and the one shown.
  const [rows, setRows] = useState<string[]>([]);
  const [shown, setShown] = useState<string | null>(null);
  const [finishing, setFinishing] = useState(false);
  const ready = readyAgentsEngine(items);

  const pick = (key: AgentCardKey) => {
    if (isEnginePairReady(items, key)) {
      void finish(key);
      return;
    }
    const ids = engineScreens(key, items);
    setPicked(key);
    setRows(ids);
    setShown(ids.find((id) => items.find((i) => i.id === id)?.status !== 'ready') ?? null);
  };

  const finish = useCallback(
    async (key: AgentCardKey) => {
      setFinishing(true);
      try {
        await onEngineReady(key);
      } finally {
        setFinishing(false);
      }
    },
    [onEngineReady]
  );

  // The shown screen passed: "Done" for a beat, then the next one (or the end).
  const shownItem = items.find((i) => i.id === shown);
  const shownReady = shownItem?.status === 'ready';
  useEffect(() => {
    if (!picked || !shownReady || busy) return;
    const timer = setTimeout(() => {
      const next = rows.find((id) => items.find((i) => i.id === id)?.status !== 'ready');
      if (next) setShown(next);
      else if (isEnginePairReady(items, picked)) void finish(picked);
    }, ADVANCE_MS);
    return () => clearTimeout(timer);
  }, [picked, shownReady, busy, rows, items, finish]);

  // Pressing the card is the intent: each screen starts its own work once.
  // A failure or a cancel stops the autopilot; Try again takes over.
  const started = useRef(new Set<string>());
  // Every screen whose work has been started this visit, so one that comes
  // back neither done nor failed (its window closed) can say so.
  const [tried, setTried] = useState<ReadonlySet<string>>(() => new Set());
  const run = useCallback(
    (id: string) => {
      setTried((prev) => (prev.has(id) ? prev : new Set(prev).add(id)));
      void actions.handleItemAction(id);
    },
    [actions]
  );
  useEffect(() => {
    if (!shownItem || busy || shownReady) return;
    if (shownItem.status === 'error' || shownItem.status === 'in_progress') return;
    if (getBlockingDependencies(shownItem.id, items).length > 0) return;
    if (started.current.has(shownItem.id)) return;
    started.current.add(shownItem.id);
    run(shownItem.id);
  }, [shownItem, busy, shownReady, items, run]);

  const terminal = actions.terminalConfig && (
    <div className="onboarding-terminal-overlay">
      <div className="onboarding-terminal-modal">
        <div className="onboarding-terminal-header">
          <span className="onboarding-terminal-title">
            {SETUP_FRIENDLY_NAMES[actions.terminalConfig.itemId] || actions.terminalConfig.itemId}
          </span>
          <Button variant="ghost" size="compact" onClick={actions.handleTerminalCancel}>
            {actions.terminalExitCode ? 'Close' : 'Cancel'}
          </Button>
        </div>
        <OnboardingTerminal
          command={actions.terminalConfig.command}
          args={actions.terminalConfig.args}
          onExit={(exitCode, outputTail) => void actions.handleTerminalExit(exitCode, outputTail)}
        />
        <div className="onboarding-terminal-hint">
          <strong>If you’re asked for a password</strong>, type it and press Enter. Nothing shows as
          you type, but it is being entered.
        </div>
      </div>
    </div>
  );

  // Already set up on this Mac: say so, and go on from here.
  if (!picked && ready && !choosing) {
    return (
      <FlowShell
        step="engine"
        title={`${ENGINES[ready].name} is connected`}
        lede="Your agents run on it, on this Mac, with your own account."
        onBack={onBack}
        primary={
          <Button
            variant="primary"
            size="large"
            onClick={() => void finish(ready)}
            disabled={finishing}
            data-flow-primary
          >
            {finishing ? <Spinner size="sm" /> : 'Meet your Chief of Staff'}
          </Button>
        }
        secondary={
          <Button variant="ghost" onClick={() => setChoosing(true)}>
            Use a different one
          </Button>
        }
      >
        <CheckLine
          result={{ state: 'pass', line: `${ENGINES[ready].name} is installed and signed in.` }}
        />
      </FlowShell>
    );
  }

  if (!picked) {
    return (
      <FlowShell
        step="engine"
        title="Which AI should your agents run on?"
        lede="You don’t need to know how to code. Pick the one whose plan you pay for; you can add the other later."
        onBack={onBack}
        wide
      >
        <AgentPickGrid items={items} onSelect={pick} disabled={busy} />
      </FlowShell>
    );
  }

  const engine = ENGINES[picked];
  const index = shown ? rows.indexOf(shown) : rows.length - 1;
  const itemId = shown ?? `${picked}_auth`;
  const copy = engineItemCopy(itemId, engine);
  const check = engineItemCheck(
    items.find((i) => i.id === itemId),
    itemId.endsWith('_auth'),
    tried.has(itemId) && !busy
  );
  const failed = check?.state === 'fail';
  const pending = check === null;

  return (
    <>
      <FlowShell
        step="engine"
        title={copy.title}
        lede={copy.lede}
        onBack={busy ? undefined : () => setPicked(null)}
        primary={
          (pending || failed) && (
            <Button
              variant="primary"
              size="large"
              disabled={busy}
              onClick={() => run(itemId)}
              data-flow-primary
            >
              {failed ? 'Try again' : copy.action}
            </Button>
          )
        }
      >
        <p className="flow-eyebrow">
          {engine.name} · {index + 1} of {rows.length}
        </p>
        {check && <CheckLine result={check} />}
      </FlowShell>
      {terminal}
    </>
  );
}
