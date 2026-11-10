/**
 * The message field. What it will do is always on the button, never hidden
 * behind a gesture:
 *
 * - idle: the mic and **Send** (dimmed until there's something to send);
 * - working: the mic, **Stop** and **Send**. The mic stays, so you can talk
 *   while it works: what you say queues, as what you type does. With words,
 *   Send queues (the line over the field says it reads it when this turn
 *   ends) and **Send now** (interrupt, then send) sits at that line's right;
 * - waiting on your OK: Send queues, and no Stop: the card above is the control;
 * - offline: **Send** waits for the Mac (outbox.ts), and says so;
 * - dictating: the field listens (lib/dictation.ts) and becomes one glass
 *   card, as Claude's own dictation is. On top, the words stream in across
 *   its whole width, the last few lighter while the recognizer decides, with
 *   a caret after them, wrapping as typing does. Under them one row: **×**
 *   puts the draft back as it was, the waveform fills the middle, **Stop**
 *   puts the words in the field to read and edit (as a few seconds of
 *   silence does), **Send** stops and sends what's on screen at once. No +
 *   while it listens. Nothing is sent unless you press Send. The
 *   keyboard steps away while it listens and comes back after if it was up;
 *   tapping the words is Stop and edit.
 * - holding the mic: a voice message. It listens while you hold, the words
 *   streaming into the field, which keeps its shape so the mic stays under
 *   your finger; let go and what it heard is sent; slide away first and
 *   nothing is (lib/dictation.ts, `holdEnds`). The mic is the accent while
 *   it's held.
 *
 * The field is one piece of the system's glass (Glass.tsx) where the phone
 * has it, as the tab bar is; a theme surface where it doesn't. Everything is
 * inside it, as in Claude's own: the + at its left, the mic, Stop and Send at
 * its right. Once the words wrap, or there are files, or it listens, it's a
 * card: files on top, the words across it, the buttons in a row under them
 * (the + and the model chip, which opens Agent controls, left). The line
 * about queueing runs over it, full width, with Send now at its right.
 *
 * What's typed, quoted, @mentioned and attached is the chat's draft
 * (drafts.ts): it survives leaving the chat and restarting the app. Files
 * attach from the camera, Photos or Files and upload at once, so Send has
 * nothing to wait on; once uploaded they're part of the draft, for as long
 * as the Mac keeps them.
 */

import {
  MAC_FEATURES,
  MAX_ATTACHMENTS,
  type Agent,
  type AgentRef,
} from '@shipstudio/companion-protocol';
import {
  Children,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
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
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  useWindowDimensions,
  type GestureResponderEvent,
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';
import {
  HOLD_CANCEL_DISTANCE,
  HOLD_DELAY_MS,
  dictationHint,
  holdEnds,
  listeningNote,
  problemCopy,
  sendsOnRelease,
  useDictation,
  type DictationState,
} from '../lib/dictation';
import Animated, {
  FadeIn,
  FadeOut,
  LinearTransition,
  ZoomIn,
  ZoomOut,
  cancelAnimation,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withSequence,
  withTiming,
} from 'react-native-reanimated';
import { Waveform } from './Waveform';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAccent } from '../lib/accent';
import { needsYou } from '../lib/agents';
import { drivenWait } from '../lib/bars';
import { ConversationBars } from './ConversationBars';
import {
  composerControls,
  fieldIsCard,
  followsEnd,
  mentionQuery,
  sendMode,
  takeDraft,
  type FieldCaret,
} from '../lib/composer';
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
import { useRouter } from 'expo-router';
import { chipLabel } from '../lib/agentControls';
import { OUTBOX_WAIT_MS } from '../lib/outbox';
import { describeError, send, stop, upload } from '../lib/session';
import { getApp, useApp, useServed } from '../lib/store';
import {
  keySize,
  chromeScale,
  composer,
  fonts,
  iconSize,
  radius,
  scaledSize,
  space,
  type,
  PRESSED,
} from '../lib/theme';
import { makeStyles, useAppearance, useColors, useTextScale } from '../lib/appearance';
import { AgentKey } from './AgentKey';
import { Glass, hasLiquidGlass } from './Glass';
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
  const engines = useApp((s) => s.overview?.engines);
  // Only from a Mac that lists its engines: never a name guessed here.
  const chip = useMemo(() => (engines ? chipLabel(agent, engines) : null), [agent, engines]);
  // The chip opens Agent controls on a Mac with something there to change:
  // the model or engine, the effort, or its level (open even mid-turn).
  const switchable = useServed('agents.update', MAC_FEATURES.engine);
  const effortable = useServed('agents.update', MAC_FEATURES.effort);
  const levelable = useServed('agents.setAgentIndependence');
  const router = useRouter();
  const openControls =
    switchable || effortable || levelable
      ? () => router.push({ pathname: '/controls', params: { id: agent.id } })
      : undefined;
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
  /** A voice message: the mic is held (or was, and its last words are landing). */
  const held = listening && dictation.state.held;
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
  const mic = ({ hold = false }: { hold?: boolean } = {}) => {
    const hint = dictationHint(dictation.support);
    if (hint) {
      // No recognizer in this build: the keyboard has one.
      if (dictation.support === 'no-module') input.current?.focus();
      setMicHint(hint);
      return false;
    }
    if (hold) haptic.medium();
    else haptic.select();
    setMicHint(null);
    setDictated(true);
    refocus.current = input.current?.isFocused() ?? false;
    Keyboard.dismiss();
    void dictation.start({ held: hold });
    return true;
  };
  /** Where a hold on the mic began, while it's held. */
  const holdFrom = useRef<{ x: number; y: number } | null>(null);
  const holdStart = (e: GestureResponderEvent) => {
    if (!mic({ hold: true })) return;
    holdFrom.current = { x: e.nativeEvent.pageX, y: e.nativeEvent.pageY };
  };
  /** Let go on the mic: send; slid away from it: nothing is sent. */
  const holdEnd = (e: GestureResponderEvent) => {
    const from = holdFrom.current;
    holdFrom.current = null;
    if (!from) return;
    if (holdEnds(from, { x: e.nativeEvent.pageX, y: e.nativeEvent.pageY }) === 'cancel') {
      haptic.select();
      dictation.cancel();
      return;
    }
    dictation.release();
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
  const controls = composerControls(agent);
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

  // A voice message let go, its words all in: it sends, as Send would. Once per hold.
  const sentHold = useRef<DictationState | null>(null);
  useEffect(() => {
    if (!sendsOnRelease(dictation.state) || sentHold.current === dictation.state) return;
    sentHold.current = dictation.state;
    submit(false);
    // `submit` reads the draft from the store; only the session's end matters here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dictation.state]);

  const stopTurn = () => {
    haptic.medium();
    stop(agent.id).catch((error: unknown) => {
      haptic.error();
      onError(describeError(error));
    });
  };

  // Driven on the Mac, an import, the link down: the bars above say those, once.
  // Listening says only where the words go when that's off the phone.
  const queued =
    mode === 'queue' && !driven
      ? waitingOnYou
        ? `${agent.name} reads it after you answer above`
        : `${agent.name} reads it when this turn ends`
      : null;
  // Listening while it works, the queued line stays, so Send now has its sentence.
  const hint = held
    ? dictation.state.released
      ? 'Sending what you said…'
      : (listeningNote(dictation.via) ?? 'Let go to send · slide away to cancel')
    : listening
      ? (listeningNote(dictation.via) ?? queued)
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
                : queued;

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
                <AgentKey id={a.id} name={a.name} color={a.color} size={keySize.sm} />
                <T variant="small" color={colors.textPrimary} maxFontSizeMultiplier={chromeScale}>
                  {a.name}
                </T>
              </Pressable>
            ))}
          </ScrollView>
        </Animated.View>
      )}
      {(hint || chipNow || fixLabel) && (
        <Animated.View
          entering={FadeIn.duration(150)}
          exiting={FadeOut.duration(100)}
          layout={LinearTransition.duration(150)}
          // Full width over the field, from its left edge to its right.
          style={styles.hintRow}
        >
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
      <View style={styles.row}>
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
          // Held, the field keeps the shape it had, so the mic stays under the finger.
          hold={held}
          // The files ride at the card's top, as Claude's own, each with its ×.
          top={
            attached > 0 ? (
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
            ) : undefined
          }
          // The + inside the field at its left; listening, × has its place.
          leading={
            canAttach && !listening ? (
              <RoundButton
                key="attach"
                label="Attach files"
                disabled={!connected || attached >= MAX_ATTACHMENTS}
                onPress={attach}
                tone="quiet"
              >
                <Icon
                  name="plus"
                  size={iconSize.button}
                  color={colors.textPrimary}
                  fallback={<T>+</T>}
                />
              </RoundButton>
            ) : undefined
          }
          chip={!listening && chip ? <EngineChip {...chip} onPress={openControls} /> : undefined}
        >
          {/* Listening, the card's row: ×, the waveform filling the middle, Stop, Send. */}
          {listening && !held && (
            <RoundButton
              key="dictation-cancel"
              label="Cancel dictation"
              hint="Puts the message back as it was"
              onPress={dictationCancel}
              tone="quiet"
            >
              <Icon
                name="xmark"
                size={iconSize.button}
                color={colors.textPrimary}
                fallback={<T>×</T>}
              />
            </RoundButton>
          )}
          {listening && !held && (
            <Waveform
              key="dictation-waveform"
              level={level}
              height={size.send}
              fill
              style={field.wave}
            />
          )}
          {listening && !held && (
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
          {listening && !held && (
            <RoundButton
              key="dictation-send"
              label="Send"
              hint="Stops listening and sends what you said"
              disabled={!canSend}
              onPress={dictationSend}
              tone="accent"
            >
              <Icon
                name="arrow.up"
                size={iconSize.button}
                color={accent.onAccent}
                fallback={<T color={accent.onAccent}>↑</T>}
              />
            </RoundButton>
          )}
          {/* The mic is always there: dictating while a turn runs queues, as typing does. */}
          {/* Held, it's the same button (same key), so the press carries on. */}
          {(!listening || held) && controls.includes('mic') && (
            <RoundButton
              key="mic"
              label={held ? 'Recording a voice message' : 'Dictate'}
              hint="Hold to talk, and let go to send"
              onPress={() => void mic()}
              onLongPress={holdStart}
              onPressOut={holdEnd}
              tone={held ? 'accent' : 'quiet'}
            >
              <Icon
                name="mic"
                size={iconSize.button}
                color={held ? accent.onAccent : colors.textPrimary}
                fallback={<T color={held ? accent.onAccent : colors.textPrimary}>●</T>}
              />
            </RoundButton>
          )}
          {!listening && controls.includes('stop') && (
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
          {!listening && controls.includes('send') && (
            <RoundButton
              key="send"
              // Sending while it works queues: the line above says so, so the button stays an arrow.
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
              // Dimmed until there's something to send, as Claude's own.
              tone="accent"
            >
              <Icon
                name="arrow.up"
                size={iconSize.button}
                color={accent.onAccent}
                fallback={<T color={accent.onAccent}>↑</T>}
              />
            </RoundButton>
          )}
        </ComposerField>
      </View>
    </View>
  );
}

/**
 * What the next message runs on, in the card's row beside the +: the model
 * ("Opus 5.5"), and its effort lighter after a dot ("· High"), as Claude's
 * own model chip; the engine only when nothing names a model. Only what the
 * Mac said (`lib/agentControls.ts`). A tap opens Agent controls.
 */
function EngineChip({
  main,
  effort,
  says,
  onPress,
}: {
  main: string;
  effort: string | null;
  says: string;
  /** Opens Agent controls; absent on a Mac with nothing to change there. */
  onPress?: () => void;
}) {
  const field = useFieldStyles();
  const { send } = useComposerSize();
  const shape = [field.chip, { height: send, borderRadius: send / 2 }];
  if (!onPress) {
    return (
      <View accessible accessibilityRole="text" accessibilityLabel={says} style={shape}>
        <EngineWords main={main} effort={effort} />
      </View>
    );
  }
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={says}
      accessibilityHint="Opens Agent controls: model, effort and independence"
      onPress={() => {
        haptic.light();
        onPress();
      }}
      style={({ pressed }) => [shape, pressed ? PRESSED : null]}
    >
      <EngineWords main={main} effort={effort} caret />
    </Pressable>
  );
}

function EngineWords({
  main,
  effort,
  caret,
}: {
  main: string;
  effort: string | null;
  caret?: boolean;
}) {
  const colors = useColors();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.xs }}>
      <T
        variant="small"
        color={colors.textPrimary}
        numberOfLines={1}
        style={{ flexShrink: 1 }}
        maxFontSizeMultiplier={chromeScale}
      >
        {main}
        {effort ? <T variant="small" color={colors.textMuted}>{` · ${effort}`}</T> : null}
      </T>
      {caret ? (
        <Icon
          name="chevron.down"
          size={iconSize.inline}
          color={colors.textMuted}
          fallback={<T variant="small">▾</T>}
        />
      ) : null}
    </View>
  );
}

/**
 * The field itself, shared with a session's and a room's composer, shaped as
 * Claude's own. Empty or one line it's a 48pt glass pill: `leading` (the +)
 * at its left, the words, its buttons (`children`) at its right. Once the
 * words would wrap there, or `top` holds files, or it's listening, it becomes
 * a card with the same 24pt corner: `top` first, the words across its whole
 * width (six lines, then they scroll inside), and one row under them with
 * `leading` and `chip` at the left and the buttons at the right. Whether the
 * words wrap is measured on one unwrapped line against the pill's room for
 * them, so it doesn't flip back and forth as the card gives them more width.
 *
 * Past six lines it follows the newest line, as the words stream in while it
 * listens and as you type at the end (`followsEnd`); with the caret further
 * up it holds still. The lines scrolled away at the top fade out
 * (`FieldFade`) rather than being cut by the edge.
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
  hold = false,
  leading,
  chip,
  top,
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
  /**
   * The mic is held (a voice message): the field keeps the shape it had when
   * the hold began, pill or card, so the button under the finger isn't moved
   * (moving it would end the press).
   */
  hold?: boolean;
  /** A round button at the field's left: the + (a 40pt `RoundButton`). */
  leading?: ReactNode;
  /** Beside `leading` in the card's row, never in the pill. */
  chip?: ReactNode;
  /** At the card's top, over the words: the files. Makes it a card. */
  top?: ReactNode;
  children?: ReactNode;
}) {
  const colors = useColors();
  const field = useFieldStyles();
  const appearance = useAppearance();
  const accent = useAccent();
  const size = useComposerSize();
  const scroll = useRef<ComponentRef<typeof ScrollView>>(null);
  const listening = Boolean(dictation);
  // Where the caret is, and the text's length it was reported against. The
  // words becoming typed or heard is a different view: the caret starts over
  // at the end.
  const [caret, setCaret] = useState<{ at: FieldCaret; length: number; listening: boolean }>(
    () => ({ at: null, length: value.length, listening })
  );
  const at = caret.listening === listening ? caret : { at: null, length: value.length, listening };
  if (at !== caret) setCaret(at);
  // The first size after mounting (a long draft reopened) jumps there; after that it glides.
  const placed = useRef(false);
  // Only once something has scrolled away at the top is there anything to fade.
  const [scrolled, setScrolled] = useState(false);
  // The web's textarea doesn't grow with its words as the native one does:
  // it's measured (QA only; the phone's input sizes itself).
  const own = useRef<ComponentRef<typeof TextInput>>(null);
  // The caller's ref is the same input (it focuses it), handed on once it's there.
  useImperativeHandle(inputRef, () => own.current as ComponentRef<typeof TextInput>);
  const fitWeb = useCallback(() => {
    const el = own.current as unknown as HTMLTextAreaElement | null;
    if (Platform.OS !== 'web' || !el?.style) return;
    el.style.height = '0px';
    el.style.height = `${el.scrollHeight}px`;
  }, []);
  const follow = () => {
    if (
      !followsEnd({ dictating: listening, caret: at.at, length: value.length, before: at.length })
    )
      return;
    scroll.current?.scrollToEnd({ animated: placed.current });
    placed.current = true;
  };
  // Heard words becoming typed ones (Stop) can keep the size and so not
  // report one: the end is followed across the swap too.
  useLayoutEffect(() => {
    fitWeb();
    follow();
    // Only on the swap and the text size; a new size of the words reports itself.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listening, size.maxHeight]);
  useLayoutEffect(fitWeb, [fitWeb, value]);
  const onScroll = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const away = e.nativeEvent.contentOffset.y > StyleSheet.hairlineWidth;
    if (away !== scrolled) setScrolled(away);
  };
  // iOS keeps a multiline input at its last height when its text is cleared
  // from code (a send). Empty, it's held to one line (`emptyHeight`) rather
  // than remounted: a remount took the keyboard away and gave it back on
  // every send, and the composer and the chat dipped and rose with it.
  const empty = dictation ? !dictation.settled && !dictation.deciding : false;
  // The pill's room for the words: the field less the + and the buttons beside them.
  const [width, setWidth] = useState(0);
  const [oneLine, setOneLine] = useState(0);
  const buttons = Children.toArray(children).length;
  const slot = size.send + composer.inset;
  const room =
    width -
    (leading ? composer.inset + slot + composer.afterLead : composer.padLeft) -
    composer.padRight -
    buttons * slot;
  const shape = fieldIsCard({
    listening: listening && !hold,
    hasTop: Boolean(top),
    value,
    width,
    oneLine,
    room,
  });
  const [frozen, setFrozen] = useState<boolean | null>(null);
  if (hold && frozen === null) setFrozen(shape);
  if (!hold && frozen !== null) setFrozen(null);
  const card = hold && frozen !== null ? frozen : shape;
  // The words keep their place in the tree whichever shape it is, so the
  // input (and the keyboard) stays as the pill becomes a card and back.
  return (
    <Glass
      style={[field.field, { minHeight: size.field }]}
      onLayout={(e: LayoutChangeEvent) => setWidth(e.nativeEvent.layout.width)}
    >
      <View
        pointerEvents="none"
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        style={field.measure}
      >
        <Text
          maxFontSizeMultiplier={chromeScale}
          numberOfLines={1}
          style={[field.input, field.measureText]}
          onLayout={(e: LayoutChangeEvent) => setOneLine(e.nativeEvent.layout.width)}
        >
          {value}
        </Text>
      </View>
      {top ? <View style={field.top}>{top}</View> : null}
      <View style={card ? null : [field.pill, leading ? field.pillLed : null]}>
        {!card && leading ? leading : null}
        <View
          style={[
            card ? null : field.words,
            {
              paddingLeft: card
                ? composer.padLeft
                : leading
                  ? composer.afterLead
                  : composer.padLeft,
            },
          ]}
        >
          <ScrollView
            ref={scroll}
            style={{ maxHeight: size.maxHeight }}
            // Listening, it only follows: a tap on the words is Stop and edit.
            scrollEnabled={!dictation}
            showsVerticalScrollIndicator={false}
            keyboardShouldPersistTaps="handled"
            onContentSizeChange={follow}
            onScroll={onScroll}
            scrollEventThrottle={16}
          >
            {dictation ? (
              <Pressable
                onPress={dictation.onPress}
                accessibilityRole="text"
                accessibilityLabel={
                  empty ? 'Listening' : `${label}: ${dictation.settled}${dictation.deciding}`
                }
                accessibilityHint="Double-tap to stop and edit"
                accessibilityLiveRegion="polite"
              >
                <Text maxFontSizeMultiplier={chromeScale} style={[field.input, field.cardInput]}>
                  {empty ? (
                    <>
                      <Caret />
                      <Text style={{ color: colors.textMuted }}>{placeholder}</Text>
                    </>
                  ) : (
                    <>
                      {dictation.settled}
                      <Text style={{ color: colors.textSecondary }}>{dictation.deciding}</Text>
                      <Caret />
                    </>
                  )}
                </Text>
              </Pressable>
            ) : (
              <View>
                <TextInput
                  ref={own}
                  maxFontSizeMultiplier={chromeScale}
                  value={value}
                  autoFocus={autoFocus}
                  editable={editable}
                  onChangeText={onChangeText}
                  onSelectionChange={(e) =>
                    setCaret({ at: e.nativeEvent.selection, length: value.length, listening })
                  }
                  onLayout={fitWeb}
                  multiline
                  // The field scrolls around it: the input is always as tall as its words.
                  scrollEnabled={false}
                  style={[
                    field.input,
                    card && field.cardInput,
                    value.length === 0 && { maxHeight: emptyHeight(size.field, card) },
                  ]}
                  selectionColor={accent.accent}
                  keyboardAppearance={appearance}
                  accessibilityLabel={label}
                />
                {value.length === 0 ? (
                  // Drawn here, not by the input: a multiline input wraps its
                  // placeholder while the field is still laying out, so the empty
                  // capsule showed it on two lines for a moment. One line, clipped.
                  <Text
                    pointerEvents="none"
                    accessibilityElementsHidden
                    importantForAccessibility="no"
                    numberOfLines={1}
                    ellipsizeMode="tail"
                    maxFontSizeMultiplier={chromeScale}
                    style={[
                      field.input,
                      card && field.cardInput,
                      field.placeholder,
                      { color: colors.textMuted },
                    ]}
                  >
                    {placeholder}
                  </Text>
                ) : null}
              </View>
            )}
          </ScrollView>
          {scrolled && <FieldFade />}
        </View>
        {card ? null : children}
      </View>
      {card ? (
        <View style={field.cardRow}>
          {leading}
          {chip}
          {/* Listening, the waveform fills the middle; otherwise the buttons go right. */}
          {listening ? null : <View style={field.spacer} />}
          {children}
        </View>
      ) : null}
    </Glass>
  );
}

/**
 * The top edge of a field scrolled past six lines: the field's fill in
 * `composer.fadeBands` steps, opaque at the edge to clear inward, so the
 * lines leaving fade out. Bands of a solid colour rather than a gradient (as
 * the chat's own edge, ChatView.tsx), so it needs no native module. On
 * Liquid Glass the fill is the surface under the glass, which the glass shows.
 */
function FieldFade() {
  const colors = useColors();
  const color = hasLiquidGlass() ? colors.surfaceApp : colors.composerFill;
  const bands = Array.from({ length: composer.fadeBands }, (_, i) => {
    // i = 0 at the edge. Eased, so the last steps into the words are gentlest.
    const t = 1 - i / composer.fadeBands;
    return t * t;
  });
  return (
    <View
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      testID="composer-fade"
      style={fieldFade.wrap}
    >
      {bands.map((opacity, i) => (
        <View key={i} style={{ flex: 1, backgroundColor: color, opacity }} />
      ))}
    </View>
  );
}

const fieldFade = StyleSheet.create({
  wrap: { position: 'absolute', top: 0, left: 0, right: 0, height: composer.fade },
});

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
  onLongPress,
  onPressOut,
  tone,
  children,
}: {
  label: string;
  hint?: string;
  disabled?: boolean;
  onPress: () => void;
  /** A hold (the mic's voice message), after `HOLD_DELAY_MS`. */
  onLongPress?: (e: GestureResponderEvent) => void;
  /** The finger came off, or slid away past `HOLD_CANCEL_DISTANCE`. */
  onPressOut?: (e: GestureResponderEvent) => void;
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
        onLongPress={onLongPress}
        onPressOut={onPressOut}
        delayLongPress={onLongPress ? HOLD_DELAY_MS : undefined}
        // Sliding this far off a held button ends the press there: that's the cancel.
        pressRetentionOffset={onLongPress ? HOLD_CANCEL_DISTANCE : undefined}
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

/**
 * The caret after the words while it listens, as a text input's: the
 * accent's 2pt bar on the last line, blinking. Under Reduce Motion it holds
 * still. It rides inline in the words, so it wraps with them.
 */
function Caret() {
  const accent = useAccent();
  const still = useReducedMotion();
  const shown = useSharedValue(1);
  useEffect(() => {
    if (still) return;
    const half = { duration: composer.caretBlink };
    shown.set(withRepeat(withSequence(withTiming(1, half), withTiming(0, half)), -1));
    return () => cancelAnimation(shown);
  }, [still, shown]);
  const blink = useAnimatedStyle(() => ({ opacity: shown.get() }));
  return (
    <Animated.View
      accessibilityElementsHidden
      importantForAccessibility="no"
      testID="dictation-caret"
      style={[
        {
          width: composer.caretWidth,
          height: scaledSize(composer.caretHeight),
          borderRadius: composer.caretWidth / 2,
          backgroundColor: accent.accent,
          transform: [{ translateY: scaledSize(composer.caretDrop) }],
        },
        blink,
      ]}
    />
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
/**
 * The input's height with nothing in it: one line and its padding (the
 * field's own height), and the card's extra padding under the words. Never
 * smaller than the input draws one line at; only a stale, taller one is cut.
 */
export const emptyHeight = (field: number, card: boolean) => field + (card ? space.sm : 0);

export function useComposerSize() {
  const { fontScale } = useWindowDimensions();
  // Dynamic Type as far as chrome follows it, times Settings → Text size.
  const k = Math.min(Math.max(fontScale, 1), chromeScale) * useTextScale();
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
    minHeight: FIELD_MIN,
    borderRadius: composer.fieldCorner,
  },
  input: {
    // As tall as its words, inside the field's scroll (never flex: it would size to the view, not the text).
    fontFamily: fonts.regular,
    fontSize: type.field,
    // The line grows with Settings → Text size, as the words do (`useComposerSize`).
    lineHeight: scaledSize(composer.fieldLine),
    color: colors.textBody,
    paddingTop: composer.padV - StyleSheet.hairlineWidth,
    paddingBottom: composer.padV - StyleSheet.hairlineWidth,
    paddingRight: composer.padRight,
  },
  roundSlot: { marginRight: composer.inset, marginBottom: composer.inset },
  // The pill: the +, the words, the buttons, all on the last line.
  pill: { flexDirection: 'row', alignItems: 'flex-end' },
  pillLed: { paddingLeft: composer.inset },
  words: { flex: 1 },
  // The card: the words keep the input's type and top; at the right as wide as at the left.
  cardInput: { paddingRight: composer.padLeft, paddingBottom: space.sm },
  cardRow: { flexDirection: 'row', alignItems: 'flex-end', paddingLeft: composer.inset },
  spacer: { flex: 1 },
  top: { paddingTop: space.sm },
  chip: {
    justifyContent: 'center',
    paddingHorizontal: space.md,
    marginRight: composer.inset,
    marginBottom: composer.inset,
    flexShrink: 1,
    backgroundColor: colors.surfaceSelected,
  },
  // One unwrapped line of the words, unseen: is it wider than the pill has room for?
  // Clipped to the field, so a long line never widens the page (the web build).
  measure: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    opacity: 0,
    flexDirection: 'row',
    overflow: 'hidden',
  },
  placeholder: { position: 'absolute', top: 0, left: 0, right: 0 },
  measureText: { paddingTop: 0, paddingBottom: 0, paddingRight: 0 },
  // Between × and Stop, centred on them (their slots sit `inset` off the bottom).
  wave: { marginHorizontal: space.sm, marginBottom: composer.inset },
  round: {
    width: composer.send,
    height: composer.send,
    borderRadius: composer.send / 2,
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
    // Its rule on the field's left edge, as the line above it.
    marginRight: space.md,
    paddingLeft: space.md,
    paddingVertical: space.xs,
    borderLeftWidth: 2,
    borderLeftColor: colors.borderStrong,
  },
  row: { flexDirection: 'row', alignItems: 'flex-end', gap: space.sm },
  // Inside the card's top: the tiles keep room above and right for their ×.
  tray: { gap: space.xs, paddingTop: space.xs, paddingHorizontal: space.sm },
  stopSquare: {
    width: 14,
    height: 14,
    borderRadius: radius.sm,
    backgroundColor: colors.textPrimary,
  },
}));
