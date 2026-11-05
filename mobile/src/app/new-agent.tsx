/**
 * A new agent, from the phone. One question first, "What should it do?";
 * a name and a colour if you want them (the name otherwise comes from what
 * you wrote, and Create says it before you tap). The Mac makes it with the
 * desk's own create path and engine rule, then its chat opens.
 *
 * Or hand it to the Chief of Staff: your request goes into the Chief's
 * composer, for you to read and send. That's also all an older Mac offers,
 * since it can't create agents for a phone.
 */

import * as Crypto from 'expo-crypto';
import { useRouter } from 'expo-router';
import { useMemo, useRef, useState } from 'react';
import { ScrollView, StyleSheet, TextInput, View } from 'react-native';
import { AgentAvatar } from '../components/agent';
import { ColorSwatches } from '../components/pickers';
import { Button, SheetPage, T } from '../components/ui';
import { AccentProvider, useAccent } from '../lib/accent';
import { makeStyles, useAppearance, useColors } from '../lib/appearance';
import { setComposer } from '../lib/drafts';
import { haptic } from '../lib/haptics';
import {
  chiefOf,
  chiefRequest,
  freeColor,
  MAX_NAME,
  MAX_ROLE,
  suggestAgentName,
} from '../lib/newAgent';
import { canCall, createAgent, describeError } from '../lib/session';
import { useApp } from '../lib/store';
import { avatarSize, fonts, lineHeight, radius, space, type } from '../lib/theme';

export default function NewAgent() {
  const colors = useColors();
  const styles = useStyles();
  const appearance = useAppearance();
  const accent = useAccent();
  const router = useRouter();
  const agents = useApp((s) => s.overview?.agents);
  const engines = useApp((s) => s.overview?.engines);
  const connected = useApp((s) => s.link.kind === 'connected');
  const macName = useApp((s) => s.credentials?.name ?? 'your Mac');
  const canCreate = useApp((s) => canCall('agents.create', s.welcome));
  const chief = chiefOf(agents);
  const taken = useMemo(() => (agents ?? []).map((a) => a.name), [agents]);
  const [role, setRole] = useState('');
  const [name, setName] = useState('');
  const [color, setColor] = useState(() => freeColor((agents ?? []).map((a) => a.color)));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const clientId = useRef(Crypto.randomUUID());

  const suggested = suggestAgentName(role, taken);
  const finalName = name.trim() || suggested || '';
  const engine = defaultEngineLabel(engines);
  const ready = canCreate && connected && !!role.trim() && !!finalName && !busy;

  const create = () => {
    if (!ready) return;
    setBusy(true);
    setError(null);
    haptic.light();
    createAgent({ name: finalName, role: role.trim(), color }, clientId.current)
      .then((stored) => {
        haptic.success();
        router.replace({ pathname: '/chat/[id]', params: { id: stored.id, compose: '1' } });
      })
      .catch((e: unknown) => {
        haptic.error();
        setError(describeError(e));
        setBusy(false);
      });
  };

  const askChief = () => {
    if (!chief) return;
    setComposer(chief.id, { text: chiefRequest(role, name) });
    haptic.select();
    router.replace({ pathname: '/chat/[id]', params: { id: chief.id, compose: '1' } });
  };

  return (
    <SheetPage>
      <ScrollView
        contentContainerStyle={styles.root}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="interactive"
      >
        <T variant="title" color={colors.textStrong} accessibilityRole="header">
          New agent
        </T>
        {!canCreate && (
          <T variant="small" color={colors.textSecondary}>
            The app on {macName} needs updating to create agents from this phone. Your Chief of
            Staff can set one up for you.
          </T>
        )}
        <View style={styles.field}>
          <T variant="subhead" color={colors.textPrimary} nativeID="role-label">
            What should it do?
          </T>
          <TextInput
            autoFocus
            multiline
            value={role}
            onChangeText={(t) => setRole(t.replace(/\n/g, ' '))}
            maxLength={MAX_ROLE}
            placeholder="Keeps my inbox down to what matters"
            placeholderTextColor={colors.textMuted}
            style={[styles.input, styles.roleInput]}
            selectionColor={accent.accent}
            keyboardAppearance={appearance}
            returnKeyType="next"
            submitBehavior="blurAndSubmit"
            accessibilityLabelledBy="role-label"
            accessibilityLabel="What should it do?"
          />
        </View>

        {canCreate && (
          <>
            <View style={styles.identity}>
              <AccentProvider color={color}>
                <AgentAvatar name={finalName || '?'} color={color} size={avatarSize.list} />
              </AccentProvider>
              <TextInput
                value={name}
                onChangeText={setName}
                maxLength={MAX_NAME}
                placeholder={suggested ?? 'Name'}
                placeholderTextColor={colors.textMuted}
                style={[styles.input, styles.nameInput]}
                selectionColor={accent.accent}
                keyboardAppearance={appearance}
                autoCapitalize="words"
                returnKeyType="done"
                onSubmitEditing={create}
                accessibilityLabel="Name"
                accessibilityHint={suggested ? `Leave empty to call it ${suggested}` : undefined}
              />
            </View>
            <ColorSwatches value={color} onChange={setColor} />
            {engine && (
              <T variant="caption" color={colors.textMuted}>
                Runs on {engine} on {macName}, like one made there. Its instructions, model and
                project can be changed on the Mac.
              </T>
            )}
          </>
        )}

        {error && (
          <T variant="small" color={colors.accentErrorLight} accessibilityLiveRegion="polite">
            {error}
          </T>
        )}
        <View style={styles.actions}>
          {canCreate && (
            <AccentProvider color={color}>
              <Button
                title={finalName ? `Create ${finalName}` : 'Create'}
                variant="primary"
                size="large"
                busy={busy}
                disabled={!ready}
                onPress={create}
              />
            </AccentProvider>
          )}
          {chief && (
            <Button
              title={`Ask ${chief.name} instead`}
              variant={canCreate ? 'ghost' : 'primary'}
              size={canCreate ? 'default' : 'large'}
              onPress={askChief}
              accessibilityHint={`Writes your request in ${chief.name}’s chat for you to send`}
            />
          )}
        </View>
        {!connected && canCreate && (
          <T variant="caption" color={colors.textSecondary}>
            Creating an agent needs {macName}.
          </T>
        )}
      </ScrollView>
    </SheetPage>
  );
}

/**
 * The engine a new agent goes on, as the Mac picks it (`engine::default_for`):
 * Claude Code when ready, else the first that is. Null while unknown, so
 * nothing is claimed about a Mac that hasn't said.
 */
function defaultEngineLabel(
  engines: { id: string; label: string; installed: boolean; signedIn: boolean }[] | undefined
): string | null {
  if (!engines?.length) return null;
  const ready = engines.filter((e) => e.installed && e.signedIn);
  return (ready.find((e) => e.id === 'claude') ?? ready[0])?.label ?? null;
}

const useStyles = makeStyles((colors) => ({
  root: { padding: space.lg, paddingTop: space.xl, gap: space.lg, paddingBottom: space['2xl'] },
  field: { gap: space.sm },
  input: {
    fontFamily: fonts.regular,
    fontSize: type.body,
    lineHeight: lineHeight(type.body, 1.35),
    color: colors.textBody,
    backgroundColor: colors.inputFill,
    borderRadius: radius.inner,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.inputBorder,
    paddingHorizontal: space.md,
    paddingVertical: space.md,
  },
  roleInput: { minHeight: 88, textAlignVertical: 'top' },
  nameInput: { flex: 1, minHeight: 48 },
  identity: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  actions: { gap: space.sm },
}));
