/**
 * The message field. What it will do is always on the button, never hidden
 * behind a gesture:
 *
 * - idle: the mic and **Send**;
 * - working, nothing typed: **Stop**, in place of the mic;
 * - working, with text: Stop and **Send**, which queues (the hint says it
 *   reads it when this turn ends), with **Send now** (interrupt, then send)
 *   in the hint row. Two controls in the field at most, never three;
 * - waiting on your OK: Send queues, and no Stop: the card above is the control;
 * - offline: **Send** waits for the Mac (outbox.ts), and says so;
 * - dictating: the field listens (lib/dictation.ts). The words stream into
 *   it, the last few lighter while the recognizer decides, at the field's
 *   full width and wrapping as typing does; the waveform and the time ride
 *   in a slim row over the field (never beside the words), × takes the +'s
 *   place, and two
 *   controls sit in the field, as Grok's dictation has them: **Stop** puts
 *   the words in the field to read and edit (as a few seconds of silence
 *   does), **Send** stops and sends what's on screen at once. × puts the
 *   draft back as it was. Nothing is sent unless you press Send. The
 *   keyboard steps away while it listens and comes back after if it was up;
 *   tapping the words is Stop and edit.
 *
 * The field, the + and the × are the system's glass (Glass.tsx) where the
 * phone has it, as the tab bar is; a theme surface where it doesn't.
 *
 * What's typed, quoted, @mentioned and attached is the chat's draft
 * (drafts.ts): it survives leaving the chat and restarting the app. Files
 * attach from the camera, Photos or Files and upload at once, so Send has
 * nothing to wait on; once uploaded they're part of the draft, for as long
 * as the Mac keeps them.
 */

import { MAX_ATTACHMENTS, type Agent, type AgentRef } from '@shipstudio/companion-protocol';
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
  Keyboard,
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  useWindowDimensions,
  type LayoutChangeEvent,
} from 'react-native';
import { dictationHint, listeningNote, problemCopy, useDictation } from '../lib/dictation';
import Animated, {
  FadeIn,
  FadeOut,
  LinearTransition,
  ZoomIn,
  ZoomOut,
  useSharedValue,
} from 'react-native-reanimated';
import { formatElapsed } from '../lib/waveform';
import { Waveform } from './Waveform';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAccent } from '../lib/accent';
import { needsYou } from '../lib/agents';
import { drivenWait } from '../lib/bars';
import { ConversationBars } from './ConversationBars';
import { mentionQuery, sendMode, takeDraft } from '../lib/composer';
import {
  addFile,
  clearComposer,
  expiredFiles,
  liveMentions,
  takeRestored,
  removeFiles,
  setComposer,
  useComposerDraft,
} from '../lib/drafts';
import { admit, pickDocuments, pickPhotos, takePhoto, type PickedFile } from '../lib/files';
import { haptic } from '../lib/haptics';
import { OUTBOX_WAIT_MS } from '../lib/outbox';
import { describeError, send, stop, upload } from '../lib/session';
import { getApp, useApp, useServed } from '../lib/store';
import {
  avatarSize,
  chromeScale,
  composer,
  fonts,
  iconSize,
  radius,
  space,
  type,
  waveform,
  PRESSED,
} from '../lib/theme';
import { makeStyles, useAppearance, useColors } from '../lib/appearance';
import { AgentAvatar } from './agent';
import { Glass } from './Glass';
import { StagedTile, type Staged } from './attachments';
import { choose } from './menu';
import { DISABLED_OPACITY, Icon, useRipple, T } from './ui';

const NONE: Agent[] = [];

/** Past this many characters the placeholder drops the name, so it stays on one line. */
const PLACEHOLDER_NAME_MAX = 22;

export function Composer({
  agent,
  autoFocus,
  connected,
  macName,
  onError,
  onSent,
  onOpenSetup,
  onHeight,
  side = { left: 0, right: 0 },
}: {
  agent: Agent;
  autoFocus?: boolean;
  connected: boolean;
  macName: string;
  onError: (text: string) => void;
  onSent: () => void;
  /** The setup bar's Continue: go to "Setting up your team" in the chat. */
  onOpenSetup?: () => void;
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
  // The Mac's last answer while it's away: "+" stays, disabled, so the field doesn't jump.
  const canAttach = useServed('agents.files');
  const team = useApp((s) => s.overview?.agents ?? NONE);
  const seq = useRef(0);
  const input = useRef<ComponentRef<typeof TextInput>>(null);
  const [micHint, setMicHint] = useState<string | null>(null);
  // The draft came back from disk this launch (after a crash, a restart, iOS
  // reclaiming the app): a quiet line says so, once, for a few seconds.
  const [restored, setRestored] = useState(() => takeRestored(agent.id));
  useEffect(() => {
    if (!restored) return;
    const t = setTimeout(() => setRestored(false), 5000);
    return () => clearTimeout(t);
  }, [restored]);
  const vocabulary = useMemo(() => team.map((a) => a.name), [team]);
  const getDraft = useCallback(() => getApp().composer[agent.id]?.text ?? '', [agent.id]);
  const putSpoken = useCallback(
    (text: string) => {
      const mentions = getApp().composer[agent.id]?.mentions ?? [];
      setComposer(agent.id, { text, mentions: liveMentions(text, mentions) });
    },
    [agent.id]
  );
  // The voice's level, 0..1, straight to the UI thread: the waveform reads it there.
  const level = useSharedValue(0);
  const onLevel = useCallback((l: number) => level.set(l), [level]);
  const dictation = useDictation({ getDraft, setDraft: putSpoken, vocabulary, onLevel });
  const listening = dictation.phase !== 'idle';
  const problem = dictation.problem ? problemCopy(dictation.problem) : null;
  // A hint stays a few seconds: it's an answer to a tap, not a state.
  useEffect(() => {
    if (!micHint) return;
    const t = setTimeout(() => setMicHint(null), 5000);
    return () => clearTimeout(t);
  }, [micHint]);
  // A problem stays longer, with its fix beside it, and goes when you type or tap the mic.
  const { clearProblem } = dictation;
  useEffect(() => {
    if (!dictation.problem) return;
    if (dictation.problem !== 'nothing-heard') haptic.error();
    const t = setTimeout(clearProblem, 10_000);
    return () => clearTimeout(t);
  }, [dictation.problem, clearProblem]);
  /** The keyboard was up when the mic was tapped (or the words were): it comes back after. */
  const refocus = useRef(false);
  // The input comes back after every dictation: only the first may pull the keyboard up.
  const [dictated, setDictated] = useState(false);
  useEffect(() => {
    if (listening || !refocus.current) return;
    refocus.current = false;
    // After the field is a text input again.
    const t = setTimeout(() => input.current?.focus(), 0);
    return () => clearTimeout(t);
  }, [listening]);
  const mic = () => {
    const hint = dictationHint(dictation.support);
    if (hint) {
      // No recognizer in this build: the keyboard has one.
      if (dictation.support === 'no-module') input.current?.focus();
      setMicHint(hint);
      return;
    }
    haptic.select();
    setMicHint(null);
    setDictated(true);
    refocus.current = input.current?.isFocused() ?? false;
    Keyboard.dismiss();
    void dictation.start();
  };
  /** Stop: the words stay in the field, to read and edit. */
  const dictationStop = () => {
    haptic.select();
    dictation.stop();
  };
  const dictationCancel = () => {
    haptic.select();
    dictation.cancel();
  };
  /** Tapping the words while it listens: keep them and edit. */
  const editDictation = () => {
    refocus.current = true;
    dictation.stop();
  };
  const fixProblem = () => {
    const fix = problem?.fix;
    clearProblem();
    if (fix === 'settings') void Linking.openSettings();
    else if (fix === 'retry') mic();
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
  const busy = agent.status.state !== 'idle';
  const waitingOnYou = needsYou(agent);
  // Offline, Send still works: it waits for the Mac in the outbox.
  const canSend = hasContent && !blocked;
  // Driven on the Mac: it waits for the hand-back there, and nothing here interrupts it.
  const driven = Boolean(agent.takeover);
  const offerNow = mode === 'queue' && connected && !waitingOnYou && !driven;
  // One chip in the hint row: a dictation problem's fix comes first.
  const fixLabel =
    !listening && problem?.fix === 'settings'
      ? 'Open Settings'
      : !listening && problem?.fix === 'retry'
        ? 'Try again'
        : null;
  const chipNow = offerNow && !fixLabel;

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
    clearProblem();
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
    // From the store, not this render: a second tap in the same frame finds
    // the draft already emptied by the first, and sends nothing.
    const current = takeDraft(getApp().composer[agent.id]);
    if (!current) return;
    if (now) haptic.medium();
    else haptic.light();
    const { body, mentions, files } = current;
    // Words still on their way would land in the emptied draft.
    dictation.drop();
    clearComposer(agent.id);
    setStaged([]);
    onSent();
    send(agent.id, body, now && connected, undefined, files, mentions, draft.revising).catch(
      (error: unknown) => {
        haptic.error();
        onError(describeError(error));
      }
    );
  };

  /** Send while listening: stop, and send what's on screen now. */
  const dictationSend = () => {
    if (!canSend) return;
    dictation.send();
    submit(false);
  };

  const stopTurn = () => {
    haptic.medium();
    stop(agent.id).catch((error: unknown) => {
      haptic.error();
      onError(describeError(error));
    });
  };

  // Driven on the Mac, an import, the link down: the bars above say those, once.
  // Listening says only where the words go when that's off the phone.
  const hint = listening
    ? listeningNote(dictation.via)
    : problem
      ? problem.text
      : micHint
        ? micHint
        : restored
          ? 'Restored your draft'
        : !connected
          ? hasContent
            ? `Send waits up to ${OUTBOX_WAIT_MS / 60_000} min for ${macName}`
            : 'What you type stays here'
          : uploading
            ? `Uploading ${staged.filter((f) => !f.error).length} of ${attached}…`
            : mode === 'queue' && !driven
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
      <ConversationBars
        agent={agent}
        revising={draft.revising}
        onStopRevising={() => setComposer(agent.id, { revising: undefined })}
        onOpenSetup={onOpenSetup}
      />
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
                <AgentAvatar id={a.id} name={a.name} color={a.color} size={avatarSize.group} />
                <T variant="small" color={colors.textPrimary} maxFontSizeMultiplier={chromeScale}>
                  {a.name}
                </T>
              </Pressable>
            ))}
          </ScrollView>
        </Animated.View>
      )}
      {(listening || hint || chipNow || fixLabel) && (
        <Animated.View
          entering={FadeIn.duration(150)}
          exiting={FadeOut.duration(100)}
          layout={LinearTransition.duration(150)}
          style={[styles.hintRow, !canAttach && !listening && { marginLeft: composer.padLeft }]}
        >
          {/* Listening: the waveform and the time ride in this slim row over the
              field, never beside the words, so they keep the field's whole width
              and wrap exactly as typing does. */}
          {listening && (
            <View style={styles.listening} testID="dictation-meter">
              <Waveform level={level} height={waveform.max} />
              <Elapsed since={dictation.startedAt} />
            </View>
          )}
          <T variant="caption" color={colors.textSecondary} style={styles.hint}>
            {hint}
          </T>
          {fixLabel && (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={fixLabel}
              onPress={fixProblem}
              android_ripple={ripple}
              hitSlop={{ top: 10, bottom: 10, left: 6, right: 6 }}
              style={({ pressed }) => [styles.nowChip, pressed && styles.pressed]}
            >
              <T variant="caption" color={colors.textStrong} maxFontSizeMultiplier={chromeScale}>
                {fixLabel}
              </T>
            </Pressable>
          )}
          {chipNow && (
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
                style={({ pressed }) => pressed && PRESSED}
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
        {listening && (
          // In the +'s place, the same circle: nothing in the row moves.
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Cancel dictation"
            accessibilityHint="Puts the message back as it was"
            onPress={dictationCancel}
            hitSlop={4}
          >
            {({ pressed }) => (
              <Animated.View entering={ZoomIn.duration(160)}>
                <Glass
                  interactive
                  style={[
                    field.attach,
                    { width: size.field, height: size.field, borderRadius: size.field / 2 },
                    pressed && field.pressed,
                  ]}
                >
                  <Icon
                    name="xmark"
                    size={iconSize.button}
                    color={colors.textPrimary}
                    fallback={<T>×</T>}
                  />
                </Glass>
              </Animated.View>
            )}
          </Pressable>
        )}
        {canAttach && !listening && (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Attach files"
            disabled={!connected || attached >= MAX_ATTACHMENTS}
            onPress={attach}
            hitSlop={4}
          >
            {({ pressed }) => (
              <Glass
                interactive
                style={[
                  field.attach,
                  { width: size.field, height: size.field, borderRadius: size.field / 2 },
                  (!connected || attached >= MAX_ATTACHMENTS) && field.off,
                  pressed && field.pressed,
                ]}
              >
                <Icon
                  name="plus"
                  size={iconSize.button}
                  color={colors.textPrimary}
                  fallback={<T>+</T>}
                />
              </Glass>
            )}
          </Pressable>
        )}
        <ComposerField
          // A new text size remounts the field, so it never keeps a stale height.
          key={`input-${fontScale}`}
          value={draft.text}
          autoFocus={autoFocus && !dictated}
          onChangeText={setText}
          // One line: a long name ("Recruiting Coordinator for the Platform
          // Team") wrapped the placeholder onto two. The header says who.
          placeholder={
            listening
              ? 'Listening…'
              : agent.name.length > PLACEHOLDER_NAME_MAX
                ? 'Message'
                : `Message ${agent.name}`
          }
          label={`Message ${agent.name}`}
          inputRef={input}
          dictation={listening ? { ...dictation.display, onPress: editDictation } : undefined}
        >
          {listening && (
            <RoundButton
              key="dictation-stop"
              label="Stop dictating"
              hint="Puts what you said in the message, to edit before you send"
              disabled={dictation.phase === 'stopping'}
              onPress={dictationStop}
              tone="quiet"
            >
              <View style={styles.stopSquare} />
            </RoundButton>
          )}
          {listening && (
            <RoundButton
              key="dictation-send"
              label="Send"
              hint="Stops listening and sends what you said"
              disabled={!canSend}
              onPress={dictationSend}
              tone={canSend ? 'accent' : 'off'}
            >
              <Icon
                name="arrow.up"
                size={iconSize.button}
                color={canSend ? accent.onAccent : colors.textMuted}
                fallback={<T color={canSend ? accent.onAccent : colors.textMuted}>↑</T>}
              />
            </RoundButton>
          )}
          {/* While a turn runs the mic steps aside: Stop takes its place, never a third control.
              Driven on the Mac there is no Stop here, so the mic stays. */}
          {!listening && (!busy || driven) && (
            <RoundButton key="mic" label="Dictate" onPress={mic} tone="off">
              <Icon
                name="mic"
                size={iconSize.button}
                color={colors.textSecondary}
                fallback={<T color={colors.textSecondary}>●</T>}
              />
            </RoundButton>
          )}
          {!listening && (mode === 'stop' || (mode === 'queue' && !waitingOnYou && !driven)) && (
            <RoundButton
              key="stop"
              label={`Stop ${agent.name}`}
              disabled={!connected}
              onPress={stopTurn}
              tone="quiet"
            >
              <View style={styles.stopSquare} />
            </RoundButton>
          )}
          {!listening && mode !== 'stop' && (
            <RoundButton
              key="send"
              // Sending while it works queues: the hint above says so, so the button stays an arrow.
              label={
                driven
                  ? `Queue · ${drivenWait(agent.name)}`
                  : mode === 'queue'
                    ? `Queue: ${agent.name} reads it when this turn ends`
                    : connected
                      ? 'Send'
                      : `Send when ${macName} answers`
              }
              disabled={!canSend}
              onPress={() => submit(false)}
              tone={canSend ? 'accent' : 'off'}
            >
              <Icon
                name="arrow.up"
                size={iconSize.button}
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
 * The field itself, shared with a session's and a room's composer: a 48pt
 * glass pill at one line that keeps its 24pt corner as it grows to six, then
 * scrolls inside. Its buttons (`children`) sit inside it at the right, on the
 * last line.
 */
export function ComposerField({
  value,
  onChangeText,
  placeholder,
  label,
  autoFocus,
  editable = true,
  inputRef,
  dictation,
  children,
}: {
  value: string;
  onChangeText: (text: string) => void;
  placeholder: string;
  label: string;
  autoFocus?: boolean;
  editable?: boolean;
  inputRef?: Ref<ComponentRef<typeof TextInput>>;
  /**
   * Listening: the words as they arrive, in place of the input, with the
   * input's exact type and padding so the field keeps its height. What's
   * still being decided is lighter. A tap on them is `onPress`.
   */
  dictation?: { settled: string; deciding: string; onPress: () => void };
  children?: ReactNode;
}) {
  const colors = useColors();
  const field = useFieldStyles();
  const appearance = useAppearance();
  const accent = useAccent();
  const size = useComposerSize();
  const words = useRef<ComponentRef<typeof ScrollView>>(null);
  if (dictation) {
    const empty = !dictation.settled && !dictation.deciding;
    return (
      <Glass style={[field.field, { minHeight: size.field }]}>
        <Pressable
          style={field.words}
          onPress={dictation.onPress}
          accessibilityRole="text"
          accessibilityLabel={
            empty ? 'Listening' : `${label}: ${dictation.settled}${dictation.deciding}`
          }
          accessibilityHint="Double-tap to stop and edit"
          accessibilityLiveRegion="polite"
        >
          <ScrollView
            ref={words}
            style={{ maxHeight: size.maxHeight }}
            scrollEnabled={false}
            showsVerticalScrollIndicator={false}
            // The newest words in view, as the input would keep its cursor.
            onContentSizeChange={() => words.current?.scrollToEnd({ animated: false })}
          >
            <Text maxFontSizeMultiplier={chromeScale} style={field.input}>
              {empty ? (
                <Text style={{ color: colors.textMuted }}>{placeholder}</Text>
              ) : (
                <>
                  {dictation.settled}
                  <Text style={{ color: colors.textSecondary }}>{dictation.deciding}</Text>
                </>
              )}
            </Text>
          </ScrollView>
        </Pressable>
        {children}
      </Glass>
    );
  }
  return (
    <Glass style={[field.field, { minHeight: size.field }]}>
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
    </Glass>
  );
}

/**
 * A 40pt circle inside the field, 4pt in from its edge and its last line, in
 * a 48pt target. Accent glass only when there's something to send; `quiet`
 * is a filled circle (Stop), `off` none.
 */
export function RoundButton({
  label,
  hint,
  disabled,
  onPress,
  tone,
  children,
}: {
  label: string;
  hint?: string;
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
        accessibilityHint={hint}
        accessibilityState={{ disabled: !!disabled }}
        disabled={disabled}
        onPress={onPress}
        hitSlop={composer.inset}
      >
        {({ pressed }) => {
          const look = [
            field.round,
            { width: send, height: send, borderRadius: send / 2 },
            // Disabled reads one way everywhere: as the + beside it does.
            disabled && field.off,
            pressed && field.pressed,
          ];
          return tone === 'accent' ? (
            <Glass interactive tint={accent.accent} style={look}>
              {children}
            </Glass>
          ) : (
            <View
              style={[
                look,
                { backgroundColor: tone === 'quiet' ? colors.surfaceSelected : 'transparent' },
              ]}
            >
              {children}
            </View>
          );
        }}
      </Pressable>
    </Animated.View>
  );
}

/** The time spent listening, beside the waveform: it ticks on the second. */
function Elapsed({ since }: { since: number }) {
  const colors = useColors();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!since) return;
    let t: ReturnType<typeof setTimeout>;
    const tick = () => {
      const at = Date.now();
      setNow(at);
      t = setTimeout(tick, 1000 - ((at - since) % 1000));
    };
    tick();
    return () => clearTimeout(t);
  }, [since]);
  return (
    <T
      variant="caption"
      color={colors.textSecondary}
      maxFontSizeMultiplier={chromeScale}
      style={{ fontVariant: ['tabular-nums'] }}
      accessibilityElementsHidden
      importantForAccessibility="no"
    >
      {formatElapsed(since ? now - since : 0)}
    </T>
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
  const line = composer.fieldLine * k;
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
    borderRadius: composer.fieldCorner,
    paddingLeft: composer.padLeft - StyleSheet.hairlineWidth,
  },
  input: {
    flex: 1,
    fontFamily: fonts.regular,
    fontSize: type.field,
    lineHeight: composer.fieldLine,
    color: colors.textBody,
    // Six lines, then it scrolls inside: the field never takes over the chat.
    maxHeight: composer.fieldLine * composer.maxLines + composer.padV * 2,
    paddingTop: composer.padV - StyleSheet.hairlineWidth,
    paddingBottom: composer.padV - StyleSheet.hairlineWidth,
    paddingRight: composer.padRight,
  },
  roundSlot: { marginRight: composer.inset, marginBottom: composer.inset },
  words: { flex: 1 },
  round: {
    width: composer.send,
    height: composer.send,
    borderRadius: composer.send / 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  attach: {
    width: composer.attach,
    height: composer.attach,
    borderRadius: composer.attach / 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  off: { opacity: DISABLED_OPACITY },
  pressed: { transform: [{ scale: 0.92 }] },
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
    // Under the field's text, as the quote is: past the + and the gap, then the field's inset.
    marginLeft: composer.attach + space.sm + composer.padLeft,
    marginRight: space.xs,
  },
  hint: { flex: 1 },
  // Over the field while it listens: as tall as the waveform at full voice.
  listening: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    minHeight: waveform.max,
  },
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
    width: 14,
    height: 14,
    borderRadius: radius.sm,
    backgroundColor: colors.textPrimary,
  },
}));
