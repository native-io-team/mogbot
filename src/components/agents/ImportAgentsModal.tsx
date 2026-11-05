/**
 * Import an agent setup from somewhere else.
 *
 * From another assistant (Grok, ChatGPT, Claude…), the main path is a
 * conversation: the user sends it one message, and it talks to the Chief of
 * Staff over the connector until every agent is over
 * (`ImportConnectorPanel`, `agents/connector.rs`). Pasting its reply is the
 * fallback for one that can't connect (`ImportPastePanel`). Both end in the
 * same merge (`agents/import.rs`).
 *
 * When the app this one grew out of has agents on this Mac, a first segment
 * reads them straight from its folder and copies them in whole
 * (`agents/other_app.rs`). It leads whenever it has someone left to bring
 * over. Its name comes from the preview (`appName`).
 *
 * @module components/agents/ImportAgentsModal
 */

import { useEffect, useRef, useState } from 'react';
import { ModalFrame } from '../primitives/ModalFrame';
import { Button } from '../primitives/Button';
import { TextButton } from '../primitives/TextButton';
import { Tabs, TabsList, TabsPanel, TabsTab } from '../primitives/Tabs';
import { previewOtherAppImport, type OtherAppPreview } from '../../lib/agents';
import { useAgentsList } from '../../lib/agentsStore';
import { getRemoteAccessStatus } from '../../lib/remoteAccess';
import { ImportPastePanel, type ImportResult } from './ImportPastePanel';
import { ImportConnectorPanel } from './ImportConnectorPanel';
import { ImportDone } from './ImportParts';
import { arriving, OtherAppImportPanel } from './OtherAppImportPanel';

/** `paste` is the assistant path's fallback, reached from the connector panel. */
export type ImportPath = 'otherApp' | 'assistant' | 'paste';

interface ImportAgentsModalProps {
  isOpen: boolean;
  /** `imported`: closed from the done state, so what opened it may be gone. */
  onClose: (imported: boolean) => void;
  /** Closes the modal and opens this agent's conversation. */
  onOpenAgent: (agentId: string) => void;
  /** Open on this path when it's available (the palette's "from the other app"). */
  initialPath?: ImportPath | null;
}

export function ImportAgentsModal({
  isOpen,
  onClose,
  onOpenAgent,
  initialPath,
}: ImportAgentsModalProps) {
  const [path, setPath] = useState<'otherApp' | 'assistant'>('assistant');
  const [pasting, setPasting] = useState(initialPath === 'paste');
  // Each opening starts on the path it was asked for (state adjusted while
  // rendering, not in an effect, so it never paints the wrong one first).
  const opening = isOpen ? `open:${initialPath ?? ''}` : 'closed';
  const [opened, setOpened] = useState(opening);
  if (opened !== opening) {
    setOpened(opening);
    setPasting(initialPath === 'paste');
  }
  const [otherApp, setOtherApp] = useState<OtherAppPreview | null>(null);
  const [connected, setConnected] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);
  const main = useAgentsList().find((a) => a.isMain);
  // The done state opens quiet after a pointer-driven import: focus goes to
  // its body, not the button, so no ring appears on something nobody tabbed
  // to (as Dropdown's `quietOpen`). A keyboard import focuses the button.
  const byPointer = useRef(false);
  const doneRef = useRef<HTMLDivElement>(null);
  const openRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!isOpen) return;
    // A click's count tells them apart, as in Dropdown: 0 is a keyboard click.
    const click = (e: MouseEvent) => (byPointer.current = e.detail > 0);
    const key = () => (byPointer.current = false);
    window.addEventListener('click', click, true);
    window.addEventListener('keydown', key, true);
    return () => {
      window.removeEventListener('click', click, true);
      window.removeEventListener('keydown', key, true);
    };
  }, [isOpen]);
  const done = result !== null;
  useEffect(() => {
    if (!done) return;
    const target = byPointer.current ? doneRef.current : (openRef.current ?? doneRef.current);
    target?.focus({ preventScroll: true });
  }, [done]);
  // The done state belongs to this opening only.
  const close = () => {
    setResult(null);
    onClose(done);
  };
  const openAgent = (id: string) => {
    setResult(null);
    onOpenAgent(id);
  };

  // Each time it opens: the other app's team leads when there's someone left
  // to bring over (or the palette asked for it); otherwise the conversation
  // over the connector, with pasting a reply one link away.
  useEffect(() => {
    if (!isOpen) return;
    let live = true;
    void Promise.all([
      getRemoteAccessStatus().catch(() => null),
      previewOtherAppImport().catch(() => null),
    ]).then(([remote, other]) => {
      if (!live) return;
      setConnected(!!remote?.enabled);
      setOtherApp(other);
      const leads = !!other && (arriving(other).length > 0 || initialPath === 'otherApp');
      setPath(leads ? 'otherApp' : 'assistant');
    });
    return () => {
      live = false;
    };
  }, [isOpen, initialPath]);

  return (
    <ModalFrame
      isOpen={isOpen}
      onClose={close}
      title={result ? undefined : 'Import agents'}
      ariaLabel={result ? 'Agents imported' : undefined}
      className="agents-import"
    >
      {result ? (
        <>
          <div className="agents-import__body" ref={doneRef} tabIndex={-1}>
            <ImportDone summary={result.summary} agents={result.agents} extra={result.extra} />
          </div>
          <footer className="agents-import__footer agents-import__footer--done">
            <Button variant="secondary" onClick={close}>
              Close
            </Button>
            {main && (
              <Button variant="primary" ref={openRef} onClick={() => openAgent(main.id)}>
                Open {main.name}
              </Button>
            )}
          </footer>
        </>
      ) : (
        <Tabs value={path} onValueChange={(v) => setPath(v as 'otherApp' | 'assistant')}>
          {otherApp && (
            <TabsList className="agents-import__tabs" aria-label="Where from">
              <TabsTab value="otherApp" width="fill">
                From {otherApp.appName}
              </TabsTab>
              <TabsTab value="assistant" width="fill">
                From another assistant
              </TabsTab>
            </TabsList>
          )}
          {otherApp && (
            <TabsPanel value="otherApp">
              <OtherAppImportPanel preview={otherApp} onCancel={close} onDone={setResult} />
            </TabsPanel>
          )}
          <TabsPanel value="assistant">
            {pasting ? (
              <ImportPastePanel
                onCancel={close}
                onDone={setResult}
                aside={
                  <p className="agents-import__switch">
                    <TextButton onClick={() => setPasting(false)}>
                      Connect your assistant instead
                    </TextButton>
                  </p>
                }
              />
            ) : (
              <ImportConnectorPanel
                connected={connected}
                onClose={close}
                onOpenAgent={openAgent}
                onPaste={() => setPasting(true)}
              />
            )}
          </TabsPanel>
        </Tabs>
      )}
    </ModalFrame>
  );
}
