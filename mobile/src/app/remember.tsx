/**
 * "Remember this", from a message's menu: the message as one line worth
 * keeping (the Mac summarises it, or takes its opening), which you can edit
 * before it goes into the agent's memory. The desk's Remember modal.
 */

import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { StyleSheet, TextInput, View } from 'react-native';
import { Button, T, SheetPage } from '../components/ui';
import { SheetTitle } from '../components/SheetTitle';
import { haptic } from '../lib/haptics';
import { changeMemory, describeError, suggestMemory } from '../lib/session';
import { useApp } from '../lib/store';
import { useAccent } from '../lib/accent';
import { withAgentAccent } from '../lib/accentScreen';
import { fonts, radius, space, type } from '../lib/theme';
import { makeStyles, useAppearance, useColors } from '../lib/appearance';

export default withAgentAccent(Remember);

function Remember() {
  const colors = useColors();
  const styles = useStyles();
  const appearance = useAppearance();
  const accent = useAccent();
  const { id, messageId } = useLocalSearchParams<{ id: string; messageId: string }>();
  const router = useRouter();
  const name = useApp((s) => s.overview?.agents.find((a) => a.id === id)?.name ?? 'This agent');
  const source = useApp((s) => s.chats[id]?.messages.find((m) => m.id === messageId)?.text ?? '');
  const connected = useApp((s) => s.link.kind === 'connected');
  const [text, setText] = useState('');
  const [summarising, setSummarising] = useState(() => !!source);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Once you've typed, a late summary doesn't overwrite you.
  const typed = useRef(false);

  useEffect(() => {
    if (!source) return;
    let live = true;
    suggestMemory(source)
      .then((line) => live && !typed.current && setText(line))
      .catch(() => undefined)
      .finally(() => live && setSummarising(false));
    return () => {
      live = false;
    };
  }, [source]);

  const save = async () => {
    const fact = text.trim();
    if (!fact) return;
    setBusy(true);
    setError(null);
    try {
      await changeMemory(id, { op: 'add', text: fact });
      haptic.success();
      router.back();
    } catch (e) {
      haptic.error();
      setError(describeError(e));
      setBusy(false);
    }
  };

  return (
    <SheetPage>
      <View style={styles.root}>
        <SheetTitle>Remember this</SheetTitle>
        <TextInput
          autoFocus
          multiline
          value={text}
          onChangeText={(t) => {
            typed.current = true;
            setText(t);
          }}
          maxLength={2_000}
          placeholder={summarising ? 'Summarising…' : `What should ${name} remember?`}
          placeholderTextColor={colors.textMuted}
          keyboardAppearance={appearance}
          selectionColor={accent.accent}
          accessibilityLabel={`What ${name} should remember`}
          style={styles.input}
        />
        <T variant="caption" color={colors.textSecondary}>
          Added to {name}’s memory, which it reads at the start of every conversation. Edit or
          forget it any time from its sheet.
        </T>
        {!connected && (
          <T variant="small" color={colors.textMuted}>
            Remembering it needs your Mac.
          </T>
        )}
        {error && (
          <T variant="small" color={colors.accentErrorLight}>
            {error}
          </T>
        )}
        <View style={styles.actions}>
          <Button
            title="Cancel"
            variant="ghost"
            onPress={() => router.back()}
            style={{ flex: 1 }}
          />
          <Button
            title="Remember"
            variant="primary"
            busy={busy}
            disabled={!connected || !text.trim()}
            onPress={() => void save()}
            style={{ flex: 1 }}
          />
        </View>
      </View>
    </SheetPage>
  );
}

const useStyles = makeStyles((colors) => ({
  root: { padding: space.lg, paddingTop: space.xl, gap: space.md },
  input: {
    fontFamily: fonts.regular,
    fontSize: type.body,
    color: colors.textBody,
    backgroundColor: colors.inputFill,
    borderRadius: radius.inner,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.inputBorder,
    padding: space.md,
    minHeight: 96,
    textAlignVertical: 'top',
  },
  actions: { flexDirection: 'row', gap: space.sm },
}));

/** A throw while drawing stays on this screen, with the way back. */
export { ScreenError as ErrorBoundary } from '../components/ScreenError';
