/**
 * An agent's instructions: read them, and correct them. Saving writes the
 * same brief the desk's Edit agent writes (its memory is kept), and the Mac
 * audits it as an edit from this phone.
 */

import { useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { ScrollView, StyleSheet, TextInput, View } from 'react-native';
import { KeyboardAwareScrollView } from 'react-native-keyboard-controller';
import { Spinner } from '../components/agent';
import { Button, T, SheetPage, groupSurface } from '../components/ui';
import { SheetTitle } from '../components/SheetTitle';
import { haptic } from '../lib/haptics';
import { describeError, readInstructions, setInstructions } from '../lib/session';
import { useApp } from '../lib/store';
import { useRemembered } from '../lib/remembered';
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
  const name = useApp((s) => s.overview?.agents.find((a) => a.id === id)?.name ?? 'This agent');
  const connected = useApp((s) => s.link.kind === 'connected');
  const [saved, setSaved] = useRemembered<string>(`instructions:${id}`);
  const [text, setText] = useState(() => saved ?? '');
  const [fresh, setFresh] = useState(false);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Drawn from the last read at once; read again once per opening, and the
  // words in the field follow it unless they're being edited.
  useEffect(() => {
    if (!connected || fresh) return;
    readInstructions(id).then(
      (t) => {
        setSaved(t);
        setFresh(true);
        if (!editing) setText(t);
      },
      (e: unknown) => setError(describeError(e))
    );
  }, [id, connected, fresh, editing, setSaved]);

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
        {saved !== null && !connected && (
          <T variant="small" color={colors.textMuted}>
            As they were last read. Changing them needs your Mac.
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
          <T
            selectable
            style={[styles.body, styles.read]}
            color={saved ? colors.textPrimary : colors.textMuted}
          >
            {saved || 'No instructions yet.'}
          </T>
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
    overflow: 'hidden',
  },
  // Read, it's a group like the agent sheet's: the same fill, hairline and lift.
  read: groupSurface(colors),
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
