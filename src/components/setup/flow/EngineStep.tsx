/**
 * Step 2: the engine. Pick Claude Code or Codex, then each thing it needs
 * is its own screen — get the Mac ready (Codex only), install, sign in.
 *
 * Each screen runs like a native installer (`InstallProgress`): a few plain
 * steps that tick as the real process gets there, what it's waiting on asked
 * in plain words, and the real terminal folded under "Show details". The
 * app's own check under it decides: a screen whose check passes says "Done"
 * for a beat and moves on; one that fails says "Not done yet" with what went
 * wrong, the one fix, and Try again.
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
import { InstallDetails, InstallProgress } from './InstallProgress';
import { FullSetupStatus, getBlockingDependencies, type SetupItem } from '../../../lib/setup';
import { isEnginePairReady, readyAgentsEngine } from '../../../lib/agentOnboarding';
import { engineItemCheck, engineItemCopy, engineScreens } from '../../../lib/onboardingFlow';
import type { MockFailure } from '../../../lib/installProgress';

const ENGINES: Record<AgentCardKey, { binaryId: string; name: string; account: string }> = {
  claude: { binaryId: 'claude', name: 'Claude Code', account: 'Claude Pro or Max' },
  codex: { binaryId: 'codex', name: 'Codex', account: 'ChatGPT Plus or Pro' },
  opencode: { binaryId: 'opencode', name: 'OpenCode', account: 'AI provider' },
};

export const engineName = (key: AgentCardKey) => ENGINES[key].name;

/** A failure whose fix is installing something first, and what that is. */
const PREREQUISITE_FOR: Partial<Record<string, string>> = { homebrew: 'homebrew', node: 'node' };

interface EngineStepProps {
  items: SetupItem[];
  fetchStatus: () => Promise<FullSetupStatus | null>;
  updateItemStatus: (itemId: string, updates: Partial<SetupItem>) => void;
  mock: boolean;
  /** Mock mode: fail the first run of each item that can fail this way. */
  mockFailure?: MockFailure | null;
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
  mockFailure = null,
  forcePick,
  onEngineReady,
  onBack,
}: EngineStepProps) {
  const actions = useAgentSetupActions({ fetchStatus, updateItemStatus, mock, mockFailure });
  const busy = actions.busy;
  const [picked, setPicked] = useState<AgentCardKey | null>(null);
  const [choosing, setChoosing] = useState(forcePick);
  // The screens for this visit, fixed when the engine is picked, and the one shown.
  const [rows, setRows] = useState<string[]>([]);
  const [shown, setShown] = useState<string | null>(null);
  const [finishing, setFinishing] = useState(false);
  // "Show details" under a failure: the output of the run that failed.
  const [detailsOpen, setDetailsOpen] = useState(false);
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
  // back neither done nor failed (it was cancelled) can say so.
  const [tried, setTried] = useState<ReadonlySet<string>>(() => new Set());
  const run = useCallback(
    (id: string) => {
      setTried((prev) => (prev.has(id) ? prev : new Set(prev).add(id)));
      setDetailsOpen(false);
      void actions.handleItemAction(id, items.find((i) => i.id === id)?.status);
    },
    [actions, items]
  );
  useEffect(() => {
    if (!shownItem || busy || shownReady) return;
    if (shownItem.status === 'error' || shownItem.status === 'in_progress') return;
    if (getBlockingDependencies(shownItem.id, items).length > 0) return;
    if (started.current.has(shownItem.id)) return;
    started.current.add(shownItem.id);
    run(shownItem.id);
  }, [shownItem, busy, shownReady, items, run]);

  /**
   * Try again. When what's missing is something this needs first (Homebrew
   * for Node.js, Node.js for Codex), that is installed first, on its own
   * screen, and this one runs again after it.
   */
  const retry = (id: string) => {
    const prereq = PREREQUISITE_FOR[actions.failures[id]?.kind ?? ''];
    if (!prereq || prereq === id) {
      run(id);
      return;
    }
    actions.clearFailure(id);
    updateItemStatus(id, { status: 'not_installed', errorMessage: undefined });
    started.current.delete(id);
    setRows((prev) => {
      const without = prev.filter((r) => r !== prereq);
      const at = without.indexOf(id);
      return [...without.slice(0, at), prereq, ...without.slice(at)];
    });
    setShown(prereq);
    started.current.add(prereq);
    run(prereq);
  };

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
            {finishing ? <Spinner size="sm" /> : 'Continue'}
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
  const live = actions.run?.itemId === itemId ? actions.run : null;
  const check = live
    ? null
    : engineItemCheck(
        items.find((i) => i.id === itemId),
        itemId.endsWith('_auth'),
        tried.has(itemId) && !busy,
        actions.failures[itemId]
      );
  const failed = check?.state === 'fail';
  const pending = check === null && !live;
  const lastOutput = actions.outputs[itemId] ?? '';

  return (
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
            onClick={() => (failed ? retry(itemId) : run(itemId))}
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
      {live && (
        <InstallProgress
          itemId={itemId}
          phase={live.phase}
          output={live.output}
          lastOutputAt={live.lastOutputAt}
          terminal={
            actions.terminal && (
              <OnboardingTerminal
                key={actions.terminal.key}
                command={actions.terminal.command}
                args={actions.terminal.args}
                onExit={actions.terminal.onExit}
                onOutput={actions.terminal.onOutput}
                inputRef={actions.terminal.inputRef}
                autoFocus={false}
              />
            )
          }
          onAnswer={actions.answer}
          onCancel={actions.cancel}
        />
      )}
      {check && <CheckLine result={check} />}
      {failed && lastOutput && (
        <InstallDetails
          output={lastOutput}
          open={detailsOpen}
          onToggle={() => setDetailsOpen((o) => !o)}
        />
      )}
    </FlowShell>
  );
}
