/**
 * Import without Remote access: an export file or folder, or a reply pasted
 * back from the old assistant.
 *
 * Rust reads either one with plain code, never a model (`agents/import_export.rs`,
 * `agents/import_formats.rs`): Grok Bot's export, OpenBot's import and transfer
 * files, an OpenClaw workspace or `~/.openclaw`, a Hermes home or profile
 * export, or a reply to our message. This shows what it holds and, for a
 * reply, exactly what's still missing with the message that asks for it, so
 * the user can go round again until nothing is. Then one review card goes up
 * in the Chief's chat, the same card the connector's import ends on; nothing
 * becomes an agent until Import is pressed there.
 *
 * @module components/agents/ImportPastePanel
 */

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import { ErrorIcon } from '@/components/icons';
import { Button } from '../primitives/Button';
import { TextButton } from '../primitives/TextButton';
import { TextArea } from '../primitives/TextField';
import { useAsyncState } from '../../hooks/useAsyncState';
import { asCommandError, formatCommandError } from '../../lib/errors';
import {
  getExportImportPrompt,
  previewFileImport,
  previewTextImport,
  reviewFileImport,
  reviewTextImport,
  type ExportImportPosted,
  type ExportImportPreview,
  type ImportSummary,
  type PasteImportAgent,
} from '../../lib/agents';
import { useAgentsList } from '../../lib/agentsStore';
import { useFileDrop } from './useComposerAttachments';
import { ExportPreview, ImportStep, MessageCard } from './ImportParts';

/** Long enough that a paste lands in one check, short enough to feel live. */
const PREVIEW_DELAY_MS = 200;

/** What a finished import (the other app's copy) says in the done state. */
export interface ImportResult {
  summary: ImportSummary;
  agents: Pick<PasteImportAgent, 'name' | 'isMain' | 'color'>[];
  /** Shown in the done state under the shared summary. */
  extra?: ReactNode;
}

interface ImportPastePanelProps {
  onCancel: () => void;
  /** The review card is up in the Chief's chat: close and go there. */
  onPosted: (posted: ExportImportPosted) => void;
  /** Under the lede: the way back to the main path, when this is the fallback. */
  aside?: ReactNode;
}

const baseName = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() ?? path;

const failed = (e: unknown): ExportImportPreview => ({
  source: '',
  format: '',
  verified: false,
  agents: [],
  main: null,
  about: [],
  problems: [formatCommandError(asCommandError(e))],
  refused: [],
  gaps: [],
  followUp: null,
  masked: 0,
  read: [],
  skipped: [],
});

export function ImportPastePanel({ onCancel, onPosted, aside }: ImportPastePanelProps) {
  const [prompt, setPrompt] = useState('');
  const [copied, setCopied] = useState(false);
  const [showMessage, setShowMessage] = useState(false);
  const [text, setText] = useState('');
  const [file, setFile] = useState<string | null>(null);
  const [checked, setChecked] = useState<{ key: string; preview: ExportImportPreview } | null>(
    null
  );
  const chief = useAgentsList().find((a) => a.isMain)?.name ?? 'your Chief of Staff';
  const drop = useRef<HTMLDivElement>(null);
  const { over, dom } = useFileDrop(
    drop,
    true,
    (paths) => setFile(paths[0] ?? null),
    () => {}
  );

  const poster = useAsyncState(async () => {
    try {
      const posted = file ? await reviewFileImport(file) : await reviewTextImport(text);
      onPosted(posted);
      return posted;
    } catch (e) {
      const err = asCommandError(e);
      throw new Error(err.type === 'Validation' ? err.reason : formatCommandError(err));
    }
  });

  useEffect(() => {
    void getExportImportPrompt()
      .then(setPrompt)
      .catch(() => setPrompt(''));
  }, []);

  // What's being read: the file if there is one, else the paste.
  const key = file ? `file:${file}` : `text:${text}`;
  useEffect(() => {
    if (!file && !text.trim()) return;
    let live = true;
    const timer = setTimeout(
      () => {
        (file ? previewFileImport(file) : previewTextImport(text))
          .then((preview) => live && setChecked({ key, preview }))
          .catch((e: unknown) => live && setChecked({ key, preview: failed(e) }));
      },
      file ? 0 : PREVIEW_DELAY_MS
    );
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [file, text, key]);

  const pick = async (directory: boolean) => {
    const picked = await open({
      directory,
      multiple: false,
      title: directory ? 'Choose the app’s folder' : 'Choose an export file',
      filters: directory
        ? undefined
        : [{ name: 'Exports', extensions: ['json', 'zip', 'gz', 'tgz', 'md', 'txt'] }],
    }).catch(() => null);
    if (typeof picked === 'string') setFile(picked);
  };

  const pasted = !!text.trim();
  const preview = (file || pasted) && checked?.key === key ? checked.preview : null;
  const ready =
    !!preview &&
    preview.problems.length === 0 &&
    (preview.agents.length > 0 || !!preview.main || preview.about.length > 0);

  return (
    <>
      <div className="agents-import__body">
        <p className="agents-import__lede">
          No Remote access needed. Bring agents from Grok Bot, OpenBot, OpenClaw or Hermes with
          their instructions, memory and routines. You check everything in {chief}’s chat before
          anything is created.
        </p>
        {aside}
        {/* A reply is being pasted: the drop area steps aside for what it holds. */}
        {!pasted && (
          <div
            ref={drop}
            className="agents-import-drop"
            data-over={over || undefined}
            data-file={file ? '' : undefined}
            {...dom}
          >
            {file ? (
              <>
                <p className="agents-import-drop__title">{baseName(file)}</p>
                <p className="agents-import-drop__hint">{file}</p>
                <TextButton onClick={() => setFile(null)}>Use something else</TextButton>
              </>
            ) : (
              <>
                <p className="agents-import-drop__title">Drop an export here</p>
                <p className="agents-import-drop__hint">
                  A file (.json, .zip, .tar.gz) or the app’s folder: ~/.openclaw, ~/.hermes, or
                  OpenBot’s export zip. In the picker, ⇧⌘. shows hidden folders.
                </p>
                <div className="agents-import-drop__actions">
                  <Button size="compact" variant="secondary" onClick={() => void pick(false)}>
                    Choose a file…
                  </Button>
                  <Button
                    size="compact"
                    variant="secondary"
                    className="agents-import-drop__folder"
                    onClick={() => void pick(true)}
                  >
                    Choose a folder…
                  </Button>
                </div>
              </>
            )}
          </div>
        )}
        {!file && (
          <>
            {!pasted && <p className="agents-import__or">No export? Ask your assistant for one.</p>}
            <ol className="agents-import-steps">
              <ImportStep
                n={1}
                state={copied || pasted ? 'done' : 'current'}
                title="Send your assistant this message"
                folded={pasted && !showMessage}
                aside={
                  pasted && (
                    <TextButton onClick={() => setShowMessage((s) => !s)}>
                      {showMessage ? 'Hide message' : 'Show message'}
                    </TextButton>
                  )
                }
              >
                <MessageCard message={prompt} lead={!pasted} onCopied={() => setCopied(true)} />
              </ImportStep>
              <ImportStep
                n={2}
                state={copied || pasted ? 'current' : 'todo'}
                title="Paste its reply"
              >
                <TextArea
                  id="agents-import-paste"
                  aria-label="The assistant's reply"
                  className="agents-import__paste"
                  rows={pasted ? 4 : 6}
                  spellCheck={false}
                  placeholder={
                    'Paste the whole reply here.\n\nIf it came in parts, or you asked for what was missing, paste each answer under the last.'
                  }
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                />
              </ImportStep>
            </ol>
          </>
        )}
        {preview && <ExportPreview preview={preview} pasted={!file} />}
        {poster.error && (
          <p className="agents-import__error" role="alert">
            <ErrorIcon size={12} className="inline-error-icon" />
            {poster.error.message}
          </p>
        )}
      </div>
      <footer className="agents-import__footer">
        <p className="agents-import__note">
          Read here, never run. Passwords and keys are left out; routines arrive paused.
        </p>
        <Button variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          variant="strong"
          disabled={!ready || poster.isLoading}
          onClick={() => void poster.execute()}
        >
          Review in {chief}’s chat
        </Button>
      </footer>
    </>
  );
}
