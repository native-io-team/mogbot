/**
 * Import from another assistant as a conversation (`agents/connector.rs`).
 *
 * MCP only goes from the other assistant to us, so it has to drive. Nothing
 * answers it until the user presses Start here, which allows one import;
 * then the first message asks on a card in the Chief's chat. It talks to a
 * sealed interview that can only stage agents, and the user imports what
 * they keep from one review card. This panel says all of that plainly, and
 * shows where the import has got to.
 *
 * Pasting a reply is the fallback for an assistant that can't connect.
 *
 * @module components/agents/ImportConnectorPanel
 */

import { useEffect, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { Button } from '../primitives/Button';
import { TextButton } from '../primitives/TextButton';
import { TypingDots } from '../primitives/TypingDots';
import { useOpenModal } from '../../contexts/ModalContext';
import { useOptionalToast } from '../../contexts/ToastContext';
import { asCommandError, formatCommandError } from '../../lib/errors';
import {
  AGENT_EVENTS,
  armImportTalk,
  getImportPrompt,
  getImportTalk,
  stopImportTalk,
  talkIsLive,
  type ImportGate,
  type ImportTalk,
} from '../../lib/agents';
import { useAgentsList } from '../../lib/agentsStore';
import { ImportStep, listOf, MessageCard, plural } from './ImportParts';

const CLOSED: ImportGate = { armed: false, talk: null };

/** Whether an import may begin, and the one going on, kept current from events. */
export function useImportGate(): ImportGate & { set: (g: ImportGate) => void } {
  const [gate, setGate] = useState<ImportGate>(CLOSED);
  useEffect(() => {
    let live = true;
    void getImportTalk()
      .then((g) => live && setGate(g ?? CLOSED))
      .catch(() => undefined);
    const unlisten = listen<ImportGate | null>(AGENT_EVENTS.importTalk, (e) => {
      if (live) setGate(e.payload ?? CLOSED);
    });
    return () => {
      live = false;
      void unlisten.then((u) => u()).catch(() => undefined);
    };
  }, []);
  return { ...gate, set: setGate };
}

/** Where an import has got to, in one line. */
export function talkLine(talk: ImportTalk, chief: string): string {
  switch (talk.state) {
    case 'awaiting_consent':
      return `${talk.source} is asking to start: it needs your OK in ${chief}’s chat`;
    case 'interviewing': {
      const got = talk.conversations ? ` · ${plural(talk.conversations, 'past conversation')}` : '';
      return talk.staged.length
        ? `${talk.source} is answering ${chief}’s questions · ${listOf(talk.staged)} staged${got}`
        : `${talk.source} is answering ${chief}’s questions${got}`;
    }
    case 'playback':
      return `${chief} is playing back the plan: tell it what’s missing`;
    case 'review':
      return `${plural(talk.staged.length, 'agent')} ready for your review in ${chief}’s chat`;
    case 'imported':
      return talk.imported.length
        ? `Imported ${listOf(talk.imported)}`
        : 'Done: nothing was imported';
    case 'declined':
      return 'You chose not to import them. Nothing was created';
    case 'denied':
      return `You declined ${talk.source}. Nothing was shared`;
    default:
      return `You stopped the import from ${talk.source}. Nothing was created`;
  }
}

interface ImportConnectorPanelProps {
  connected: boolean;
  onClose: () => void;
  onOpenAgent: (agentId: string) => void;
  onPaste: () => void;
}

export function ImportConnectorPanel({
  connected,
  onClose,
  onOpenAgent,
  onPaste,
}: ImportConnectorPanelProps) {
  const [prompt, setPrompt] = useState('');
  const [copied, setCopied] = useState(false);
  const [starting, setStarting] = useState(false);
  const openModal = useOpenModal();
  const { showToast } = useOptionalToast();
  const main = useAgentsList().find((a) => a.isMain);
  const chief = main?.name ?? 'Chief of Staff';
  const { armed, talk, set } = useImportGate();
  const live = talkIsLive(talk);
  const ready = armed || live;

  useEffect(() => {
    void getImportPrompt()
      .then(setPrompt)
      .catch(() => setPrompt(''));
  }, []);

  const start = () => {
    setStarting(true);
    armImportTalk()
      .then((g) => {
        setCopied(false);
        set(g);
      })
      .catch((e: unknown) => showToast(formatCommandError(asCommandError(e)), 'error'))
      .finally(() => setStarting(false));
  };
  const cancel = () => {
    stopImportTalk().catch((e: unknown) =>
      showToast(formatCommandError(asCommandError(e)), 'error')
    );
  };

  const sent = live || (armed && copied);
  return (
    <>
      <div className="agents-import__body">
        <p className="agents-import__lede">
          Bring the agents your other assistant runs for you (Grok, ChatGPT, Claude…) so each one
          carries on where it left off. Your assistant tells {chief} everything each agent does, and{' '}
          {chief} plays it back to you before anything is created.
        </p>
        <div className="agents-import-limits" data-testid="agents-import-limits">
          <div>
            <h4>It brings</h4>
            <ul>
              <li>Each agent’s instructions, routines and what it watches for</li>
              <li>Your preferences, and what it knows about you</li>
              <li>Past conversations, if your assistant can send them</li>
            </ul>
          </div>
          <div>
            <h4>You decide</h4>
            <ul>
              <li>Your assistant chooses what it can send; you see what arrived</li>
              <li>{chief} plays back the plan, and you add what’s missing</li>
              <li>Nothing is created until you import. Logins are asked for securely</li>
            </ul>
          </div>
        </div>
        <ol className="agents-import-steps">
          <ImportStep
            n={1}
            state={connected ? 'done' : 'current'}
            title="Connect your assistant"
            folded={connected}
            aside={connected && 'Remote access is on'}
          >
            <div className="agents-import__inline">
              <span>
                Turn on Remote access, then add its link to your assistant as a connector. This app
                gets its own address, so another app’s Remote access keeps working beside it.
              </span>
              <Button variant="secondary" size="compact" onClick={() => openModal('remoteAccess')}>
                Set up Remote access…
              </Button>
            </div>
          </ImportStep>
          <ImportStep
            n={2}
            state={!connected ? 'todo' : sent ? 'done' : 'current'}
            title={ready ? 'Send it this message' : 'Start, then send it a message'}
            folded={live}
            aside={live && 'Sent'}
          >
            {ready ? (
              <MessageCard
                message={prompt}
                lead={connected && !sent}
                onCopied={() => setCopied(true)}
              />
            ) : (
              <div className="agents-import__inline">
                <span>Start allows one import, until it ends or the app quits.</span>
                <Button
                  variant={connected ? 'primary' : 'secondary'}
                  size="compact"
                  disabled={!connected || starting}
                  onClick={start}
                  data-testid="agents-import-start"
                >
                  Start
                </Button>
              </div>
            )}
          </ImportStep>
          <ImportStep
            n={3}
            state={talk?.state === 'imported' ? 'done' : sent ? 'current' : 'todo'}
            title={`Allow it, then check the plan in ${chief}’s chat`}
          >
            <div className="agents-import-watch">
              {talk ? (
                <p className="agents-import-watch__live" data-state={talk.state}>
                  {talk.state === 'interviewing' ? (
                    <TypingDots className="agents-import-watch__dots" />
                  ) : (
                    <span className="agents-import-watch__dot" aria-hidden />
                  )}
                  {talkLine(talk, chief)}
                </p>
              ) : (
                <p>
                  {chief} asks you first. Then it tells you what each agent will do and asks what’s
                  missing, and you choose which agents to import.
                </p>
              )}
              {main && (
                <Button
                  variant={live ? 'primary' : 'secondary'}
                  size="compact"
                  onClick={() => onOpenAgent(main.id)}
                >
                  Open {chief}
                </Button>
              )}
            </div>
          </ImportStep>
        </ol>
      </div>
      <footer className="agents-import__footer">
        <p className="agents-import__note">
          <TextButton onClick={onPaste}>
            No Remote access? Use an export or paste a reply
          </TextButton>
        </p>
        {(armed || live) && (
          <Button variant="secondary" onClick={cancel}>
            {live ? 'Stop import' : 'Cancel'}
          </Button>
        )}
        <Button variant="secondary" onClick={onClose}>
          Done
        </Button>
      </footer>
    </>
  );
}
