/**
 * The connection's voice on the screens: nothing while all is well, one bar
 * when something isn't (`ConnectionBar`, worded by `lib/connection`'s
 * `linkBar`), and always a tap away from the full picture on the Connection
 * screen.
 */

import { useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import Animated, { FadeIn, FadeOut, LinearTransition } from 'react-native-reanimated';
import { useShallow } from 'zustand/react/shallow';
import type { LinkState } from '@shipstudio/companion-protocol';
import { announce } from '../lib/a11y';
import { CALM_MS, linkBar, pill, problemBody, type LinkBar } from '../lib/connection';
import { haptic } from '../lib/haptics';
import { retryNow } from '../lib/session';
import { useApp } from '../lib/store';
import { useShowing } from '../lib/moving';
import { depthOf, fonts, iconSize, radius, space } from '../lib/theme';
import { makeStyles, useColors } from '../lib/appearance';
import { Spinner } from './agent';
import { TextAction } from './surfaces';
import { Button, Dot, Icon, T } from './ui';

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

/**
 * What `ConnectionBar` shows: the link's bar (`linkBar`), held back for the
 * first moments of a calm reconnect (coming back to the app reconnects in
 * about a second), and, once a bar that was shown clears, "Back in touch"
 * for a moment before it goes. Shared with the chat's bar, so a tab and a
 * chat never say it differently.
 */
export function useLinkBar(): { bar: LinkBar | null; back: boolean } {
  const state = useLinkState();
  const now = useLinkNow(state.link, 10_000);
  const bar = linkBar(state, now);
  const down = !!bar;
  const [late, setLate] = useState(false);
  useEffect(() => {
    if (!down) return;
    const timer = setTimeout(() => setLate(true), BANNER_GRACE_MS);
    return () => {
      clearTimeout(timer);
      setLate(false);
    };
  }, [down]);
  const shown = bar && (late || bar.tone === 'problem') ? bar : null;
  // `accessibilityLiveRegion` is Android's only: VoiceOver is told when a
  // bar appears or its verdict changes (not each "2 min ago" tick), once
  // across the tabs that show it.
  const verdict = shown ? `${shown.kind}:${shown.title}` : null;
  const detail = useRef('');
  detail.current = shown ? `${shown.title}. ${shown.detail}` : '';
  useEffect(() => {
    if (!verdict) {
      if (state.link.kind === 'connected') lastBarSaid = null;
      return;
    }
    if (verdict === lastBarSaid) return;
    lastBarSaid = verdict;
    announce(detail.current, true);
  }, [verdict, state.link.kind]);
  // "Back in touch": only after a bar was actually on screen, and only on a real return.
  const wasShown = useRef(false);
  const [back, setBack] = useState(false);
  const connected = state.link.kind === 'connected' && !bar;
  useEffect(() => {
    if (shown) {
      wasShown.current = true;
      return;
    }
    if (!connected || !wasShown.current) return;
    wasShown.current = false;
    const on = setTimeout(() => {
      setBack(true);
      // Every tab has a bar: said once, not once per tab.
      if (Date.now() - lastBackSaid > BACK_MS) {
        lastBackSaid = Date.now();
        announce('Back in touch with your Mac');
      }
    }, 0);
    const off = setTimeout(() => setBack(false), BACK_MS);
    return () => {
      clearTimeout(on);
      clearTimeout(off);
      setBack(false);
    };
  }, [shown, connected]);
  return { bar: shown, back: back && !shown };
}

/** How long "Back in touch" stays. */
const BACK_MS = 2500;
let lastBackSaid = 0;
/** The bar's verdict VoiceOver was last told, until the link is back. */
let lastBarSaid: string | null = null;

/**
 * The one connection bar at the top of every tab, on the content margin:
 * what's wrong, when the phone last heard from the Mac, one Try again, and
 * "What to check" folded under it. What's listed below it stays readable:
 * it's the saved copy, and the bar says so once (no "as of" elsewhere).
 * Coming back, one quiet "Back in touch", then nothing.
 */
export function ConnectionBar({ style }: { style?: StyleProp<ViewStyle> }) {
  const colors = useColors();
  const styles = useStyles();
  const router = useRouter();
  const { bar, back } = useLinkBar();
  // "What to check" stays open for the state it was opened on; a new state starts folded.
  const [openFor, setOpenFor] = useState<string | null>(null);
  const open = !!bar && openFor === bar.kind;
  const setOpen = (fn: (o: boolean) => boolean) => setOpenFor(fn(open) && bar ? bar.kind : null);
  if (back) {
    return (
      <Animated.View
        entering={FadeIn.duration(200)}
        exiting={FadeOut.duration(300)}
        style={[styles.bar, style]}
        testID="connection-back"
      >
        <View style={styles.head}>
          <View style={styles.mark}>
            <Icon name="checkmark" size={iconSize.inline} color={colors.accentSuccess} />
          </View>
          <T variant="small" color={colors.textPrimary} style={styles.grow}>
            Back in touch with your Mac
          </T>
        </View>
      </Animated.View>
    );
  }
  if (!bar) return null;
  const tint = bar.tone === 'problem' ? colors.accentErrorLight : colors.accentWarning;
  return (
    <Animated.View
      entering={FadeIn.duration(200)}
      exiting={FadeOut.duration(150)}
      layout={LinearTransition.duration(200)}
      style={[styles.bar, style]}
      testID={`connection-bar-${bar.kind}`}
    >
      <View style={[styles.head, styles.top]}>
        <View style={[styles.mark, styles.markTop]}>
          <Dot color={tint} />
        </View>
        <View
          style={styles.words}
          accessible
          accessibilityLabel={`${bar.title}. ${bar.detail}`}
          accessibilityLiveRegion="polite"
        >
          <T variant="small" color={colors.textStrong} style={styles.title}>
            {bar.title}
          </T>
          <T variant="caption" color={colors.textSecondary}>
            {bar.detail}
          </T>
        </View>
        <Button
          title="Try again"
          variant="outline"
          size="compact"
          onPress={() => {
            haptic.select();
            retryNow();
          }}
        />
      </View>
      <View style={styles.foot}>
        <TextAction
          label="What to check"
          muted
          expanded={open}
          onPress={() => setOpen((o) => !o)}
        />
      </View>
      {open && (
        <Animated.View entering={FadeIn.duration(180)} style={styles.checks}>
          {bar.checks.map((line) => (
            <View key={line} style={styles.check}>
              <View style={styles.bullet}>
                <Dot color={colors.textMuted} size={space.xs} />
              </View>
              <T variant="small" color={colors.textSecondary} style={styles.grow}>
                {line}
              </T>
            </View>
          ))}
          <View style={styles.more}>
            <TextAction label="Connection details" onPress={() => router.push('/connection')} />
          </View>
        </Animated.View>
      )}
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
  const now = useLinkNow(state.link);
  const p = pill(state, now);
  const bar = linkBar(state, now);
  // The bar may know more than the pill (the app on the Mac seen stuck): same verdict here.
  if (p.tone !== 'problem' && bar?.tone !== 'problem') {
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
        {bar?.title ?? p.label}
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
  // The chat's bars' surface (surfaces.tsx), on the screen's content margin.
  bar: {
    gap: space.xs,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    borderRadius: radius.card,
    backgroundColor: colors.surfacePanel,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.cardBorder,
    boxShadow: depthOf(colors).card,
    overflow: 'hidden',
  },
  head: { flexDirection: 'row', alignItems: 'center', gap: space.sm, minHeight: 32 },
  // The dot sits on the title's line, however many lines the detail takes.
  top: { alignItems: 'flex-start' },
  mark: { width: iconSize.inline, alignItems: 'center' },
  markTop: { paddingTop: space.tight },
  words: { flex: 1, gap: space['2xs'] },
  title: { fontFamily: fonts.medium },
  grow: { flex: 1 },
  // Under the words, lined up with them.
  foot: { flexDirection: 'row', paddingLeft: iconSize.inline + space.sm },
  checks: { gap: space.sm, paddingLeft: iconSize.inline + space.sm, paddingBottom: space.xs },
  check: { flexDirection: 'row', alignItems: 'flex-start', gap: space.sm },
  // Centred on the first line of small text.
  bullet: { paddingTop: space.sm },
  more: { flexDirection: 'row' },
}));
