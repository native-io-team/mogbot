/**
 * The message field. What it will do is always on the button, never hidden
 * behind a gesture:
 *
 * - idle: **Send**;
 * - working, nothing typed: **Stop**;
 * - working, with text: **Queue** (it reads it when this turn ends), with
 *   **Send now** (interrupt, then send) and Stop beside it;
 * - waiting on your OK: **Queue**, and no Stop: the card above is the control;
 * - offline: **Send** waits for the Mac (outbox.ts), and says so.
 *
 * What's typed, quoted, @mentioned and attached is the chat's draft
 * (drafts.ts): it survives leaving the chat and restarting the app. Files
 * attach from the camera, Photos or Files and upload at once, so Send has
 * nothing to wait on; once uploaded they're part of the draft, for as long
 * as the Mac keeps them.
 */

import {
  MAX_ATTACHMENTS,
  withQuotes,
  type Agent,
  type AgentRef,
} from '@shipstudio/companion-protocol';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentRef,
  type ReactNode,
  type Ref,
} from 'react';
import {
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
  useWindowDimensions,
  type LayoutChangeEvent,
} from 'react-native';
import { dictationHint, useDictation } from '../lib/dictation';
import Animated, {
  FadeIn,
  FadeOut,
  LinearTransition,
  ZoomIn,
  ZoomOut,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAccent } from '../lib/accent';
import { drivenHint, needsYou } from '../lib/agents';
import { mentionQuery, sendMode } from '../lib/composer';
import {
  addFile,
  clearComposer,
  expiredFiles,
  liveMentions,
  removeFiles,
  setComposer,
  useComposerDraft,
} from '../lib/drafts';
import { admit, pickDocuments, pickPhotos, takePhoto, type PickedFile } from '../lib/files';
import { haptic } from '../lib/haptics';
import { OUTBOX_WAIT_MS } from '../lib/outbox';
import { canCall, describeError, send, stop, upload } from '../lib/session';
import { getApp, useApp } from '../lib/store';
import {
  avatarSize,
  chromeScale,
  composer,
  fonts,
  iconSize,
  radius,
  space,
  type,
} from '../lib/theme';
import { makeStyles, useAppearance, useColors } from '../lib/appearance';
import { AgentAvatar } from './agent';
import { StagedTile, type Staged } from './attachments';
import { choose } from './menu';
import { Icon, useRipple, T } from './ui';

const NONE: Agent[] = [];

export function Composer({
  agent,
  autoFocus,
  connected,
  macName,
  onError,
  onSent,
  onHeight,
  side = { left: 0, right: 0 },
}: {
  agent: Agent;
  autoFocus?: boolean;
  connected: boolean;
  macName: string;
  onError: (text: string) => void;
  onSent: () => void;
  onHeight?: (h: number) => void;
  /** Kept clear at each side: a phone in landscape has its notch there. */
  side?: { left: number; right: number };
}) {
  const colors = useColors();
  const styles = useStyles();
  const field = useFieldStyles();
  const size = useComposerSize();
  const ripple = useRipple();
  const accent = useAccent();
  const insets = useSafeAreaInsets();
  const { fontScale } = useWindowDimensions();
  const draft = useComposerDraft(agent.id);
  const [staged, setStaged] = useState<Staged[]>([]);
  const canAttach = useApp((s) => canCall('agents.files', s.welcome));
  const team = useApp((s) => s.overview?.agents ?? NONE);
  const seq = useRef(0);
  const input = useRef<ComponentRef<typeof TextInput>>(null);
  const [micHint, setMicHint] = useState<string | null>(null);
  const vocabulary = useMemo(() => team.map((a) => a.name), [team]);
  const getDraft = useCallback(() => getApp().composer[agent.id]?.text ?? '', [agent.id]);
  const putSpoken = useCallback(
    (text: string) => {
      const mentions = getApp().composer[agent.id]?.mentions ?? [];
      setComposer(agent.id, { text, mentions: liveMentions(text, mentions) });
    },
    [agent.id]
  );
  const dictation = useDictation({ getDraft, setDraft: putSpoken, vocabulary, onProblem: onError });
  const listening = dictation.phase !== 'idle';
  // A hint stays a few seconds: it's an answer to a tap, not a state.
  useEffect(() => {
    if (!micHint) return;
    const t = setTimeout(() => setMicHint(null), 5000);
    return () => clearTimeout(t);
  }, [micHint]);
  const mic = () => {
    if (listening) {
      haptic.select();
      dictation.stop();
      return;
    }
    const hint = dictationHint(dictation.support);
    if (hint) {
      // No recognizer in this build: the keyboard has one.
      if (dictation.support === 'no-module') input.current?.focus();
      setMicHint(hint);
      return;
    }
    haptic.select();
    void dictation.start();
  };

  const ready = draft.files ?? [];
  const uploading = staged.some((f) => !f.error);
  const attached = ready.length + staged.length;
  const hasContent = draft.text.trim().length > 0 || draft.quotes.length > 0 || ready.length > 0;

  // A draft's files from over an hour ago are gone from the Mac: say so, once.
  useEffect(() => {
    const old = expiredFiles(draft);
    if (!old.length) return;
    removeFiles(
      agent.id,
      old.map((f) => f.blobId)
    );
    onError(
      old.length === 1
        ? `${old[0].name} waited over an hour, so ${macName} let it go. Attach it again.`
        : `${old.length} files waited over an hour, so ${macName} let them go. Attach them again.`
    );
    // Once per chat opened: the draft's files only shrink from here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agent.id]);
  const blocked = uploading || staged.some((f) => f.error);
  const mode = sendMode(agent, hasContent);
  const waitingOnYou = needsYou(agent);
  // Offline, Send still works: it waits for the Mac in the outbox.
  const canSend = hasContent && !blocked;
  // Driven on the Mac: it waits for the hand-back there, and nothing here interrupts it.
  const driven = Boolean(agent.takeover);
  const offerNow = mode === 'queue' && connected && !waitingOnYou && !driven;

  const query = mentionQuery(draft.text);
  const suggestions = useMemo(() => {
    if (query == null) return NONE;
    const q = query.toLowerCase();
    return team
      .filter((a) => a.id !== agent.id && !a.hidden && a.name.toLowerCase().startsWith(q))
      .slice(0, 5);
  }, [query, team, agent.id]);

  const patch = (key: string, change: Partial<Staged>) =>
    setStaged((list) => list.map((f) => (f.key === key ? { ...f, ...change } : f)));

  // Uploaded: it moves from this screen's list into the draft, which keeps it.
  const start = (item: Staged) =>
    upload(item.file, (progress) => patch(item.key, { progress }))
      .then((ref) => {
        addFile(agent.id, {
          blobId: ref.blobId,
          uri: item.file.uri,
          name: ref.name,
          mime: ref.mime,
          size: ref.size,
          stagedAt: Date.now(),
        });
        setStaged((list) => list.filter((f) => f.key !== item.key));
      })
      .catch((error: unknown) => patch(item.key, { error: describeError(error) }));

  const add = (files: PickedFile[]) => {
    const { kept, refused } = admit(files, MAX_ATTACHMENTS - attached);
    if (refused) onError(refused);
    const items = kept.map((file) => ({ key: `f${seq.current++}`, file, progress: 0 }));
    setStaged((list) => [...list, ...items]);
    items.forEach((item) => void start(item));
  };

  const attach = () =>
    choose(undefined, [
      {
        label: 'Take Photo',
        run: () => void takePhoto().then(add, (e: Error) => onError(e.message)),
      },
      {
        label: 'Photo Library',
        run: () =>
          void pickPhotos(MAX_ATTACHMENTS - attached).then(add, (e: Error) => onError(e.message)),
      },
      {
        label: 'Choose File',
        run: () => void pickDocuments().then(add, (e: Error) => onError(e.message)),
      },
    ]);

  const setText = (text: string) => {
    // A keystroke while the mic listens stops it, so the next words it hears
    // can't overwrite what you just typed.
    if (dictation.typed()) setMicHint('Dictation stopped so you can type. Tap the mic to go on.');
    setComposer(agent.id, { text, mentions: liveMentions(text, draft.mentions) });
  };

  const pickMention = (peer: AgentRef) => {
    const text = draft.text.replace(/@[\w.-]*$/, `@${peer.name} `);
    const mentions = draft.mentions.some((m) => m.id === peer.id)
      ? draft.mentions
      : [...draft.mentions, { id: peer.id, name: peer.name }];
    setComposer(agent.id, { text, mentions });
    haptic.select();
  };

  const submit = (now: boolean) => {
    if (!canSend) return;
    if (now) haptic.medium();
    else haptic.light();
    const body = withQuotes(draft.quotes, draft.text.trim());
    const mentions = liveMentions(draft.text, draft.mentions).map((m) => m.id);
    const files = ready.map(({ stagedAt: _at, ...f }) => f);
    // Words still on their way would land in the emptied draft.
    dictation.cancel();
    clearComposer(agent.id);
    setStaged([]);
    onSent();
    send(agent.id, body, now && connected, undefined, files, mentions).catch((error: unknown) => {
      haptic.error();
      onError(describeError(error));
    });
  };

  const stopTurn = () => {
    haptic.medium();
    stop(agent.id).catch((error: unknown) => {
      haptic.error();
      onError(describeError(error));
    });
  };

  const hint = listening
    ? 'Listening on this phone · tap the mic when you’re done'
    : micHint
      ? micHint
      : driven
        ? drivenHint()
        : !connected
          ? hasContent
            ? `Not connected · Send waits up to ${OUTBOX_WAIT_MS / 60_000} min for ${macName}`
            : 'Not connected · what you type stays here'
          : uploading
            ? `Uploading ${staged.filter((f) => !f.error).length} of ${attached}…`
            : mode === 'queue'
              ? waitingOnYou
                ? `${agent.name} reads it after you answer above`
                : `${agent.name} reads it when this turn ends`
              : null;

  return (
    <View
      style={[
        styles.wrap,
        {
          paddingBottom: Math.max(insets.bottom, space.sm),
          paddingLeft: space.lg + side.left,
          paddingRight: space.lg + side.right,
        },
      ]}
      onLayout={(e: LayoutChangeEvent) => onHeight?.(e.nativeEvent.layout.height)}
    >
      {suggestions.length > 0 && (
        <Animated.View entering={FadeIn.duration(120)} exiting={FadeOut.duration(100)}>
          <ScrollView
            horizontal
            keyboardShouldPersistTaps="always"
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.suggestions}
          >
            {suggestions.map((a) => (
              <Pressable
                key={a.id}
                accessibilityRole="button"
                accessibilityLabel={`Mention ${a.name}`}
                android_ripple={ripple}
                onPress={() => pickMention(a)}
                style={({ pressed }) => [styles.suggestion, pressed && styles.pressed]}
              >
                <AgentAvatar name={a.name} color={a.color} size={avatarSize.group} />
                <T variant="small" color={colors.textPrimary} maxFontSizeMultiplier={chromeScale}>
                  {a.name}
                </T>
              </Pressable>
            ))}
          </ScrollView>
        </Animated.View>
      )}
      {(hint || offerNow) && (
        <Animated.View
          entering={FadeIn.duration(150)}
          exiting={FadeOut.duration(100)}
          layout={LinearTransition.duration(150)}
          style={styles.hintRow}
        >
          <T variant="caption" color={colors.textSecondary} style={styles.hint}>
            {hint}
          </T>
          {offerNow && (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Send now: interrupt ${agent.name} and send`}
              disabled={!canSend}
              onPress={() => submit(true)}
              android_ripple={ripple}
              hitSlop={{ top: 10, bottom: 10, left: 6, right: 6 }}
              style={({ pressed }) => [styles.nowChip, pressed && styles.pressed]}
            >
              <T variant="caption" color={colors.textStrong} maxFontSizeMultiplier={chromeScale}>
                Send now
              </T>
            </Pressable>
          )}
        </Animated.View>
      )}
      {draft.quotes.length > 0 && (
        <View style={styles.quotes}>
          {draft.quotes.map((q, i) => (
            <Animated.View
              key={q}
              entering={FadeIn.duration(150)}
              exiting={FadeOut.duration(100)}
              layout={LinearTransition.duration(150)}
              style={styles.quote}
            >
              <T variant="small" color={colors.textSecondary} numberOfLines={2} style={{ flex: 1 }}>
                {q}
              </T>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Remove quote"
                hitSlop={16}
                onPress={() =>
                  setComposer(agent.id, { quotes: draft.quotes.filter((_, j) => j !== i) })
                }
              >
                <Icon
                  name="xmark"
                  size={iconSize.inline}
                  color={colors.textMuted}
                  fallback={<T>×</T>}
                />
              </Pressable>
            </Animated.View>
          ))}
        </View>
      )}
      {attached > 0 && (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.tray}
          keyboardShouldPersistTaps="handled"
        >
          {ready.map((f) => (
            <Animated.View
              key={f.blobId}
              entering={ZoomIn.duration(160)}
              exiting={ZoomOut.duration(120)}
              layout={LinearTransition.duration(160)}
            >
              <StagedTile
                item={{ key: f.blobId, file: f, progress: 1, blob: f }}
                onRemove={() => removeFiles(agent.id, [f.blobId])}
                onRetry={() => {}}
              />
            </Animated.View>
          ))}
          {staged.map((f) => (
            <Animated.View
              key={f.key}
              entering={ZoomIn.duration(160)}
              exiting={ZoomOut.duration(120)}
              layout={LinearTransition.duration(160)}
            >
              <StagedTile
                item={f}
                onRemove={() => setStaged((list) => list.filter((x) => x.key !== f.key))}
                onRetry={() => {
                  patch(f.key, { error: undefined, progress: 0 });
                  void start(f);
                }}
              />
            </Animated.View>
          ))}
        </ScrollView>
      )}
      <View style={styles.row}>
        {canAttach && (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Attach files"
            disabled={!connected || attached >= MAX_ATTACHMENTS}
            onPress={attach}
            hitSlop={4}
          >
            {({ pressed }) => (
              <View
                style={[
                  field.attach,
                  { width: size.field, height: size.field, borderRadius: size.field / 2 },
                  (!connected || attached >= MAX_ATTACHMENTS) && field.off,
                  pressed && { backgroundColor: colors.surfaceControlHover },
                ]}
              >
                <Icon
                  name="plus"
                  size={iconSize.body}
                  color={colors.textPrimary}
                  fallback={<T>+</T>}
                />
              </View>
            )}
          </Pressable>
        )}
        <ComposerField
          // A new text size remounts the field, so it never keeps a stale height.
          key={`input-${fontScale}`}
          value={draft.text}
          autoFocus={autoFocus}
          onChangeText={setText}
          placeholder={listening ? 'Listening…' : `Message ${agent.name}`}
          label={`Message ${agent.name}`}
          inputRef={input}
        >
          <RoundButton
            key="mic"
            label={listening ? 'Stop dictating' : 'Dictate'}
            onPress={mic}
            tone={listening ? 'accent' : 'off'}
          >
            <Icon
              name={listening ? 'mic.fill' : 'mic'}
              size={iconSize.body}
              color={listening ? accent.onAccent : colors.textSecondary}
              fallback={<T color={colors.textSecondary}>●</T>}
            />
          </RoundButton>
          {mode === 'queue' && !waitingOnYou && !driven && (
            <RoundButton
              label={`Stop ${agent.name}`}
              disabled={!connected}
              onPress={stopTurn}
              tone="quiet"
            >
              <View style={styles.stopSquare} />
            </RoundButton>
          )}
          {mode === 'stop' ? (
            <RoundButton
              key="stop"
              label={`Stop ${agent.name}`}
              disabled={!connected}
              onPress={stopTurn}
              tone="quiet"
            >
              <View style={styles.stopSquare} />
            </RoundButton>
          ) : mode === 'queue' ? (
            <Animated.View key="queue" entering={ZoomIn.duration(160)} style={field.roundSlot}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Queue: ${agent.name} reads it when this turn ends`}
                disabled={!canSend}
                onPress={() => submit(false)}
                hitSlop={8}
              >
                {({ pressed }) => (
                  <View
                    style={[
                      field.queue,
                      { height: size.send, borderRadius: size.send / 2 },
                      { backgroundColor: accent.accent },
                      !canSend && field.off,
                      pressed && { transform: [{ scale: 0.95 }] },
                    ]}
                  >
                    <T
                      variant="small"
                      color={accent.onAccent}
                      style={{ fontFamily: fonts.medium }}
                      maxFontSizeMultiplier={chromeScale}
                    >
                      Queue
                    </T>
                    <Icon name="arrow.up" size={iconSize.inline} color={accent.onAccent} />
                  </View>
                )}
              </Pressable>
            </Animated.View>
          ) : (
            <RoundButton
              key="send"
              label={connected ? 'Send' : `Send when ${macName} answers`}
              disabled={!canSend}
              onPress={() => submit(false)}
              tone={canSend ? 'accent' : 'off'}
            >
              <Icon
                name="arrow.up"
                size={iconSize.body}
                color={canSend ? accent.onAccent : colors.textMuted}
                fallback={<T color={canSend ? accent.onAccent : colors.textMuted}>↑</T>}
              />
            </RoundButton>
          )}
        </ComposerField>
      </View>
    </View>
  );
}

/**
 * The field itself, shared with a session's composer: a 36pt pill at one
 * line that keeps its 18pt corner as it grows to six, then scrolls inside.
 * Its buttons (`children`) sit inside it at the right, on the last line.
 */
export function ComposerField({
  value,
  onChangeText,
  placeholder,
  label,
  autoFocus,
  editable = true,
  inputRef,
  children,
}: {
  value: string;
  onChangeText: (text: string) => void;
  placeholder: string;
  label: string;
  autoFocus?: boolean;
  editable?: boolean;
  inputRef?: Ref<ComponentRef<typeof TextInput>>;
  children?: ReactNode;
}) {
  const colors = useColors();
  const field = useFieldStyles();
  const appearance = useAppearance();
  const accent = useAccent();
  const size = useComposerSize();
  return (
    <View style={[field.field, { minHeight: size.field }]}>
      <TextInput
        ref={inputRef}
        maxFontSizeMultiplier={chromeScale}
        value={value}
        autoFocus={autoFocus}
        editable={editable}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={colors.textMuted}
        multiline
        style={[field.input, { maxHeight: size.maxHeight }]}
        selectionColor={accent.accent}
        keyboardAppearance={appearance}
        accessibilityLabel={label}
      />
      {children}
    </View>
  );
}

/**
 * A 28pt circle inside the field, 4pt in from its edge and its last line, in
 * a 44pt target. Filled with the accent only when there's something to send.
 */
export function RoundButton({
  label,
  disabled,
  onPress,
  tone,
  children,
}: {
  label: string;
  disabled?: boolean;
  onPress: () => void;
  tone: 'accent' | 'quiet' | 'off';
  children: ReactNode;
}) {
  const colors = useColors();
  const field = useFieldStyles();
  const accent = useAccent();
  const { send } = useComposerSize();
  return (
    <Animated.View entering={ZoomIn.duration(160)} style={field.roundSlot}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityState={{ disabled: !!disabled }}
        disabled={disabled}
        onPress={onPress}
        hitSlop={8}
      >
        {({ pressed }) => (
          <View
            style={[
              field.round,
              { width: send, height: send, borderRadius: send / 2 },
              {
                backgroundColor:
                  tone === 'accent'
                    ? accent.accent
                    : tone === 'quiet'
                      ? colors.surfaceSelected
                      : 'transparent',
              },
              disabled && tone !== 'off' && field.off,
              pressed && { transform: [{ scale: 0.92 }] },
            ]}
          >
            {children}
          </View>
        )}
      </Pressable>
    </Animated.View>
  );
}

/** The + is exactly as tall as a one-line field. */
export const FIELD_MIN = composer.height;

/**
 * The field's geometry at the reader's text size. Its words follow Dynamic
 * Type only as far as chrome does (`chromeScale`, as iMessage caps its own),
 * and the field, the + and send grow with them in step, so one line stays a
 * pill with its buttons on it at every size.
 */
export function useComposerSize() {
  const { fontScale } = useWindowDimensions();
  const k = Math.min(Math.max(fontScale, 1), chromeScale);
  const line = composer.line * k;
  const field = Math.round(line + composer.padV * 2);
  return {
    field,
    maxHeight: Math.round(line * composer.maxLines + composer.padV * 2),
    send: field - composer.inset * 2,
  };
}

const useFieldStyles = makeStyles((colors) => ({
  field: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'flex-end',
    minHeight: FIELD_MIN,
    backgroundColor: colors.composerFill,
    borderRadius: composer.corner,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.composerBorder,
    paddingLeft: composer.padLeft - StyleSheet.hairlineWidth,
  },
  input: {
    flex: 1,
    fontFamily: fonts.regular,
    fontSize: type.body,
    lineHeight: composer.line,
    color: colors.textBody,
    // Six lines, then it scrolls inside: the field never takes over the chat.
    maxHeight: composer.line * composer.maxLines + composer.padV * 2,
    paddingTop: composer.padV - StyleSheet.hairlineWidth,
    paddingBottom: composer.padV - StyleSheet.hairlineWidth,
    paddingRight: composer.padRight,
  },
  roundSlot: { marginRight: composer.inset, marginBottom: composer.inset },
  round: {
    width: composer.send,
    height: composer.send,
    borderRadius: composer.send / 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  queue: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs,
    height: composer.send,
    paddingHorizontal: space.md,
    borderRadius: composer.send / 2,
  },
  attach: {
    width: composer.attach,
    height: composer.attach,
    borderRadius: composer.attach / 2,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.composerFill,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.composerBorder,
  },
  off: { opacity: 0.4 },
}));

const useStyles = makeStyles((colors) => ({
  wrap: {
    paddingHorizontal: space.lg,
    paddingTop: space.sm,
    backgroundColor: colors.surfaceApp,
    gap: space.sm,
  },
  hintRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    marginLeft: space.md,
    marginRight: space.xs,
  },
  hint: { flex: 1 },
  nowChip: {
    paddingHorizontal: space.md,
    paddingVertical: space.xs,
    borderRadius: radius.pill,
    backgroundColor: colors.surfaceSelected,
    overflow: 'hidden',
  },
  pressed: { backgroundColor: colors.surfaceControlHover },
  suggestions: { gap: space.sm, paddingHorizontal: space.xs },
  suggestion: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    minHeight: 36,
    paddingHorizontal: space.md,
    borderRadius: radius.pill,
    backgroundColor: colors.surfaceControl,
    overflow: 'hidden',
  },
  quotes: { gap: space.xs },
  quote: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    // Its text under the field's: past the + and the gap, less its own rule and inset.
    marginLeft: composer.attach + space.sm + composer.padLeft - space.md - 2,
    marginRight: space.md,
    paddingLeft: space.md,
    paddingVertical: space.xs,
    borderLeftWidth: 2,
    borderLeftColor: colors.borderStrong,
  },
  row: { flexDirection: 'row', alignItems: 'flex-end', gap: space.sm },
  tray: { gap: space.sm, paddingTop: space.tight, paddingHorizontal: space.xs },
  stopSquare: {
    width: 10,
    height: 10,
    borderRadius: radius.sm / 2,
    backgroundColor: colors.textPrimary,
  },
}));
