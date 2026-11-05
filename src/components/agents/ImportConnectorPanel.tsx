/**
 * Import from another assistant as a conversation (`agents/connector.rs`).
 *
 * MCP only goes from the other assistant to us, so it has to drive: the user
 * sends it one message, and it talks to the Chief of Staff over the
 * connector's `import_conversation` tool until the Chief has brought every
 * agent over. The user watches that in the Chief's chat, which is why the
 * last step is "open it". While a conversation is going, this panel says so
 * and how far it has got.
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
import { AGENT_EVENTS, getImportPrompt, getImportTalk, type ImportTalk } from '../../lib/agents';
import { useAgentsList } from '../../lib/agentsStore';
import { BRAND } from '../../lib/brand';
import { ImportStep, listOf, MessageCard, plural } from './ImportParts';

/** The conversation going on now, kept current from the backend's events. */
export function useImportTalk(): ImportTalk | null {
  const [talk, setTalk] = useState<ImportTalk | null>(null);
  useEffect(() => {
    let live = true;
    void getImportTalk()
      .then((t) => live && setTalk(t))
      .catch(() => undefined);
    const unlisten = listen<ImportTalk | null>(AGENT_EVENTS.importTalk, (e) => {
      if (live) setTalk(e.payload);
    });
    return () => {
      live = false;
      void unlisten.then((u) => u()).catch(() => undefined);
    };
  }, []);
  return talk;
}

/** "Talking to Grok · Finance and Travel are here so far". */
export function talkLine(talk: ImportTalk, chief: string): string {
  const so = talk.agents.length
    ? `${listOf(talk.agents)} ${talk.agents.length === 1 ? 'is' : 'are'} here so far`
    : 'no agents yet';
  if (talk.state === 'finished')
    return `${talk.source} is done: ${talk.agents.length ? plural(talk.agents.length, 'agent') : 'no agents'} brought over`;
  if (talk.state === 'stopped') return `You stopped the import from ${talk.source}`;
  return `${chief} is talking to ${talk.source} · ${so}`;
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
  const openModal = useOpenModal();
  const main = useAgentsList().find((a) => a.isMain);
  const chief = main?.name ?? 'Chief of Staff';
  const talk = useImportTalk();
  const talking = talk?.state === 'active';

  useEffect(() => {
    void getImportPrompt()
      .then(setPrompt)
      .catch(() => setPrompt(''));
  }, []);

  const sent = copied || !!talk;
  return (
    <>
      <div className="agents-import__body">
        <p className="agents-import__lede">
          Your other assistant (Grok, ChatGPT, Claude…) moves its agents here by talking to {chief}{' '}
          over the {BRAND.name} connector. {chief} asks about each one and brings it over as the
          answers come in. You watch it happen in the chat.
        </p>
        <ol className="agents-import-steps">
          <ImportStep
            n={1}
            state={connected ? 'done' : 'current'}
            title={`Connect it to ${BRAND.name}`}
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
            title="Send it this message"
            folded={talking}
            aside={talking && 'Sent'}
          >
            <MessageCard
              message={prompt}
              lead={connected && !sent}
              onCopied={() => setCopied(true)}
            />
          </ImportStep>
          <ImportStep
            n={3}
            state={talk?.state === 'finished' ? 'done' : sent ? 'current' : 'todo'}
            title={`Watch it in ${chief}’s chat`}
          >
            <div className="agents-import-watch">
              {talk ? (
                <p className="agents-import-watch__live" data-state={talk.state}>
                  <span className="agents-import-watch__dot" aria-hidden />
                  {talkLine(talk, chief)}
                </p>
              ) : (
                <p>
                  Each agent appears in your list as it comes over. Logins are asked for here, on
                  secure cards, never in the conversation, and you can stop it at any time.
                </p>
              )}
              {main && (
                <Button
                  variant={talk ? 'primary' : 'secondary'}
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
        <Button variant="secondary" onClick={onClose}>
          Done
        </Button>
      </footer>
    </>
  );
}
