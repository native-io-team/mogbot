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
      return `${talk.source} is asking to start: answer the card in ${chief}’s chat`;
    case 'interviewing':
      return talk.staged.length
        ? `${talk.source} is answering ${chief}’s questions · ${listOf(talk.staged)} staged`
        : `${talk.source} is answering ${chief}’s questions`;
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
          Your other assistant (Grok, ChatGPT, Claude…) can send its agents here. It answers a short
          interview run as {chief}, and you review every agent before anything is created.
        </p>
        <div className="agents-import-limits" data-testid="agents-import-limits">
          <div>
            <h4>It can</h4>
            <ul>
              <li>Answer questions about the agents it runs for you</li>
              <li>Stage them for your review</li>
            </ul>
          </div>
          <div>
            <h4>It can’t</h4>
            <ul>
              <li>See your chats, files, memory or other agents</li>
              <li>Create or change anything: you import what you keep</li>
              <li>Start without you: press Start, then allow it</li>
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
              <span>It reaches this Mac through Remote access.</span>
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
            title={`Allow it, then review in ${chief}’s chat`}
          >
            <div className="agents-import-watch">
              {talk ? (
                <p className="agents-import-watch__live" data-state={talk.state}>
                  <span className="agents-import-watch__dot" aria-hidden />
                  {talkLine(talk, chief)}
                </p>
              ) : (
                <p>
                  {chief} asks you first, then shows each agent on one card to import or not. Logins
                  are asked for on secure cards, never in the conversation.
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
          <TextButton onClick={onPaste}>Can’t connect? Paste a reply instead</TextButton>
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
