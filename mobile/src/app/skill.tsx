/**
 * One skill an agent saved (`agents/skills_learn.rs`): its name, when to use
 * it and its steps, corrected here. Saving goes through `agents.skillEdit`,
 * which cleans it on the Mac as a new one is (personal details and secrets
 * removed) and moves it when its name changes.
 */

import { useLocalSearchParams, useRouter } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, TextInput, View } from 'react-native';
import { KeyboardAwareScrollView } from 'react-native-keyboard-controller';
import { Spinner } from '../components/agent';
import { useSkill } from '../components/skills';
import { Button, T, SheetPage } from '../components/ui';
import { SheetTitle } from '../components/SheetTitle';
import { haptic } from '../lib/haptics';
import { call, describeError } from '../lib/session';
import { useApp } from '../lib/store';
import { useAccent } from '../lib/accent';
import { withAgentAccent } from '../lib/accentScreen';
import { fonts, lineHeight, radius, space, type } from '../lib/theme';
import { makeStyles, useAppearance, useColors } from '../lib/appearance';
import { useComputer } from '../lib/computer';

export default withAgentAccent(SkillPage);

function SkillPage() {
  const comp = useComputer();
  const colors = useColors();
  const styles = useStyles();
  const appearance = useAppearance();
  const accent = useAccent();
  const router = useRouter();
  const { id, slug } = useLocalSearchParams<{ id: string; slug: string }>();
  const connected = useApp((s) => s.link.kind === 'connected');
  const reading = useSkill(id, slug);
  const skill = reading.kind === 'read' ? reading.skill : null;
  // Filled from the skill once it's read; until then, empty.
  const [edited, setEdited] = useState<{ name?: string; when?: string; steps?: string }>({});
  const name = edited.name ?? skill?.name ?? '';
  const when = edited.when ?? skill?.when ?? '';
  const steps = edited.steps ?? skill?.steps ?? '';
  const setName = (v: string) => setEdited((e) => ({ ...e, name: v }));
  const setWhen = (v: string) => setEdited((e) => ({ ...e, when: v }));
  const setSteps = (v: string) => setEdited((e) => ({ ...e, steps: v }));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = () => {
    setBusy(true);
    setError(null);
    call('agents.skillEdit', { agentId: id, slug, name, when, steps })
      .then(() => {
        haptic.success();
        router.back();
      })
      .catch((e: unknown) => {
        haptic.error();
        setError(describeError(e));
      })
      .finally(() => setBusy(false));
  };

  const changed =
    !!skill && (name !== skill.name || when !== (skill.when ?? '') || steps !== skill.steps);

  // Each field keeps its label once it's filled, as Schedule's What does.
  const field = (value: string, set: (v: string) => void, label: string, multiline = false) => (
    <View style={styles.group}>
      <T variant="caption" color={colors.textMuted} nativeID={`skill-${label}`}>
        {label}
      </T>
      <TextInput
        value={value}
        onChangeText={set}
        multiline={multiline}
        maxLength={multiline ? 6_000 : 300}
        style={[styles.input, multiline && styles.steps]}
        keyboardAppearance={appearance}
        selectionColor={accent.accent}
        accessibilityLabel={label}
        accessibilityLabelledBy={`skill-${label}`}
      />
    </View>
  );

  return (
    <SheetPage>
      <KeyboardAwareScrollView
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
      >
        <SheetTitle
          trailing={
            !!skill && (
              <Button
                title="Save"
                size="compact"
                variant="answer"
                busy={busy}
                disabled={!connected || !changed || !name.trim() || !steps.trim()}
                onPress={save}
              />
            )
          }
        >
          Skill
        </SheetTitle>
        {error && (
          <T variant="small" color={colors.accentErrorLight}>
            {error}
          </T>
        )}
        {reading.kind === 'reading' ? (
          <View style={styles.center}>
            {connected ? (
              <Spinner />
            ) : (
              <T color={colors.textSecondary}>Reading it needs {comp.your}.</T>
            )}
          </View>
        ) : reading.kind === 'failed' ? (
          <T color={colors.textSecondary}>
            {connected
              ? `Couldn’t read it: ${reading.reason}`
              : `Reading it needs ${comp.your}.`}
          </T>
        ) : reading.kind === 'gone' ? (
          <T color={colors.textSecondary}>That skill isn’t there any more.</T>
        ) : (
          <>
            {!connected && (
              <T variant="small" color={colors.textMuted}>
                As it was last read. Changing it needs {comp.your}.
              </T>
            )}
            {field(name, setName, 'Name')}
            {field(when, setWhen, 'When to use it')}
            {field(steps, setSteps, 'Steps', true)}
            <T variant="caption" color={colors.textMuted}>
              Saved on {comp.your} with personal details and secrets taken out.
            </T>
          </>
        )}
      </KeyboardAwareScrollView>
    </SheetPage>
  );
}

const useStyles = makeStyles((colors) => ({
  content: { padding: space.lg, paddingTop: space.xl, gap: space.md, paddingBottom: space['2xl'] },
  group: { gap: space.xs },
  center: { paddingVertical: space.xl, alignItems: 'center' },
  input: {
    color: colors.textBody,
    fontSize: type.body,
    padding: space.md,
    borderRadius: radius.card,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.inputBorder,
    backgroundColor: colors.inputFill,
  },
  steps: {
    fontFamily: fonts.mono,
    fontSize: type.small,
    lineHeight: lineHeight(type.small, 1.5),
    minHeight: 220,
    textAlignVertical: 'top',
  },
}));

/** A throw while drawing stays on this screen, with the way back. */
export { ScreenError as ErrorBoundary } from '../components/ScreenError';
