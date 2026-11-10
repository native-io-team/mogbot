/**
 * Import without Remote access, from the phone (desktop `agents/import_export.rs`):
 * copy the message into the old assistant (Grok Bot or any other), paste its
 * reply back, see what it holds and what's still missing (with the message
 * that asks for it), then put one review card in the Chief's chat. The Mac
 * reads the reply with plain code; nothing is created until Import on the card.
 */

import * as Clipboard from 'expo-clipboard';
import type { ExportImportPreview } from '@shipstudio/companion-protocol';
import { useEffect, useState } from 'react';
import { StyleSheet, TextInput, View } from 'react-native';
import { Button, T } from './ui';
import { makeStyles, useAppearance, useColors } from '../lib/appearance';
import { haptic } from '../lib/haptics';
import { call, describeError } from '../lib/session';
import { fonts, radius, space, type } from '../lib/theme';
import { pasteProblemLine } from '../lib/importChoice';

const plural = (n: number, word: string) => `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`;

/** What the preview says in one line: "3 agents from Grok Bot · 4 facts about you". */
export function exportSummary(p: ExportImportPreview): string {
  const facts = p.about.reduce((n, [, count]) => n + count, 0);
  return [
    `${plural(p.agents.length, 'agent')}${p.source ? ` from ${p.source}` : ''}`,
    facts ? `${plural(facts, 'fact')} about you` : '',
    p.masked
      ? `${p.masked === 1 ? '1 password or key' : `${p.masked} passwords or keys`} left out`
      : '',
  ]
    .filter(Boolean)
    .join(' · ');
}

export function ImportPaste({
  chiefName,
  onPosted,
}: {
  chiefName: string;
  onPosted: (chiefId: string) => void;
}) {
  const colors = useColors();
  const styles = useStyles();
  const appearance = useAppearance();
  const [prompt, setPrompt] = useState('');
  const [text, setText] = useState('');
  const [preview, setPreview] = useState<ExportImportPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<'prompt' | 'more' | null>(null);

  useEffect(() => {
    void call('agents.import.exportPrompt', {})
      .then(setPrompt)
      .catch((e: unknown) => setError(describeError(e)));
  }, []);

  useEffect(() => {
    if (!text.trim()) {
      setPreview(null);
      return;
    }
    let live = true;
    const timer = setTimeout(() => {
      call('agents.import.exportPreview', { text })
        .then((p) => live && setPreview(p))
        .catch((e: unknown) => live && setError(describeError(e)));
    }, 300);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [text]);

  const copy = (what: 'prompt' | 'more', body: string) =>
    void Clipboard.setStringAsync(body).then(() => {
      setCopied(what);
      haptic.success();
    });

  const ready =
    !!preview &&
    preview.problems.length === 0 &&
    (preview.agents.length > 0 || !!preview.main || preview.about.length > 0);

  const review = async () => {
    setBusy(true);
    try {
      const posted = await call('agents.import.exportReview', { text });
      haptic.success();
      onPosted(posted.chiefId);
    } catch (e) {
      haptic.error();
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={styles.root} testID="import-paste">
      <T variant="headline" color={colors.textStrong}>
        Or paste a reply
      </T>
      <T color={colors.textSecondary}>
        No Remote access needed. Send your assistant this message, then paste its whole reply here.
      </T>
      <Button
        title={copied === 'prompt' ? 'Copied' : 'Copy message'}
        variant="outline"
        icon="doc.on.doc"
        disabled={!prompt}
        onPress={() => copy('prompt', prompt)}
      />
      <TextInput
        multiline
        value={text}
        onChangeText={setText}
        placeholder="Paste the reply. Answers to a follow-up go under the last one."
        placeholderTextColor={colors.textMuted}
        style={styles.input}
        keyboardAppearance={appearance}
        autoCorrect={false}
        autoCapitalize="none"
        accessibilityLabel="The assistant's reply"
      />
      {preview && (
        <View style={styles.preview} accessibilityLiveRegion="polite">
          {preview.problems.length > 0 ? (
            <T variant="small" color={colors.textSecondary}>
              {pasteProblemLine(preview.problems)}
            </T>
          ) : (
            <T variant="small" color={colors.textBody}>
              {exportSummary(preview)}
            </T>
          )}
          {preview.followUp && preview.gaps.length > 0 && (
            <>
              <T variant="caption" color={colors.textSecondary}>
                Still missing:{' '}
                {preview.gaps.length === 1 ? preview.gaps[0] : plural(preview.gaps.length, 'thing')}
                . Send this, then paste the answer under the last one.
              </T>
              <Button
                title={copied === 'more' ? 'Copied' : 'Copy follow-up'}
                variant="outline"
                icon="doc.on.doc"
                onPress={() => copy('more', preview.followUp ?? '')}
              />
            </>
          )}
        </View>
      )}
      <Button
        title={`Review in ${chiefName}’s chat`}
        variant="answer"
        size="large"
        busy={busy}
        disabled={!ready || busy}
        onPress={() => void review()}
      />
      {error && (
        <T variant="caption" color={colors.textSecondary}>
          {error}
        </T>
      )}
    </View>
  );
}

const useStyles = makeStyles((colors) => ({
  root: { gap: space.sm },
  preview: { gap: space.xs },
  input: {
    minHeight: 120,
    maxHeight: 240,
    fontFamily: fonts.regular,
    fontSize: type.body,
    color: colors.textBody,
    backgroundColor: colors.inputFill,
    borderRadius: radius.inner,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.inputBorder,
    padding: space.md,
    textAlignVertical: 'top' as const,
  },
}));
