/**
 * A project session: what Remote Access reads off its screen (the state, a
 * question waiting with its options) and the transcript itself, refreshed
 * while you watch. Answer a question with its options, or type to the
 * agent; both go through Remote Access's own rules on the Mac (agent tabs
 * only, never typing into a tab that's showing a question).
 */

import type { SessionScreen } from '@shipstudio/companion-protocol';
import { Stack, useLocalSearchParams } from 'expo-router';
import { useCallback, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View, type ScrollViewInstance } from 'react-native';
import { KeyboardStickyView } from 'react-native-keyboard-controller';
import Animated, { FadeIn, FadeOut } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Spinner } from '../../components/agent';
import { DiffLines } from '../../components/diff';
import { useNow } from '../../components/ConnectionPill';
import { SessionState, tabName } from '../../components/session';
import { Button, Icon, T } from '../../components/ui';
import { useAccent } from '../../lib/accent';
import { formatAgo } from '../../lib/agents';
import { questionContext } from '../../lib/diff';
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
import { chromeScale, fonts, iconSize, lineHeight, radius, space, type } from '../../lib/theme';
import { ComposerField, RoundButton } from '../../components/Composer';
import { makeStyles, useColors } from '../../lib/appearance';

export default function Session() {
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

  const title = [project, data ? tabName(data.session) : tab].filter(Boolean).join(' · ');
  const sendable = !!text.trim() && connected && !data?.session.question;
  const question = data?.session.question;
  // What it's asking about (an edit's diff, a command), read off its screen.
  const context = question && data ? questionContext(data.screen, question) : [];

  return (
    <View style={{ flex: 1 }}>
      <Stack.Screen
        options={{
          headerTitle: () => (
            <View style={styles.header}>
              <T variant="headline" color={colors.textStrong} numberOfLines={1}>
                {title || 'Session'}
              </T>
              <T variant="caption" color={colors.textMuted} maxFontSizeMultiplier={chromeScale}>
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
                This session isn’t open on your Mac any more
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
                  <SessionState session={data.session} />
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
                          title={o.key === 'enter' ? o.label : `${o.key}. ${o.label}`}
                          variant={o.highlighted ? 'primary' : 'secondary'}
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
                            {o.highlighted ? '❯ ' : '   '}
                            {o.key}. {o.label}
                          </T>
                        ))}
                      </View>
                      <T variant="caption" color={colors.textMuted}>
                        Answer it on your Mac.
                      </T>
                    </>
                  )}
                </Animated.View>
              )}
              {/*
                The terminal at its own width, scrolled sideways: wrapped to a
                phone's ~49 columns, an 80-column box turns into a staircase.
              */}
              <ScrollView
                horizontal
                style={styles.screenWell}
                contentContainerStyle={styles.screenContent}
                showsHorizontalScrollIndicator={false}
              >
                <T selectable style={styles.screen} color={colors.textPrimary}>
                  {textGlyphs(data.screen.replace(/\s+$/, ''))}
                </T>
              </ScrollView>
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
          <Pressable accessibilityLabel="Dismiss" hitSlop={14} onPress={() => setError(null)}>
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
              placeholder={
                question ? 'Answer the question above first' : `Message ${tabName(data.session)}`
              }
              label={`Message ${tabName(data.session)}`}
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

/** Claude Code's ⏺ and friends, as text: iOS would otherwise draw them as emoji. */
const textGlyphs = (screen: string) => screen.replace(/([⏺⏸⏹✻✳])(?!\uFE0E)/g, '$1\uFE0E');

const useStyles = makeStyles((colors) => ({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  header: { alignItems: 'center', maxWidth: 260 },
  content: { padding: space.lg, gap: space.md, paddingBottom: space['2xl'] },
  state: { paddingVertical: space.xs },
  card: {
    gap: space.md,
    padding: space.lg,
    borderRadius: radius.card,
    backgroundColor: colors.surfacePanel,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.cardBorder,
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
  screenWell: { borderRadius: radius.card, backgroundColor: colors.surfacePanel },
  screenContent: { padding: space.md },
  screen: {
    fontFamily: fonts.mono,
    fontSize: type.caption,
    lineHeight: lineHeight(type.caption, 1.5),
  },
}));
