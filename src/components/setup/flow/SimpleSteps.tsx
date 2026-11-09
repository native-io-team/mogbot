/**
 * The one-question screens: Welcome, how independent agents are, and the
 * last step — "You're ready. Bring your agents, or start fresh?"
 *
 * @module components/setup/flow/SimpleSteps
 */

import { useEffect, useRef, useState } from 'react';
import { Button } from '../../primitives/Button';
import { Spinner } from '../../primitives/Spinner';
import { AgentAvatar } from '../../agents/AgentAvatar';
import { IndependenceSlider } from '../../agents/IndependenceSlider';
import { FlowShell } from './FlowParts';
import {
  DEFAULT_INDEPENDENCE,
  INDEPENDENCE_QUESTION,
  getIndependence,
  setIndependence,
  type AgentIndependence,
} from '../../../lib/agentIndependence';
import { asCommandError, formatCommandError } from '../../../lib/errors';
import { useAgentsSelector } from '../../../lib/agentsStore';
import type { Agent } from '../../../lib/agents';
import { CHIEF_LOOK } from '../../../../packages/companion-protocol/src/avatar';

export function WelcomeStep({ onNext }: { onNext: () => void }) {
  return (
    <FlowShell
      step="welcome"
      title="Your own team of AI agents"
      lede="They run on this Mac, on your own Claude or ChatGPT plan. You talk to one, your Chief of Staff, and anything risky waits for your OK."
      primary={
        <Button variant="primary" size="large" onClick={onNext} autoFocus data-flow-primary>
          Get started
        </Button>
      }
    >
      <p className="flow-note">About five minutes, or fifteen with your phone.</p>
    </FlowShell>
  );
}

/** How much agents do on their own. Skip keeps what's saved (the default when nothing is). */
export function IndependenceStep({ onNext, onBack }: { onNext: () => void; onBack: () => void }) {
  const [level, setLevel] = useState<AgentIndependence>(DEFAULT_INDEPENDENCE);
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const touched = useRef(false);
  useEffect(() => {
    let live = true;
    getIndependence()
      .then((saved) => {
        if (live && !touched.current) setLevel(saved);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);

  const save = async () => {
    setSaving(true);
    try {
      await setIndependence(level);
      onNext();
    } catch (e) {
      setProblem(formatCommandError(asCommandError(e)));
      setSaving(false);
    }
  };

  return (
    <FlowShell
      step="independence"
      title={INDEPENDENCE_QUESTION}
      lede="It applies to every agent. Change it any time by telling your Chief."
      onBack={onBack}
      wide
      primary={
        <Button
          variant="primary"
          size="large"
          onClick={() => void save()}
          disabled={saving}
          data-flow-primary
        >
          {saving ? <Spinner size="sm" /> : 'Continue'}
        </Button>
      }
      secondary={
        <Button variant="ghost" onClick={onNext} disabled={saving}>
          Skip
        </Button>
      }
    >
      <div className="agent-onboarding-independence">
        <IndependenceSlider
          value={level}
          onChange={(next) => {
            touched.current = true;
            setLevel(next);
          }}
          disabled={saving}
          large
          showTitle={false}
        />
      </div>
      {problem && (
        <div className="onboarding-error" role="alert">
          <p>{problem}</p>
        </div>
      )}
    </FlowShell>
  );
}

const CHIEF_FALLBACK: Pick<Agent, 'name' | 'color'> & { id?: string } = {
  name: 'Chief of Staff',
  color: 'white',
};
const selectChief = (s: { agents: Agent[] }) => s.agents.find((a) => a.isMain) ?? null;

/**
 * The last step. Two answers, both neutral: bring the agents another
 * assistant runs (a short line of its own), or start fresh with the Chief.
 */
export function ReadyStep({
  engineName,
  onImport,
  onStartFresh,
  onBack,
}: {
  engineName: string | null;
  onImport: () => void;
  onStartFresh: () => Promise<void>;
  onBack: () => void;
}) {
  const chief = useAgentsSelector(selectChief) ?? CHIEF_FALLBACK;
  const [going, setGoing] = useState(false);
  const fired = useRef(false);
  const fresh = () => {
    if (fired.current) return;
    fired.current = true;
    setGoing(true);
    void onStartFresh().catch(() => {
      fired.current = false;
      setGoing(false);
    });
  };
  return (
    <FlowShell
      step="ready"
      title="You’re ready"
      lede={
        engineName
          ? `${engineName} is connected and your Chief of Staff is waiting. Do you want to bring your agents from Grok, ChatGPT or another assistant first?`
          : 'Your Chief of Staff is waiting. Do you want to bring your agents from Grok, ChatGPT or another assistant first?'
      }
      onBack={onBack}
      primary={
        <Button variant="strong" size="large" onClick={onImport} disabled={going} data-flow-import>
          Bring my agents
        </Button>
      }
      secondary={
        <Button variant="secondary" size="large" onClick={fresh} disabled={going} data-flow-fresh>
          {going ? <Spinner size="sm" /> : 'Start fresh'}
        </Button>
      }
    >
      <div className="flow-ready-avatar">
        <AgentAvatar
          id={chief.id}
          look={chief.id ? undefined : CHIEF_LOOK}
          name={chief.name}
          color={chief.color}
          size="hero"
          selected
        />
      </div>
    </FlowShell>
  );
}
