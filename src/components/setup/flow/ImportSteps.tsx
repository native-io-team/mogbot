/**
 * "Bring my agents": the import from another assistant as three screens of
 * its own, each checked by the app.
 *
 * 1. Turn on Remote access — on by itself; ticks when a request from the
 *    internet actually reached this Mac. Funnel off in Tailscale says so,
 *    with the page and a Check again that answers.
 * 2. Add the link to your assistant — Copy link (the Mac copies it; the
 *    secret never enters this page), then ticks when the assistant connects.
 * 3. Send it this message — Start is pressed for you; ticks when the
 *    assistant starts talking to the Chief, and the last button opens the
 *    Chief's chat, where the consent card and the review card are.
 *
 * Start fresh is one click away on every screen.
 *
 * @module components/setup/flow/ImportSteps
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '../../primitives/Button';
import { Spinner } from '../../primitives/Spinner';
import { CopyIcon } from '@/components/icons';
import { usePolling } from '../../../hooks/usePolling';
import { CheckLine, FlowShell, useAdvanceOnPass, useFlowCheck } from './FlowParts';
import { MessageCard } from '../../agents/ImportParts';
import { useImportGate } from '../../agents/ImportConnectorPanel';
import { BRAND } from '../../../lib/brand';
import {
  copyRemoteLink,
  getRemoteAccessStatus,
  republishRemoteLink,
  setRemoteAccessEnabled,
  type RemoteAccessStatus,
} from '../../../lib/remoteAccess';
import { armImportTalk, getImportPrompt } from '../../../lib/agents';
import { assistantCheck, importTalkCheck, remoteOnCheck } from '../../../lib/onboardingFlow';
import { asCommandError, formatCommandError } from '../../../lib/errors';

interface StepProps {
  onNext: () => void;
  onBack: () => void;
  /** "Start fresh instead": finish onboarding without importing. */
  onStartFresh: () => void;
}

const freshButton = (onStartFresh: () => void) => (
  <Button variant="ghost" onClick={onStartFresh} data-flow-fresh>
    Start fresh instead
  </Button>
);

export function ImportRemoteStep({ onNext, onBack, onStartFresh }: StepProps) {
  const retry = useCallback(async () => {
    const s = await getRemoteAccessStatus();
    if (!s.enabled) return setRemoteAccessEnabled(true);
    if (s.linkMasked) return republishRemoteLink();
    return s;
  }, []);
  const check = useFlowCheck(getRemoteAccessStatus, { name: 'flow-remote', retry });
  const [now, setNow] = useState(() => Date.now());
  const [problem, setProblem] = useState<string | null>(null);
  const { data: status, setData } = check;
  // "Still publishing after N minutes" needs a clock.
  usePolling(() => Promise.resolve(setNow(Date.now())), {
    intervalMs: 5000,
    name: 'flow-remote-clock',
  });

  // Turning it on is what this screen is for.
  const enabling = useRef(false);
  useEffect(() => {
    if (!status || status.enabled || !status.supported || enabling.current) return;
    enabling.current = true;
    setRemoteAccessEnabled(true)
      .then((next: RemoteAccessStatus) => setData(next))
      .catch((e: unknown) => setProblem(formatCommandError(asCommandError(e))));
  }, [status, setData]);

  const result = problem
    ? {
        state: 'fail' as const,
        line: problem,
        fix: 'Check again. If it keeps happening, open Remote access from ⌘K.',
      }
    : remoteOnCheck(status, now);
  const doneOnArrival = useAdvanceOnPass(result, onNext, status !== null);
  return (
    <FlowShell
      step="importRemote"
      title="Turn on Remote access"
      lede="Your other assistant reaches your Chief of Staff through a private link from this Mac. It turns on by itself."
      onBack={onBack}
      primary={
        doneOnArrival && (
          <Button variant="primary" size="large" onClick={onNext} data-flow-primary>
            Continue
          </Button>
        )
      }
      secondary={freshButton(onStartFresh)}
    >
      <CheckLine
        result={result}
        checking={check.checking}
        checkedAt={check.checkedAt}
        onCheckAgain={() => {
          setProblem(null);
          void check.checkAgain();
        }}
      />
    </FlowShell>
  );
}

export function ImportConnectStep({ onNext, onBack, onStartFresh }: StepProps) {
  const check = useFlowCheck(getRemoteAccessStatus, { name: 'flow-assistant' });
  const [copied, setCopied] = useState(false);
  const [copyProblem, setCopyProblem] = useState<string | null>(null);
  const result = assistantCheck(check.data, copied);
  const doneOnArrival = useAdvanceOnPass(result, onNext, check.data !== null);
  const copy = () => {
    copyRemoteLink()
      .then(() => {
        setCopied(true);
        setCopyProblem(null);
      })
      .catch((e: unknown) => setCopyProblem(formatCommandError(asCommandError(e))));
  };
  return (
    <FlowShell
      step="importConnect"
      title="Add the link to your assistant"
      lede={`In Grok, ChatGPT or Claude, add a custom connector named ${BRAND.name} and paste this link.`}
      onBack={onBack}
      primary={
        result.state === 'pass' ? (
          doneOnArrival && (
            <Button variant="primary" size="large" onClick={onNext} data-flow-primary>
              Continue
            </Button>
          )
        ) : (
          <Button
            variant={copied ? 'secondary' : 'primary'}
            size="large"
            leftIcon={<CopyIcon size={14} />}
            onClick={copy}
            data-flow-primary
          >
            {copied ? 'Copied — copy again' : 'Copy link'}
          </Button>
        )
      }
      secondary={freshButton(onStartFresh)}
    >
      <p className="flow-note">
        The link is a key to this Mac: it’s copied straight to your clipboard and never shown.
      </p>
      {copyProblem ? (
        <CheckLine
          result={{ state: 'fail', line: copyProblem, fix: 'Go back one step and check again.' }}
        />
      ) : (
        <CheckLine
          result={result}
          checking={check.checking}
          checkedAt={check.checkedAt}
          onCheckAgain={() => void check.checkAgain()}
        />
      )}
    </FlowShell>
  );
}

export function ImportStartStep({
  onBack,
  onStartFresh,
  onOpenChief,
}: Omit<StepProps, 'onNext'> & { onOpenChief: () => Promise<void> }) {
  const { armed, talk, set } = useImportGate();
  const [prompt, setPrompt] = useState('');
  const [copied, setCopied] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);

  useEffect(() => {
    void getImportPrompt()
      .then(setPrompt)
      .catch(() => setPrompt(''));
  }, []);
  // Start is pressed for you: this screen is the start.
  const arming = useRef(false);
  useEffect(() => {
    if (armed || talk || arming.current) return;
    arming.current = true;
    armImportTalk()
      .then(set)
      .catch((e: unknown) => setProblem(formatCommandError(asCommandError(e))));
  }, [armed, talk, set]);

  const result = problem
    ? { state: 'fail' as const, line: problem, fix: 'Go back one step, then try again.' }
    : importTalkCheck(talk, armed, copied);
  const open = () => {
    setOpening(true);
    void onOpenChief().catch(() => setOpening(false));
  };
  return (
    <FlowShell
      step="importStart"
      title={
        result.state === 'pass'
          ? 'Your agents are on their way'
          : 'Send your assistant this message'
      }
      lede={
        result.state === 'pass'
          ? 'Your Chief of Staff asks you first, then plays back what each agent does. Nothing is created until you say so.'
          : 'Copy it, paste it into a new chat with your assistant, and send it.'
      }
      onBack={onBack}
      wide
      primary={
        result.state === 'pass' && (
          <Button
            variant="primary"
            size="large"
            onClick={open}
            disabled={opening}
            data-flow-primary
          >
            {opening ? <Spinner size="sm" /> : 'Open your Chief of Staff'}
          </Button>
        )
      }
      secondary={result.state !== 'pass' && freshButton(onStartFresh)}
    >
      {result.state !== 'pass' && prompt && (
        <MessageCard message={prompt} onCopied={() => setCopied(true)} lead={!copied} />
      )}
      <CheckLine result={result} />
    </FlowShell>
  );
}
