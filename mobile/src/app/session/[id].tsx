/**
 * A project session: what Remote Access reads off its screen (the state, a
 * question waiting with its options) and the transcript itself, refreshed
 * while you watch. Answer a question with its options, or type to the
 * agent; both go through Remote Access's own rules on the Mac (agent tabs
 * only, never typing into a tab that's showing a question).
 */

import type { SessionScreen, SessionSent } from '@shipstudio/companion-protocol';
import { Stack, useLocalSearchParams } from 'expo-router';
import { useCallback, useMemo, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View, type ScrollViewInstance } from 'react-native';
import { KeyboardStickyView } from 'react-native-keyboard-controller';
import Animated, { FadeIn, FadeOut } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Spinner } from '../../components/agent';
import { DiffLines } from '../../components/diff';
import { useNow } from '../../components/ConnectionPill';
import { SessionState, useTaskName } from '../../components/session';
import { Markdown } from '../../components/Markdown';
import { TextAction } from '../../components/surfaces';
import { Button, Dot, Icon, T } from '../../components/ui';
import { useAccent } from '../../lib/accent';
import { formatAgo } from '../../lib/agents';
import { questionContext } from '../../lib/diff';
import {
  noticesOf,
  readTaskScreen,
  terminalFirst,
  type TaskPart,
  type TaskReading,
} from '../../lib/taskScreen';
import { haptic } from '../../lib/haptics';
import {
  canCall,
  describeError,
  pressSessionKey,
  readSession,
  sendToSession,
} from '../../lib/session';
import { useApp } from '../../lib/store';
import { usePolling } from '../../lib/usePolling';
import {
  alpha,
  chromeScale,
  composer,
  fonts,
  iconSize,
  lineHeight,
  radius,
  space,
  type,
  PRESSED,
} from '../../lib/theme';
import { ComposerField, RoundButton } from '../../components/Composer';
import { makeStyles, useColors } from '../../lib/appearance';
import { useComputer } from '../../lib/computer';

export default function Session() {
  const comp = useComputer();
  const colors = useColors();
  const styles = useStyles();
  const accent = useAccent();
  const { id, project, path, tab, reply } = useLocalSearchParams<{
    id: string;
    project?: string;
    path?: string;
    tab?: string;
    reply?: string;
  }>();
  const now = useNow(10_000);
  const insets = useSafeAreaInsets();
  const [data, setData] = useState<SessionScreen | null>(null);
  const [gone, setGone] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The raw terminal is one tap away. It opens by itself when the reading may
  // be missing something (`terminalFirst`); a tap then decides.
  const [terminalChoice, setTerminalChoice] = useState<boolean | null>(null);
  const connected = useApp((s) => s.link.kind === 'connected');
  const canAnswer = useApp((s) => canCall('sessions.key', s.welcome));
  // The project's path, from the list when we came from a chat's session card.
  const projectPath = useApp(
    (s) =>
      path ?? s.projects?.find((p) => p.sessions.some((x) => x.sessionId === id))?.path ?? undefined
  );
  const canType = useApp((s) => canCall('sessions.send', s.welcome)) && !!projectPath;
  const scroll = useRef<ScrollViewInstance>(null);
  const pinned = useRef(true);

  const load = useCallback(
    () =>
      readSession(id).then(
        (s) => {
          setData(s);
          setGone(null);
        },
        (e: unknown) => setGone(describeError(e))
      ),
    [id]
  );
  usePolling(load, 2500);

  const fail = (e: unknown) => {
    haptic.error();
    setError(describeError(e));
  };

  const answer = (key: string) => {
    setBusy(key);
    setError(null);
    pressSessionKey(id, key)
      .then(() => {
        haptic.success();
        return load();
      }, fail)
      .finally(() => setBusy(null));
  };

  const submit = () => {
    const body = text.trim();
    if (!body || !projectPath) return;
    setBusy('send');
    setError(null);
    haptic.light();
    sendToSession(projectPath, id, body)
      .then(() => {
        setText('');
        pinned.current = true;
        return load();
      }, fail)
      .finally(() => setBusy(null));
  };

  const name = useTaskName(id);
  const title = [project, name === 'Task' && tab ? tab : name].filter(Boolean).join(' · ');
  const sendable = !!text.trim() && connected && !data?.session.question;
  const question = data?.session.question;
  // What it's asking about (an edit's diff, a command), read off its screen.
  const context = question && data ? questionContext(data.screen, question) : [];
  // The screen read as a conversation, from what the Mac says it sent (never
  // a line guessed off the screen).
  const reading = useMemo(
    () => (data ? readTaskScreen(data.screen, data.sent?.text) : null),
    [data]
  );
  const showTerminal =
    terminalChoice ??
    (!!reading && !!data && terminalFirst(reading, data.session.state, !!question));
  // Something on its screen went wrong or was cut off: the state never says it went fine.
  const trouble = !!reading && noticesOf(reading).length > 0;

  return (
    <View style={{ flex: 1 }}>
      <Stack.Screen
        options={{
          headerTitle: () => (
            <View style={styles.header}>
              <T
                variant="headline"
                color={colors.textStrong}
                numberOfLines={1}
                style={styles.headerText}
              >
                {title || 'Task'}
              </T>
              <T
                variant="caption"
                color={colors.textMuted}
                maxFontSizeMultiplier={chromeScale}
                numberOfLines={1}
                style={styles.headerText}
              >
                {gone
                  ? 'Closed'
                  : data
                    ? `Updated ${formatAgo(data.session.lastOutputAt, now)}`
                    : 'Loading…'}
              </T>
            </View>
          ),
        }}
      />
      {!data && !gone ? (
        <View style={styles.center}>
          <Spinner size={iconSize.body} />
        </View>
      ) : (
        <ScrollView
          ref={scroll}
          contentContainerStyle={[styles.content, canType && { paddingBottom: 120 }]}
          keyboardDismissMode="interactive"
          keyboardShouldPersistTaps="handled"
          onContentSizeChange={() =>
            pinned.current && scroll.current?.scrollToEnd({ animated: false })
          }
          onScroll={(e) => {
            const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
            pinned.current = contentOffset.y + layoutMeasurement.height > contentSize.height - 40;
          }}
          scrollEventThrottle={100}
        >
          {gone && (
            <Animated.View entering={FadeIn} style={styles.card}>
              <T variant="headline" color={colors.textStrong}>
                This task isn’t open on {comp.your} any more
              </T>
              <T variant="small" color={colors.textSecondary}>
                {gone}
              </T>
              {!!reply && (
                <T color={colors.textPrimary} selectable style={{ marginTop: space.sm }}>
                  {reply}
                </T>
              )}
            </Animated.View>
          )}
          {data && (
            <>
              {!question && (
                <View style={styles.state}>
                  <SessionState session={data.session} trouble={trouble} />
                </View>
              )}
              {question && (
                <Animated.View entering={FadeIn} style={styles.card}>
                  <T variant="headline" color={colors.textStrong}>
                    {question.question}
                  </T>
                  {!!question.action && (
                    <T variant="mono" color={colors.textPrimary}>
                      {question.action}
                    </T>
                  )}
                  {context.length > 0 && (
                    <DiffLines lines={context} label="What it’s asking to do" />
                  )}
                  {canAnswer ? (
                    <View style={{ gap: space.sm }}>
                      {question.options.map((o) => (
                        <Button
                          key={o.key}
                          // The option's words, not the key the terminal takes for it.
                          title={o.label}
                          // An answer: neutral, never the accent.
                          variant={o.highlighted ? 'answer' : 'outline'}
                          lines={4}
                          busy={busy === o.key}
                          disabled={!connected || !!busy}
                          onPress={() => answer(o.key)}
                          style={styles.option}
                        />
                      ))}
                      <Button
                        title="Cancel"
                        variant="ghost"
                        busy={busy === 'escape'}
                        disabled={!connected || !!busy}
                        onPress={() => answer('escape')}
                      />
                    </View>
                  ) : (
                    <>
                      <View style={{ gap: space.xs }}>
                        {question.options.map((o) => (
                          <T
                            key={o.key}
                            variant="small"
                            color={o.highlighted ? colors.textStrong : colors.textSecondary}
                          >
                            {o.label}
                          </T>
                        ))}
                      </View>
                      <T variant="caption" color={colors.textMuted}>
                        Answer it on {comp.your}.
                      </T>
                    </>
                  )}
                </Animated.View>
              )}
              <TaskConversation
                reading={reading}
                sent={data.sent}
                now={now}
                // The Mac read the prompt as a question: the card above draws it.
                promptShown={!question}
              />
              <View style={styles.terminalToggle}>
                <TextAction
                  label={showTerminal ? 'Hide terminal' : 'Show terminal'}
                  hint={`Shows the task’s own screen, as ${comp.your} has it`}
                  onPress={() => setTerminalChoice(!showTerminal)}
                />
              </View>
              {showTerminal && (
                <Animated.View entering={FadeIn.duration(150)} style={styles.screenWell}>
                  {/*
                    The terminal at its own width, scrolled sideways: wrapped to a
                    phone's ~49 columns, an 80-column box turns into a staircase.
                  */}
                  <ScrollView
                    horizontal
                    contentContainerStyle={styles.screenContent}
                    showsHorizontalScrollIndicator={false}
                  >
                    <T selectable style={styles.screen} color={colors.textPrimary}>
                      {textGlyphs(data.screen.replace(/\s+$/, ''))}
                    </T>
                  </ScrollView>
                  <EdgeFade />
                </Animated.View>
              )}
            </>
          )}
        </ScrollView>
      )}
      {error && (
        <Animated.View
          entering={FadeIn.duration(150)}
          exiting={FadeOut.duration(150)}
          style={[styles.toast, { bottom: (canType ? 88 : space.lg) + insets.bottom }]}
          accessibilityLiveRegion="polite"
        >
          <T variant="small" color={colors.textStrong} style={{ flex: 1 }}>
            {error}
          </T>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Dismiss"
            hitSlop={14}
            onPress={() => setError(null)}
            style={({ pressed }) => pressed && PRESSED}
          >
            <Icon
              name="xmark"
              size={iconSize.inline}
              color={colors.textSecondary}
              fallback={<T>×</T>}
            />
          </Pressable>
        </Animated.View>
      )}
      {canType && data && !gone && (
        <KeyboardStickyView offset={{ opened: insets.bottom }} style={styles.composerWrap}>
          <View style={[styles.composer, { paddingBottom: Math.max(insets.bottom, space.sm) }]}>
            <ComposerField
              value={text}
              onChangeText={setText}
              editable={!question}
              placeholder={question ? 'Answer the question above first' : 'Message this task'}
              label="Message this task"
            >
              <RoundButton
                label="Send"
                disabled={!sendable || !!busy}
                onPress={submit}
                tone={sendable ? 'accent' : 'off'}
              >
                {busy === 'send' ? (
                  <Spinner size={iconSize.inline} color={accent.onAccent} />
                ) : (
                  <Icon
                    name="arrow.up"
                    size={iconSize.body}
                    color={sendable ? accent.onAccent : colors.textMuted}
                  />
                )}
              </RoundButton>
            </ComposerField>
          </View>
        </KeyboardStickyView>
      )}
    </View>
  );
}

/** Steps shown in full in a run; older ones fold into a count (the terminal has them all). */
const STEPS_SHOWN = 5;

type Block =
  | { kind: 'steps'; steps: string[] }
  | Exclude<TaskPart, { kind: 'step' }>;

/** Runs of steps together, everything else as it came. */
function blocksOf(parts: TaskPart[]): Block[] {
  const out: Block[] = [];
  for (const p of parts) {
    const last = out[out.length - 1];
    if (p.kind === 'step') {
      if (last?.kind === 'steps') last.steps.push(p.text);
      else out.push({ kind: 'steps', steps: [p.text] });
    } else out.push(p);
  }
  return out;
}

/** Who sent the message the reading starts after, as far as the Mac knows. */
export function sentLabel(sent: SessionSent, now: number): string {
  const when = formatAgo(sent.at, now);
  return sent.byAgent ? `An agent sent this · ${when}` : `Sent to it · ${when}`;
}

/**
 * The task as a conversation, in screen order: what the Mac sent it (only
 * when the Mac says so, labelled, never "you"), its steps in plain words,
 * what it said, every line saying something went wrong, messages typed into
 * the terminal as they appear, and a prompt the Mac didn't read, whole.
 */
function TaskConversation({
  reading,
  sent,
  now,
  promptShown,
}: {
  reading: TaskReading | null;
  sent?: SessionSent;
  now: number;
  promptShown: boolean;
}) {
  const colors = useColors();
  const styles = useStyles();
  if (!reading) return null;
  const { asked, parts, prompt } = reading;
  return (
    <View style={styles.conversation}>
      {!!asked && !!sent && (
        <View style={styles.asked}>
          <T variant="caption" color={colors.textMuted}>
            {sentLabel(sent, now)}
          </T>
          <T color={colors.textBody} selectable>
            {asked}
          </T>
        </View>
      )}
      {blocksOf(parts).map((block, i) => {
        switch (block.kind) {
          case 'steps': {
            const earlier = Math.max(0, block.steps.length - STEPS_SHOWN);
            return (
              <View
                key={i}
                style={styles.steps}
                accessibilityLabel={`Steps: ${block.steps.join('. ')}`}
              >
                {earlier > 0 && (
                  <T variant="caption" color={colors.textMuted}>
                    {earlier === 1 ? '1 earlier step' : `${earlier} earlier steps`}
                  </T>
                )}
                {block.steps.slice(-STEPS_SHOWN).map((step, j) => (
                  <View key={`${j}:${step}`} style={styles.step}>
                    <Dot color={colors.textMuted} />
                    <T
                      variant="small"
                      color={colors.textSecondary}
                      numberOfLines={2}
                      style={{ flex: 1 }}
                    >
                      {step}
                    </T>
                  </View>
                ))}
              </View>
            );
          }
          case 'said':
            return <Markdown key={i} text={block.text} />;
          case 'notice':
            return (
              <View key={i} style={styles.notice} accessibilityLabel={`From its screen: ${block.text}`}>
                <Icon
                  name="exclamationmark.triangle"
                  size={iconSize.inline}
                  color={colors.accentWarning}
                  fallback={<T color={colors.accentWarning}>!</T>}
                />
                <T variant="small" color={colors.textStrong} selectable style={{ flex: 1 }}>
                  {block.text}
                </T>
              </View>
            );
          case 'typed':
            return (
              <T key={i} variant="mono" color={colors.textSecondary} selectable>
                {block.text}
              </T>
            );
        }
      })}
      {!!prompt && promptShown && (
        <View style={styles.prompt} accessibilityLabel="On its screen now">
          <T variant="caption" color={colors.textMuted}>
            On its screen now · answer it in the terminal
          </T>
          {prompt.map((line, i) => (
            <T key={i} variant="mono" color={colors.textPrimary} selectable>
              {line}
            </T>
          ))}
        </View>
      )}
    </View>
  );
}

/** The well's right edge fades out, so a line running past it reads as "scroll", not "cut". */
function EdgeFade() {
  const colors = useColors();
  const styles = useStyles();
  return (
    <View style={styles.fade} pointerEvents="none">
      {[0.15, 0.35, 0.6, 0.85, 1].map((a) => (
        <View key={a} style={{ flex: 1, backgroundColor: alpha(colors.surfacePanel, a) }} />
      ))}
    </View>
  );
}

/** Claude Code's ⏺ and friends, as text: iOS would otherwise draw them as emoji. */
const textGlyphs = (screen: string) => screen.replace(/([⏺⏸⏹✻✳])(?!\uFE0E)/g, '$1\uFE0E');

const useStyles = makeStyles((colors) => ({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  header: { alignItems: 'center', maxWidth: 260 },
  // Both lines centred on one axis, however long the title.
  headerText: { textAlign: 'center', alignSelf: 'stretch' },
  content: { padding: space.lg, gap: space.md, paddingBottom: space['2xl'] },
  state: { paddingVertical: space.xs },
  card: {
    gap: space.md,
    padding: space.lg,
    borderRadius: radius.card,
    backgroundColor: colors.surfacePanel,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.cardBorder,
    overflow: 'hidden',
  },
  // A choice reads as a menu, left-aligned, not as a centred button that wrapped.
  option: { justifyContent: 'flex-start', paddingHorizontal: space.lg },
  toast: {
    position: 'absolute',
    left: space.lg,
    right: space.lg,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    padding: space.md,
    borderRadius: radius.card,
    backgroundColor: colors.surfaceSelected,
  },
  composerWrap: { position: 'absolute', left: 0, right: 0, bottom: 0 },
  composer: {
    paddingHorizontal: space.lg,
    paddingTop: space.sm,
    backgroundColor: colors.surfaceApp,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.borderDefault,
  },
  screenWell: {
    borderRadius: radius.card,
    backgroundColor: colors.surfacePanel,
    overflow: 'hidden',
  },
  fade: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    right: 0,
    width: space.xl,
    flexDirection: 'row',
  },
  terminalToggle: { alignItems: 'flex-start', paddingTop: space.xs },
  conversation: { gap: space.md },
  // What the Mac sent: labelled, left-aligned, not drawn as your own bubble.
  asked: {
    gap: space.xs,
    backgroundColor: colors.surfaceBubble,
    borderRadius: composer.corner,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
  },
  notice: { flexDirection: 'row', alignItems: 'flex-start', gap: space.sm },
  prompt: {
    gap: space.xs,
    padding: space.md,
    borderRadius: radius.card,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.cardBorder,
    overflow: 'hidden',
  },
  steps: { gap: space.xs },
  step: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  screenContent: { padding: space.md },
  screen: {
    fontFamily: fonts.mono,
    fontSize: type.caption,
    lineHeight: lineHeight(type.caption, 1.5),
  },
}));

/** A throw while drawing stays on this screen, with the way back. */
export { ScreenError as ErrorBoundary } from '../../components/ScreenError';
