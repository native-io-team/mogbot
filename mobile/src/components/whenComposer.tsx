/**
 * A "When…" routine from the phone: the desk's composer (`AgentWhenRoutine`)
 * in the same words and with the same rules, all from
 * `@shipstudio/companion-protocol` (`whenComposer.ts`). When this happens
 * over the sources, each with how it's checked and what that costs; the one
 * detail a source needs; Check every; What; then the echo ("When someone
 * mentions you on GitHub — Triage it") and what each check costs.
 *
 * Differences, each because it's a phone: a folder is one of the Mac's own
 * (`agents.watch.options`: Downloads, Desktop, Documents, and folders other
 * routines already watch), never a typed path, which the Mac refuses too;
 * the apps a check can read through come from the Mac as well; an email or
 * text routine's sender is typed (the Mac sends no contacts list), checked
 * as the Mac checks it, and whether the Mac can read Mail or Messages is the
 * Mac's own answer (`WatchOptions.mac`): its words name Full Disk Access,
 * which only the Mac can switch on, and Check again asks it again. Everything
 * else, the 12-per-agent cap, the line in the chat and every rule of the
 * check, is the Mac's own (`agents/watch.rs`).
 */

import {
  DEFAULT_WHEN_EVERY,
  describeEvery,
  everyAfterPick,
  shortEvery,
  whenAccess,
  whenApps,
  whenEcho,
  whenFilterOf,
  whenKindReadsMac,
  whenIntervalChoices,
  whenMissing,
  whenNoApps,
  whenReadback,
  whenSourceChoices,
  whenSourceOf,
  WHEN_WORDS,
  type CheckIn,
  type WatchOptions,
  type WhenKind,
} from '@shipstudio/companion-protocol';
import { useCallback, useEffect, useState } from 'react';
import { StyleSheet, TextInput, View } from 'react-native';
import Animated, { FadeIn } from 'react-native-reanimated';
import { describeError, watch } from '../lib/session';
import { WireFailure } from '../lib/transport';
import { useAccent } from '../lib/accent';
import { makeStyles, useAppearance, useColors } from '../lib/appearance';
import { fonts, iconSize, lineHeight, radius, space, type } from '../lib/theme';
import { Chip, ChipRow } from './pickers';
import { Button, Icon, Row, T } from './ui';

/** A Validation error's reason; anything else as the app words it. */
function reasonOf(e: unknown): string {
  return e instanceof WireFailure && e.error.type === 'Validation'
    ? e.error.reason
    : describeError(e);
}

export function WhenComposer({
  agent,
  editing,
  onDone,
  onCancel,
}: {
  agent: { id: string; name: string };
  /** The "When…" routine being edited, or null to add one. */
  editing: CheckIn | null;
  /** Saved. */
  onDone: () => void;
  onCancel: () => void;
}) {
  const colors = useColors();
  const styles = useStyles();
  const appearance = useAppearance();
  const accent = useAccent();
  const start = editing?.watch?.source;
  const startKind: WhenKind = start && start.kind !== 'unknown' ? start.kind : 'github_mentions';
  const [kind, setKind] = useState<WhenKind>(startKind);
  const [folder, setFolder] = useState(start?.kind === 'new_file' ? start.folder : '');
  const [check, setCheck] = useState(start?.kind === 'custom' ? start.check : '');
  const [app, setApp] = useState(start?.kind === 'custom' ? (start.app ?? '') : '');
  const [filter, setFilter] = useState(() => whenFilterOf(start));
  const [every, setEvery] = useState(editing?.watch?.everyMinutes ?? DEFAULT_WHEN_EVERY);
  const [note, setNote] = useState(editing?.note ?? '');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // What the Mac offers this agent: null while it's asked.
  const [options, setOptions] = useState<WatchOptions | null>(null);

  const [asking, setAsking] = useState(false);

  const ask = useCallback(
    (live: () => boolean) =>
      watch.options(agent.id).then(
        (o) => live() && setOptions(o),
        // Nothing offered: Linear and the apps stay out, and a folder can't be picked.
        () => live() && setOptions({ connections: [], claudeApps: [], folders: [] })
      ),
    [agent.id]
  );
  useEffect(() => {
    let live = true;
    void ask(() => live);
    return () => {
      live = false;
    };
  }, [ask]);
  // Check again: the Mac's answer once Full Disk Access is switched on there.
  const askAgain = () => {
    setAsking(true);
    void ask(() => true).finally(() => setAsking(false));
  };

  const found = whenApps(agent.id, options?.connections ?? [], options?.claudeApps ?? []);
  const choices = whenSourceChoices(found.linear || startKind === 'linear_assigned', 'your Mac');
  const intervals = whenIntervalChoices(kind, every);
  const source = whenSourceOf(kind, folder.trim(), check.trim(), app, filter);
  const access = whenAccess(kind, options?.mac);
  const fieldMissing = whenMissing(kind, folder, check, app, filter);
  const missing = fieldMissing ?? access?.words ?? null;
  const folders = options?.folders ?? [];
  const readsMac = whenKindReadsMac(kind);

  const pick = (next: WhenKind) => {
    setKind(next);
    setError(null);
    setEvery(everyAfterPick(kind, next, every));
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      if (editing) await watch.update(agent.id, editing.id, source, every, note.trim());
      else await watch.create(agent.id, source, every, note.trim());
      onDone();
    } catch (e) {
      setError(reasonOf(e));
      setSaving(false);
    }
  };
  const ready = !saving && missing === null && note.trim().length > 0;

  return (
    <>
      <View style={styles.group}>
        <T variant="caption" color={colors.textMuted} style={styles.label}>
          {WHEN_WORDS.source.toUpperCase()}
        </T>
        <View
          style={styles.list}
          accessibilityRole="radiogroup"
          accessibilityLabel={WHEN_WORDS.source}
        >
          {choices.map((s, i) => (
            <Row
              key={s.kind}
              label={s.label}
              detail={s.how}
              selected={kind === s.kind}
              onPress={() => pick(s.kind)}
              trailing={
                kind === s.kind ? (
                  <Icon name="checkmark" size={iconSize.body} color={accent.accent} />
                ) : (
                  <View style={styles.noCheck} />
                )
              }
              last={i === choices.length - 1}
            />
          ))}
        </View>

        {kind === 'new_file' && (
          <Animated.View entering={FadeIn.duration(150)} style={styles.group}>
            {folders.length > 0 ? (
              <ChipRow label="Which folder">
                {folders.map((f) => (
                  <Chip
                    key={f.path}
                    label={f.label}
                    selected={folder === f.path}
                    onPress={() => {
                      setFolder(f.path);
                      setError(null);
                    }}
                  />
                ))}
              </ChipRow>
            ) : null}
            <T variant="caption" color={colors.textMuted}>
              {options === null
                ? 'Asking your Mac for its folders…'
                : folders.length > 0
                  ? 'Folders your Mac offers. For another, set it up on your Mac.'
                  : 'Your Mac offered no folders. Set this one up on your Mac.'}
            </T>
          </Animated.View>
        )}

        {readsMac && (
          <Animated.View entering={FadeIn.duration(150)} style={styles.group}>
            <TextInput
              value={filter.from}
              onChangeText={(t) => setFilter((f) => ({ ...f, from: t.replace(/\n/g, ' ') }))}
              placeholder={
                kind === 'new_mail'
                  ? WHEN_WORDS.mailFromPlaceholder
                  : WHEN_WORDS.textFromPlaceholder
              }
              placeholderTextColor={colors.textMuted}
              style={styles.input}
              selectionColor={accent.accent}
              keyboardAppearance={appearance}
              autoCapitalize="none"
              autoCorrect={false}
              maxLength={200}
              accessibilityLabel="Only from"
            />
            {kind === 'new_mail' && (
              <TextInput
                value={filter.words}
                onChangeText={(t) => setFilter((f) => ({ ...f, words: t.replace(/\n/g, ' ') }))}
                placeholder={WHEN_WORDS.mailWordsPlaceholder}
                placeholderTextColor={colors.textMuted}
                style={styles.input}
                selectionColor={accent.accent}
                keyboardAppearance={appearance}
                maxLength={200}
                accessibilityLabel="Only with these words"
              />
            )}
            {access ? (
              // What the Mac needs, said beside Check again (as on the desk),
              // not under the form.
              <T variant="caption" color={colors.textSecondary}>
                {access.words}
              </T>
            ) : null}
            {access ? (
              <Button
                title={WHEN_WORDS.checkAgain}
                variant="ghost"
                busy={asking}
                onPress={askAgain}
              />
            ) : null}
          </Animated.View>
        )}

        {kind === 'custom' && (
          <Animated.View entering={FadeIn.duration(150)} style={styles.group}>
            <TextInput
              value={check}
              onChangeText={(t) => setCheck(t.replace(/\n/g, ' '))}
              placeholder={WHEN_WORDS.checkPlaceholder}
              placeholderTextColor={colors.textMuted}
              style={styles.input}
              selectionColor={accent.accent}
              keyboardAppearance={appearance}
              maxLength={400}
              multiline
              submitBehavior="blurAndSubmit"
              accessibilityLabel="What to look out for"
            />
            {found.apps.length > 0 ? (
              <>
                <T variant="caption" color={colors.textMuted} style={styles.label}>
                  {WHEN_WORDS.through.toUpperCase()}
                </T>
                <ChipRow label="Which app to check through">
                  {found.apps.map((a) => (
                    <Chip
                      key={a.value}
                      label={a.label}
                      selected={app === a.value}
                      onPress={() => {
                        setApp(a.value);
                        setError(null);
                      }}
                    />
                  ))}
                </ChipRow>
              </>
            ) : (
              options !== null && (
                <T variant="caption" color={colors.textMuted}>
                  {whenNoApps(agent.name)}
                </T>
              )
            )}
          </Animated.View>
        )}

        <T variant="caption" color={colors.textMuted} style={styles.label}>
          {WHEN_WORDS.every.toUpperCase()}
        </T>
        <ChipRow label="How often to check">
          {intervals.map((m) => (
            <Chip
              key={m}
              label={shortEvery(m)}
              accessibilityLabel={describeEvery(m)}
              selected={every === m}
              onPress={() => setEvery(m)}
            />
          ))}
        </ChipRow>
      </View>

      <View style={styles.group}>
        <T variant="caption" color={colors.textMuted} style={styles.label} nativeID="when-what">
          {WHEN_WORDS.what.toUpperCase()}
        </T>
        <TextInput
          value={note}
          onChangeText={(t) => setNote(t.replace(/\n/g, ' '))}
          placeholder={WHEN_WORDS.whatPlaceholder}
          placeholderTextColor={colors.textMuted}
          style={styles.input}
          selectionColor={accent.accent}
          keyboardAppearance={appearance}
          returnKeyType="done"
          maxLength={600}
          multiline
          submitBehavior="blurAndSubmit"
          onSubmitEditing={() => ready && void save()}
          accessibilityLabel="What to do when it happens"
          accessibilityLabelledBy="when-what"
        />
      </View>

      <View style={styles.echo} accessibilityLiveRegion="polite">
        {missing === null && (
          <T variant="subhead" color={colors.textStrong} maxFontSizeMultiplier={2}>
            {whenEcho(agent.name, source, note)}
          </T>
        )}
        {error ? (
          <T variant="small" color={colors.accentErrorLight}>
            {error}
          </T>
        ) : (
          <T variant="caption" color={colors.textSecondary}>
            {fieldMissing ?? (access ? '' : whenReadback(agent.name, source, every))}
          </T>
        )}
      </View>

      <View style={styles.actions}>
        <Button title="Cancel" variant="ghost" onPress={onCancel} style={{ flex: 1 }} />
        <Button
          title={editing ? 'Save' : 'Add'}
          variant="answer"
          disabled={!ready}
          busy={saving}
          onPress={() => void save()}
          style={{ flex: 1 }}
        />
      </View>
    </>
  );
}

const useStyles = makeStyles((colors) => ({
  group: { gap: space.sm },
  label: { letterSpacing: 0.4 },
  list: { backgroundColor: colors.surfaceGroup, borderRadius: radius.card, overflow: 'hidden' },
  noCheck: { width: iconSize.body },
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
    minHeight: 48,
  },
  echo: {
    gap: space.xs,
    padding: space.md,
    borderRadius: radius.card,
    backgroundColor: colors.surfaceGroup,
    minHeight: 64,
    overflow: 'hidden',
  },
  actions: { flexDirection: 'row', gap: space.sm },
}));
