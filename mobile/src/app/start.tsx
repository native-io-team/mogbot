/**
 * A new agent session in a project, from the phone: Remote Access's
 * `start_agent`. The Mac opens a new agent tab in the project that starts
 * on what you type here; once the tab exists, you're watching it.
 */

import { useLocalSearchParams, useRouter } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, TextInput } from 'react-native';
import { KeyboardAwareScrollView } from 'react-native-keyboard-controller';
import { Button, T, SheetPage } from '../components/ui';
import { SheetTitle } from '../components/SheetTitle';
import { haptic } from '../lib/haptics';
import { describeError, startSession } from '../lib/session';
import { useApp } from '../lib/store';
import { useAccent } from '../lib/accent';
import { fonts, lineHeight, radius, space, type } from '../lib/theme';
import { makeStyles, useAppearance, useColors } from '../lib/appearance';
import { useComputer } from '../lib/computer';

export default function Start() {
  const comp = useComputer();
  const colors = useColors();
  const styles = useStyles();
  const appearance = useAppearance();
  const accent = useAccent();
  const { project, name } = useLocalSearchParams<{ project: string; name: string }>();
  const router = useRouter();
  const connected = useApp((s) => s.link.kind === 'connected');
  const macName = useApp((s) => s.credentials?.name) ?? comp.your;
  const [prompt, setPrompt] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const start = () => {
    const text = prompt.trim();
    if (!text) return;
    setBusy(true);
    setError(null);
    haptic.light();
    startSession(project, text)
      .then(({ sessionId }) => {
        haptic.success();
        router.replace({
          pathname: '/session/[id]',
          params: { id: sessionId, project: name, path: project },
        });
      })
      .catch((e: unknown) => {
        haptic.error();
        setError(describeError(e));
        setBusy(false);
      });
  };

  return (
    <SheetPage>
      {/* Scrolls, and keeps the field and Start above the keyboard on a small phone. */}
      <KeyboardAwareScrollView
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="interactive"
        bottomOffset={space.lg}
      >
        <SheetTitle>New task in {name}</SheetTitle>
        <T variant="small" color={colors.textSecondary}>
          {macName} starts an agent in this project on what you write here. It can take up to a
          minute to begin.
        </T>
        <TextInput
          autoFocus
          multiline
          value={prompt}
          onChangeText={setPrompt}
          placeholder="What should it do?"
          placeholderTextColor={colors.textMuted}
          style={styles.input}
          keyboardAppearance={appearance}
          selectionColor={accent.accent}
          accessibilityLabel="What the new task should do"
        />
        {error && (
          <T variant="small" color={colors.accentErrorLight}>
            {error}
          </T>
        )}
        <Button
          title={busy ? 'Starting…' : 'Start'}
          variant="primary"
          busy={busy}
          disabled={!connected || !prompt.trim()}
          onPress={start}
        />
        {!connected && (
          <T variant="caption" color={colors.textSecondary}>
            Starting a task needs {macName}.
          </T>
        )}
      </KeyboardAwareScrollView>
    </SheetPage>
  );
}

const useStyles = makeStyles((colors) => ({
  content: { padding: space.lg, paddingTop: space.xl, gap: space.md },
  input: {
    fontFamily: fonts.regular,
    fontSize: type.body,
    lineHeight: lineHeight(type.body, 1.35),
    color: colors.textBody,
    backgroundColor: colors.inputFill,
    borderRadius: radius.inner,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.inputBorder,
    padding: space.md,
    minHeight: 120,
    textAlignVertical: 'top',
  },
}));

/** A throw while drawing stays on this screen, with the way back. */
export { ScreenError as ErrorBoundary } from '../components/ScreenError';
