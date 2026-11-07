/**
 * An agent's instructions: read them, and correct them. Saving writes the
 * same brief the desk's Edit agent writes (its memory is kept), and the Mac
 * audits it as an edit from this phone.
 */

import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { ScrollView, StyleSheet, TextInput, View } from 'react-native';
import { KeyboardAwareScrollView } from 'react-native-keyboard-controller';
import { Spinner } from '../components/agent';
import { Button, T, SheetPage } from '../components/ui';
import { SheetTitle } from '../components/SheetTitle';
import { haptic } from '../lib/haptics';
import { describeError, readInstructions, setInstructions } from '../lib/session';
import { useApp } from '../lib/store';
import { useAccent } from '../lib/accent';
import { withAgentAccent } from '../lib/accentScreen';
import { fonts, lineHeight, radius, space, type } from '../lib/theme';
import { makeStyles, useAppearance, useColors } from '../lib/appearance';

export default withAgentAccent(Instructions);

function Instructions() {
  const colors = useColors();
  const styles = useStyles();
  const appearance = useAppearance();
  const accent = useAccent();
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const name = useApp((s) => s.overview?.agents.find((a) => a.id === id)?.name ?? 'This agent');
  const connected = useApp((s) => s.link.kind === 'connected');
  const [saved, setSaved] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!connected || saved !== null) return;
    readInstructions(id).then(
      (t) => {
        setSaved(t);
        setText(t);
      },
      (e: unknown) => setError(describeError(e))
    );
  }, [id, connected, saved]);

  const save = () => {
    setBusy(true);
    setError(null);
    setInstructions(id, text)
      .then(() => {
        haptic.success();
        setSaved(text);
        setEditing(false);
      })
      .catch((e: unknown) => {
        haptic.error();
        setError(describeError(e));
      })
      .finally(() => setBusy(false));
  };

  const Scroll = editing ? KeyboardAwareScrollView : ScrollView;
  return (
    <SheetPage>
      <Scroll contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <SheetTitle
          // Closing mid-edit would drop the edit: Cancel and Save are the way out then.
          close={!editing}
          trailing={
            saved !== null &&
            (editing ? (
              <>
                <Button
                  title="Cancel"
                  size="compact"
                  variant="ghost"
                  onPress={() => {
                    setText(saved);
                    setEditing(false);
                  }}
                />
                <Button
                  title="Save"
                  size="compact"
                  variant="primary"
                  busy={busy}
                  disabled={!connected || text === saved}
                  onPress={save}
                />
              </>
            ) : (
              <Button
                title="Edit"
                size="compact"
                disabled={!connected}
                onPress={() => setEditing(true)}
              />
            ))
          }
        >
          Instructions
        </SheetTitle>
        <T variant="small" color={colors.textSecondary}>
          {name} reads these at the start of every conversation.
        </T>
        {error && (
          <T variant="small" color={colors.accentErrorLight}>
            {error}
          </T>
        )}
        {saved === null ? (
          !error && (
            <View style={styles.center}>
              {connected ? (
                <Spinner />
              ) : (
                <T color={colors.textSecondary}>Reading them needs your Mac.</T>
              )}
            </View>
          )
        ) : editing ? (
          <TextInput
            autoFocus
            multiline
            value={text}
            onChangeText={setText}
            maxLength={20_000}
            style={[styles.body, styles.input]}
            keyboardAppearance={appearance}
            selectionColor={accent.accent}
            accessibilityLabel={`${name}’s instructions`}
          />
        ) : (
          <T selectable style={styles.body} color={saved ? colors.textPrimary : colors.textMuted}>
            {saved || 'No instructions yet.'}
          </T>
        )}
        {!editing && saved !== null && (
          <Button title="Done" variant="ghost" onPress={() => router.back()} />
        )}
      </Scroll>
    </SheetPage>
  );
}

const useStyles = makeStyles((colors) => ({
  content: { padding: space.lg, paddingTop: space.xl, gap: space.md, paddingBottom: space['2xl'] },
  head: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  center: { paddingVertical: space.xl, alignItems: 'center' },
  body: {
    fontFamily: fonts.mono,
    fontSize: type.small,
    lineHeight: lineHeight(type.small, 1.5),
    padding: space.md,
    borderRadius: radius.card,
    backgroundColor: colors.surfaceGroup,
    overflow: 'hidden',
  },
  input: {
    color: colors.textBody,
    minHeight: 240,
    textAlignVertical: 'top',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.inputBorder,
    backgroundColor: colors.inputFill,
  },
}));

/** A throw while drawing stays on this screen, with the way back. */
export { ScreenError as ErrorBoundary } from '../components/ScreenError';
