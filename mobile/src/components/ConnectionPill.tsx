/**
 * The connection's voice on the screens: nothing while all is well, a pill
 * or a slim banner when something isn't, and always a tap away from the full
 * picture on the Connection screen.
 */

import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import Animated, { FadeIn, FadeOut, LinearTransition } from 'react-native-reanimated';
import { useShallow } from 'zustand/react/shallow';
import type { LinkState } from '@shipstudio/companion-protocol';
import { CALM_MS, pill, problemBody } from '../lib/connection';
import { retryNow } from '../lib/session';
import { useApp } from '../lib/store';
import { useShowing } from '../lib/moving';
import { chromeScale, radius, space, PRESSED } from '../lib/theme';
import { makeStyles, useColors } from '../lib/appearance';
import { Spinner } from './agent';
import { Button, Dot, T, useToneColor } from './ui';

/**
 * Re-render every `ms` for "last seen 2 min ago", while anyone can see it:
 * the clock stops in the background and on a screen under another (a stack
 * keeps them mounted), and catches up at once when it shows again.
 */
export function useNow(ms = 15_000) {
  const [now, setNow] = useState(Date.now);
  const showing = useShowing();
  useEffect(() => {
    if (!showing) return;
    const tick = () => setNow(Date.now());
    const catchUp = setTimeout(tick, 0);
    const id = setInterval(tick, ms);
    return () => {
      clearTimeout(catchUp);
      clearInterval(id);
    };
  }, [ms, showing]);
  return now;
}

/**
 * The time for `pill`: `useNow`, plus a tick the moment the calm first
 * seconds of trying end, so "Reconnecting…" turns into what's true then
 * rather than at the next tick.
 */
export function useLinkNow(link: LinkState, ms = 15_000) {
  const now = useNow(ms);
  const [calmEnded, setCalmEnded] = useState(0);
  const since = link.kind === 'connecting' || link.kind === 'reconnecting' ? link.since : undefined;
  useEffect(() => {
    if (since == null) return;
    const timer = setTimeout(() => setCalmEnded(Date.now()), since + CALM_MS - Date.now() + 50);
    return () => clearTimeout(timer);
  }, [since]);
  return Math.max(now, calmEnded);
}

/** Everything `pill` and `layers` read, from the store. */
export function useLinkState() {
  return useApp(
    useShallow((s) => ({
      link: s.link,
      refusal: s.refusal,
      mac: s.mac,
      overview: s.overview,
      phoneOnline: s.phoneOnline,
      syncedAt: s.syncedAt,
      credentials: s.credentials,
    }))
  );
}

function ConnectionPill() {
  const colors = useColors();
  const styles = useStyles();
  const toneColor = useToneColor();
  const router = useRouter();
  const state = useLinkState();
  const p = pill(state, useLinkNow(state.link));
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${p.label}. Connection details`}
      hitSlop={8}
      onPress={() => router.push('/connection')}
      style={({ pressed }) => pressed && PRESSED}
    >
      <Animated.View layout={LinearTransition.duration(200)} style={styles.pill}>
        <Dot color={toneColor[p.tone]} glow={p.tone === 'ok'} />
        <Animated.View
          key={p.label}
          entering={FadeIn.duration(180)}
          exiting={FadeOut.duration(120)}
        >
          <T
            variant="small"
            color={colors.textPrimary}
            numberOfLines={1}
            maxFontSizeMultiplier={chromeScale}
          >
            {p.label}
          </T>
        </Animated.View>
      </Animated.View>
    </Pressable>
  );
}

/** Only when something is wrong: the state, and a tap to the reasons. */
export function ConnectionNotice() {
  const styles = useStyles();
  const state = useLinkState();
  const p = pill(state, useLinkNow(state.link));
  if (p.tone === 'ok' || state.link.kind === 'refused') return null;
  return (
    <Animated.View
      entering={FadeIn.duration(200)}
      exiting={FadeOut.duration(150)}
      style={styles.notice}
    >
      <ConnectionPill />
    </Animated.View>
  );
}

/**
 * A screen with nothing to show because the Mac isn't answering (the Agents
 * list, a chat opened from an alert with nothing saved): what's wrong in the
 * pill's words, what that means here, and what to do. Never a bare spinner:
 * while it's still connecting it says so, and past that it says why.
 */
export function LinkProblem({ what, macName }: { what: string; macName: string }) {
  const colors = useColors();
  const styles = useStyles();
  const router = useRouter();
  const state = useLinkState();
  const p = pill(state, useLinkNow(state.link));
  if (p.tone !== 'problem') {
    return (
      <View style={styles.connecting}>
        <Spinner />
        <T color={colors.textSecondary}>Connecting to {macName}…</T>
      </View>
    );
  }
  const refused = state.link.kind === 'refused';
  return (
    <View style={styles.problem}>
      <T variant="title" color={colors.textStrong} style={styles.center}>
        {p.label}
      </T>
      <T color={colors.textSecondary} style={styles.center}>
        {problemBody(state.link, macName, what)}
      </T>
      <View style={styles.problemActions}>
        <Button
          title="What’s wrong?"
          variant="outline"
          onPress={() => router.push('/connection')}
        />
        {/* A refusal is final until someone acts: trying again only asks the same question. */}
        {!refused && <Button title="Try again" onPress={() => retryNow()} />}
      </View>
    </View>
  );
}

/**
 * How long a link may be down before the chat's bar says so
 * (`ConversationBars`), unless it's plainly a problem: coming back to the app reconnects in about a second, and an amber
 * "Connecting…" flashing on every return said something was wrong when it wasn't.
 */
export const BANNER_GRACE_MS = 2000;

const useStyles = makeStyles((colors) => ({
  connecting: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  problem: { alignItems: 'center', gap: space.md, maxWidth: 360 },
  problemActions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'center',
    gap: space.sm,
  },
  center: { textAlign: 'center' },
  notice: { paddingHorizontal: space.lg, paddingBottom: space.sm, alignItems: 'flex-start' },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.tight,
    paddingHorizontal: space.md,
    paddingVertical: space.tight,
    minHeight: 32,
    borderRadius: radius.pill,
    backgroundColor: colors.surfacePanel,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderDefault,
    maxWidth: 320,
  },
}));
