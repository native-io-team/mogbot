/**
 * A screen that failed to draw: the app stays open, says so plainly, and
 * offers to try again (and to go back, inside a stack). The error goes to this
 * phone's crash log; the drafts were never in the screen, so they're as they
 * were.
 *
 * Every route exports it as its `ErrorBoundary` (expo-router wraps the route
 * in it), so a throw in one screen leaves the navigator, its header and its
 * back gesture working. The root layout's boundary is the last resort: it
 * replaces everything, so it also lets the splash go, or a throw before the
 * splash hid would leave the app on it for good.
 */

import type { ErrorBoundaryProps } from 'expo-router';
import { useRouter } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { useEffect } from 'react';
import { View } from 'react-native';
import { useColors } from '../lib/appearance';
import { recordCrash } from '../lib/crash';
import { space } from '../lib/theme';
import { Button, T } from './ui';

function Body({ error, retry, back }: ErrorBoundaryProps & { back?: () => void }) {
  const colors = useColors();
  useEffect(() => {
    void recordCrash(error, 'render', false).catch(() => {});
  }, [error]);
  return (
    <View
      testID="screen-error"
      style={{
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        gap: space.lg,
        padding: space.xl,
        backgroundColor: colors.surfaceApp,
      }}
    >
      {/* The desk's words for the same thing (AgentsErrorBoundary). */}
      <T variant="headline" color={colors.textStrong} style={{ textAlign: 'center' }}>
        This couldn’t be shown.
      </T>
      <T color={colors.textSecondary} style={{ textAlign: 'center' }}>
        Nothing was lost.
      </T>
      <Button title="Try again" onPress={() => void retry()} />
      {back ? <Button title="Go back" variant="ghost" onPress={back} /> : null}
    </View>
  );
}

/** A route's boundary: inside the navigator, so it can offer the way back. */
export function ScreenError(props: ErrorBoundaryProps) {
  const router = useRouter();
  let canGoBack = false;
  try {
    canGoBack = router.canGoBack();
  } catch {
    // No navigator state to ask: Try again is still there.
  }
  return <Body {...props} back={canGoBack ? () => router.back() : undefined} />;
}

/** The root layout's boundary: nothing else is drawn, splash included. */
export function RootError(props: ErrorBoundaryProps) {
  useEffect(() => {
    void SplashScreen.hideAsync().catch(() => {});
  }, []);
  return <Body {...props} />;
}
