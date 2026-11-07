/**
 * Sign in on your Mac, from here: a login card's site, open in a window of
 * the agents' own Chrome on the Mac (or a tab of the user's Chrome for an
 * older card), shown live and driven by touch (`lib/phoneSignin.ts`,
 * desktop `agents/phone_signin.rs`). A site that refuses that window offers
 * "Sign in another way": the same profile in a plain Chrome window, shown
 * through macOS, or the plain answer that it happens at the Mac.
 *
 * Tap the picture to click there; pinch to look closer; the field types at
 * whatever is focused, hidden when Password is on. What's typed lives only
 * in a ref, goes to the Mac once, and is wiped then, when the app leaves the
 * screen, and when the screen closes. Leaving the screen stops it on the Mac.
 */

import { Image } from 'expo-image';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { type ComponentRef, useEffect, useReducer, useRef, useState } from 'react';
import {
  AppState,
  type GestureResponderEvent,
  Pressable,
  ScrollView,
  TextInput,
  useWindowDimensions,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Spinner } from '../components/agent';
import { Button, T } from '../components/ui';
import { haptic } from '../lib/haptics';
import {
  canAct,
  canFallBack,
  endsIt,
  frameGap,
  initialView,
  KEYS,
  reduce,
  retryWays,
  BEGIN_TIMEOUT_MESSAGE,
  BEGIN_TIMEOUT_MS,
  withTimeout,
  shownHeight,
  statusLine,
  toFramePoint,
  typeInput,
  viaLabel,
} from '../lib/signinView';
import {
  signinBegin,
  signinDone,
  signinFallback,
  signinFrame,
  signinInput,
  signinStop,
} from '../lib/phoneSignin';
import { describeError } from '../lib/session';
import { iconSize, radius, space } from '../lib/theme';
import { makeStyles, useAppearance, useColors } from '../lib/appearance';
import type { SigninInput, SigninVia } from '@shipstudio/companion-protocol';

export default function SignInFromPhone() {
  const colors = useColors();
  const styles = useStyles();
  const appearance = useAppearance();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const { agentId, requestId } = useLocalSearchParams<{ agentId: string; requestId: string }>();
  const [view, dispatch] = useReducer(reduce, initialView);
  const [filled, setFilled] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  // Each start (a retry is another), and the way it asked for.
  const [attempt, setAttempt] = useState<{ n: number; way?: SigninVia }>({ n: 0 });
  const text = useRef('');
  const field = useRef<ComponentRef<typeof TextInput> | null>(null);
  const session = view.phase === 'live' ? view.begun.sessionId : null;
  const sessionRef = useRef<string | null>(null);
  sessionRef.current = session;
  // Read by the picture loop on each pass (the way can change mid-session).
  const viewRef = useRef(view);
  viewRef.current = view;

  const wipe = () => {
    text.current = '';
    field.current?.clear();
    setFilled(false);
  };

  // Open it on the Mac, once per attempt. It never stays "Opening…": a Mac
  // that doesn't answer in time ends it with a retry, and a late answer is
  // stopped there.
  useEffect(() => {
    let gone = false;
    const begin = signinBegin(agentId, requestId, attempt.way);
    begin.then(
      (begun) => {
        if (gone) void signinStop(begun.sessionId).catch(() => {});
      },
      () => {}
    );
    withTimeout(begin, BEGIN_TIMEOUT_MS, BEGIN_TIMEOUT_MESSAGE)
      .then((begun) => {
        if (!gone) dispatch({ t: 'begun', begun });
      })
      .catch((e) => {
        if (gone) return;
        if ((e as Error)?.message === BEGIN_TIMEOUT_MESSAGE) gone = true;
        dispatch({ t: 'end', reason: 'failed', message: describeError(e) });
      });
    return () => {
      gone = true;
    };
  }, [agentId, requestId, attempt]);
  const retry = (way?: SigninVia) => {
    haptic.select();
    dispatch({ t: 'retry' });
    setAttempt((a) => ({ n: a.n + 1, way }));
  };

  // Leaving the screen stops it on the Mac; the field is wiped either way.
  useEffect(
    () => () => {
      text.current = '';
      const id = sessionRef.current;
      if (id) void signinStop(id).catch(() => {});
    },
    []
  );
  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => s !== 'active' && wipe());
    return () => sub.remove();
  }, []);

  // Pictures, one at a time, each asked for after the last (the agents'
  // browser answers as soon as a newer one is drawn); paused in the background.
  useEffect(() => {
    if (!session) return;
    let stop = false;
    let failures = 0;
    let seq = 0;
    const loop = async () => {
      while (!stop) {
        if (AppState.currentState !== 'background') {
          try {
            const frame = await signinFrame(session, seq || undefined);
            if (stop) return;
            failures = 0;
            seq = frame.seq ?? 0;
            dispatch({ t: 'frame', frame });
          } catch (e) {
            if (stop) return;
            const message = describeError(e);
            if (endsIt(message) || ++failures >= 5) {
              dispatch({ t: 'end', reason: 'ended', message });
              return;
            }
            dispatch({ t: 'note', message });
          }
        }
        await new Promise((r) => setTimeout(r, frameGap(viewRef.current)));
      }
    };
    void loop();
    return () => {
      stop = true;
    };
  }, [session]);

  const send = async (tag: string, input: SigninInput, after?: () => void) => {
    if (!session) return;
    setBusy(tag);
    try {
      await signinInput(session, input);
      dispatch({ t: 'note', message: null });
      after?.();
    } catch (e) {
      const message = describeError(e);
      haptic.error();
      if (endsIt(message)) dispatch({ t: 'end', reason: 'ended', message });
      else dispatch({ t: 'note', message });
    } finally {
      setBusy(null);
    }
  };

  const frame = view.phase === 'live' ? view.frame : null;
  const live = canAct(view);
  const shown =
    frame && frame.state === 'live' ? { width, height: shownHeight(width, frame) } : null;
  const onTap = (e: GestureResponderEvent) => {
    if (!frame || !shown || !live) return;
    const at = toFramePoint(
      { x: e.nativeEvent.locationX, y: e.nativeEvent.locationY },
      shown,
      frame
    );
    if (at) {
      haptic.select();
      void send('tap', { kind: 'tap', ...at });
    }
  };
  const scroll = (direction: 'up' | 'down') =>
    frame &&
    void send('scroll', {
      kind: 'scroll',
      x: Math.round(frame.width / 2),
      y: Math.round(frame.height / 2),
      direction,
      amount: 5,
    });
  const typeIt = () => {
    if (!text.current || view.phase !== 'live') return;
    // The one copy goes to the Mac; this one is wiped whether it got there or not.
    const input = typeInput(text.current, view.secure);
    wipe();
    void send('type', input);
  };
  const done = async (anyway = false) => {
    if (!session) return;
    dispatch({ t: 'checking' });
    try {
      const { outcome } = await signinDone(session, anyway);
      if (outcome === 'signed_in') haptic.success();
      dispatch({ t: 'outcome', outcome });
    } catch (e) {
      const message = describeError(e);
      if (endsIt(message)) dispatch({ t: 'end', reason: 'ended', message });
      else {
        dispatch({ t: 'outcome', outcome: 'unknown' });
        dispatch({ t: 'note', message });
      }
    }
  };
  const fallBack = async () => {
    if (!session) return;
    dispatch({ t: 'switching' });
    try {
      const begun = await signinFallback(session);
      dispatch({ t: 'switched', begun });
    } catch (e) {
      haptic.error();
      dispatch({ t: 'note', message: describeError(e) });
    }
  };
  const stop = async () => {
    if (session) await signinStop(session).catch(() => {});
    dispatch({ t: 'end', reason: 'stopped', message: 'Stopped. The tab on your Mac is closed.' });
    router.back();
  };

  const line = statusLine(view);
  const title =
    view.phase === 'live' ? view.begun.domain : view.phase === 'ended' ? (view.domain ?? '') : '';

  return (
    <View style={[styles.root, { paddingTop: insets.top }]} testID="signin-screen">
      <View style={styles.bar}>
        <Button
          title={view.phase === 'ended' ? 'Close' : 'Stop'}
          variant="outline"
          size="compact"
          onPress={() => (view.phase === 'ended' ? router.back() : void stop())}
        />
        <View style={styles.titleWrap}>
          <T variant="subhead" numberOfLines={1}>
            {title}
          </T>
          <T variant="caption" color={colors.textMuted} numberOfLines={1}>
            {viaLabel(view.phase === 'live' ? view.via : undefined)}
          </T>
        </View>
        <Button
          title="Done"
          variant="answer"
          size="compact"
          disabled={!live}
          busy={view.phase === 'live' && view.check === 'checking'}
          onPress={() => void done()}
          testID="signin-done"
        />
      </View>

      <View style={styles.page}>
        {frame && frame.state !== 'outside' && frame.image ? (
          <ScrollView
            maximumZoomScale={3}
            minimumZoomScale={1}
            bouncesZoom
            contentContainerStyle={{ minHeight: shownHeight(width, frame) }}
          >
            <Pressable onPress={onTap} disabled={!live} accessibilityLabel="The page on your Mac">
              <Image
                source={{ uri: `data:image/jpeg;base64,${frame.image}` }}
                style={{ width, height: shownHeight(width, frame) }}
                contentFit="fill"
                transition={0}
              />
            </Pressable>
          </ScrollView>
        ) : view.phase !== 'ended' && frame?.state !== 'outside' ? (
          <View style={styles.center}>
            <Spinner size={iconSize.button} color={colors.textMuted} />
          </View>
        ) : null}
      </View>

      {!!line && (
        <View style={styles.line} testID="signin-line">
          <T variant="small" color={colors.textSecondary}>
            {line}
          </T>
          {canFallBack(view) && (
            <Button
              title="Sign in another way"
              variant="outline"
              size="compact"
              onPress={() => void fallBack()}
              testID="signin-fallback"
            />
          )}
          {retryWays(view).map((r) => (
            <Button
              key={r.label}
              title={r.label}
              variant="outline"
              size="compact"
              onPress={() => retry(r.way)}
              testID={r.way ? 'signin-retry-agents' : 'signin-retry'}
            />
          ))}
          {view.phase === 'live' && view.check === 'unknown' && (
            <Button
              title="Hand it over anyway"
              variant="outline"
              size="compact"
              onPress={() => void done(true)}
            />
          )}
        </View>
      )}

      {view.phase === 'live' && (
        <View style={[styles.tools, { paddingBottom: insets.bottom + space.sm }]}>
          <View style={styles.row}>
            <Button
              title="Back"
              variant="ghost"
              size="compact"
              onPress={() => void send('back', { kind: 'back' })}
            />
            <Button
              title="Reload"
              variant="ghost"
              size="compact"
              disabled={!live}
              onPress={() => void send('reload', { kind: 'reload' })}
            />
            <Button
              title="Up"
              variant="ghost"
              size="compact"
              disabled={!live}
              onPress={() => scroll('up')}
            />
            <Button
              title="Down"
              variant="ghost"
              size="compact"
              disabled={!live}
              onPress={() => scroll('down')}
            />
            {KEYS.map((k) => (
              <Button
                key={k.key}
                title={k.label}
                variant="ghost"
                size="compact"
                disabled={!live}
                onPress={() => void send(k.key, { kind: 'key', key: k.key })}
              />
            ))}
          </View>
          <View style={styles.row}>
            <TextInput
              ref={field}
              testID="signin-field"
              secureTextEntry={view.secure}
              textContentType="none"
              autoComplete="off"
              importantForAutofill="no"
              autoCorrect={false}
              autoCapitalize="none"
              spellCheck={false}
              keyboardAppearance={appearance}
              placeholder={view.secure ? 'Password (hidden)' : 'Type here, then Type'}
              placeholderTextColor={colors.textMuted}
              accessibilityLabel={view.secure ? 'Password, hidden' : 'Text to type'}
              onChangeText={(v) => {
                text.current = v;
                setFilled(v.length > 0);
              }}
              onSubmitEditing={typeIt}
              returnKeyType="send"
              style={styles.field}
            />
            <Button
              title={view.secure ? 'Hidden' : 'Password'}
              variant="outline"
              size="compact"
              onPress={() => {
                wipe();
                dispatch({ t: 'secure', on: !view.secure });
              }}
              accessibilityLabel={view.secure ? 'Show what you type' : 'Hide what you type'}
              testID="signin-secure"
            />
            <Button
              title="Type"
              variant="answer"
              size="compact"
              disabled={!live || !filled}
              busy={busy === 'type'}
              onPress={typeIt}
              testID="signin-type"
            />
          </View>
        </View>
      )}
    </View>
  );
}

const useStyles = makeStyles((colors) => ({
  root: { flex: 1, backgroundColor: colors.surfaceApp },
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingHorizontal: space.lg,
    paddingVertical: space.sm,
  },
  titleWrap: { flex: 1, alignItems: 'center' },
  page: { flex: 1, backgroundColor: colors.surfacePanel },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  line: { gap: space.sm, paddingHorizontal: space.lg, paddingVertical: space.sm },
  tools: { gap: space.sm, paddingHorizontal: space.md, paddingTop: space.sm },
  row: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: space.xs },
  field: {
    flex: 1,
    minWidth: 120,
    color: colors.textPrimary,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    borderWidth: 1,
    borderRadius: radius.control,
    borderColor: colors.borderDefault,
  },
}));

/** A throw while drawing stays on this screen, with the way back. */
export { ScreenError as ErrorBoundary } from '../components/ScreenError';
