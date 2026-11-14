/**
 * Settings → Agents → Dictation: your words. Names and terms dictation should
 * get right, typed in here or learned from your fixes (the same dictated word
 * changed twice before sending). They go to Whisper and the names pass on
 * this computer, for the desk and the phone alike (src-tauri/src/voice/words.rs).
 *
 * @module components/agents/AgentDictationWords
 */
import { useEffect, useState, type FormEvent } from 'react';
import { CloseIcon } from '@/components/icons';
import { Button } from '../primitives/Button';
import { IconButton } from '../primitives/IconButton';
import { TextField } from '../primitives/TextField';
import { useOptionalToast } from '../../contexts/ToastContext';
import {
  addDictationWord,
  dictationWords,
  removeDictationWord,
  type DictationWords,
} from '../../lib/dictation';
import { asCommandError, formatCommandError } from '../../lib/errors';
import { Group, Row } from './AgentSettingsRows';

/** What a learned word was heard as, from the fixes behind it. */
function heardAs(words: DictationWords, word: string): string[] {
  return words.fixes.filter((f) => f.fixed === word).map((f) => f.heard);
}

export function AgentDictationWords() {
  const { showToast } = useOptionalToast();
  const [words, setWords] = useState<DictationWords | null>(null);
  const [draft, setDraft] = useState('');

  useEffect(() => {
    let alive = true;
    void dictationWords()
      .then((w) => alive && setWords(w))
      .catch(() => alive && setWords({ words: [], fixes: [], removed: [] }));
    return () => {
      alive = false;
    };
  }, []);

  const run = (p: Promise<DictationWords>) =>
    p.then(setWords).catch((e) => showToast(formatCommandError(asCommandError(e)), 'error'));

  const add = (e: FormEvent) => {
    e.preventDefault();
    const word = draft.trim();
    if (!word) return;
    setDraft('');
    void run(addDictationWord(word));
  };

  if (!words) return null;
  return (
    <Group
      id="dictation-words"
      title="Dictation"
      footnote="When you fix the same dictated word twice before sending, it’s added here on its own. Kept on this computer; used for your phone’s dictation too."
    >
      <Row
        label="Your words"
        description="Names and terms dictation should always get right."
        stacked
      >
        <form className="dictation-words__add" onSubmit={add}>
          <TextField
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Add a word, like a name"
            aria-label="Add a word"
            maxLength={64}
          />
          <Button variant="secondary" type="submit" disabled={!draft.trim()}>
            Add
          </Button>
        </form>
      </Row>
      {words.words.length === 0 ? (
        <Row
          label={<span className="dictation-words__empty">No words yet</span>}
          description="Your agents’ and projects’ names are always known."
        />
      ) : (
        words.words.map((w) => {
          const heard = heardAs(words, w.word);
          return (
            <Row
              key={w.word}
              label={w.word}
              description={
                w.learned
                  ? heard.length
                    ? `Learned from your fixes (heard as “${heard.slice(0, 2).join('”, “')}”)`
                    : 'Learned from your fixes'
                  : undefined
              }
            >
              <IconButton
                variant="ghost"
                size="compact"
                icon={<CloseIcon size={12} />}
                onClick={() => void run(removeDictationWord(w.word))}
                aria-label={`Remove ${w.word}`}
                title="Remove"
              />
            </Row>
          );
        })
      )}
    </Group>
  );
}
