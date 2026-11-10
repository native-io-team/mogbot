/** Header styling every stack shares: the root one and each tab's own, in the palette in force. */

import type { Stack } from 'expo-router';
import { useMemo, type ComponentProps } from 'react';
import { Platform } from 'react-native';
import { useColors } from './appearance';
import { fonts, radius, type Palette } from './theme';

type NativeStackNavigationOptions = Exclude<
  ComponentProps<typeof Stack.Screen>['options'],
  ((...args: never[]) => unknown) | undefined
>;

/**
 * A tab's root screen: the large title, over a list that runs under the bar.
 * Pass the result through `useMemo`: `Stack.Screen` calls `setOptions`
 * whenever its `options` object is new.
 *
 * **Translucent, not opaque, so pull to refresh is smooth.** Under a large
 * title UIKit hosts the list's refresh spinner in the navigation bar, which
 * grows by the spinner's height while it spins. With an opaque bar,
 * react-native-screens (iOS 26) lays the screen out *below* the bar with a
 * padding view; when the refresh ended the bar shrank in one step, the
 * padding followed, and the whole list jumped up 60pt with the title blinking
 * (recorded on the iOS Simulator, iPhone 16 Pro, iOS 26.1). Translucent, the
 * list runs under the bar, takes the bar's height as its own adjusted inset
 * (`contentInsetAdjustmentBehavior="automatic"`), and UIKit animates the
 * spinner away as in Mail. No background colour on the bar, either: on iOS 26
 * a large title over a coloured bar isn't drawn at all. So anything on these
 * screens that isn't the scrolling list sits under the bar unless it's padded
 * by `useHeaderHeight` (the iPad split's chat).
 *
 * **Android has neither large titles nor adjusted insets**
 * (`contentInsetAdjustmentBehavior` is iOS-only), so a transparent bar there
 * drew the list's first card under the title and the status bar (seen on the
 * API 35 emulator). There the bar is opaque and the screen starts below it;
 * `HEADER_OVERLAYS` says which, for what pads itself by the header's height.
 */
export const HEADER_OVERLAYS = Platform.OS !== 'android';
export const largeTitle = (
  colors: Palette,
  title: string,
  extra?: NativeStackNavigationOptions
): NativeStackNavigationOptions => ({
  title,
  headerLargeTitle: true,
  headerTransparent: HEADER_OVERLAYS,
  headerStyle: HEADER_OVERLAYS ? {} : { backgroundColor: colors.surfaceApp },
  ...(HEADER_OVERLAYS ? {} : { headerShadowVisible: false }),
  headerLargeTitleShadowVisible: false,
  headerLargeTitleStyle: { fontFamily: fonts.semibold, color: colors.textStrong },
  ...extra,
});

export const stackOptions = (colors: Palette): NativeStackNavigationOptions => ({
  headerStyle: { backgroundColor: colors.surfaceApp },
  headerTransparent: false,
  headerShadowVisible: false,
  headerTintColor: colors.textPrimary,
  headerTitleStyle: { fontFamily: fonts.semibold, color: colors.textStrong },
  headerBackButtonDisplayMode: 'minimal',
  contentStyle: { backgroundColor: colors.surfaceApp },
});

export function useStackOptions(): NativeStackNavigationOptions {
  const colors = useColors();
  return useMemo(() => stackOptions(colors), [colors]);
}

/**
 * A sheet that rises from the bottom: the agent sheet, a schedule, a session.
 * Always opaque in the palette in force: without a background iOS 26 draws
 * its own glass, which is light glass under dark text in one appearance and
 * the reverse in the other.
 */
export const sheet = (
  colors: Palette,
  detents: number[] = [0.6, 1],
  background: string = colors.surfacePanel
): NativeStackNavigationOptions => ({
  presentation: 'formSheet',
  sheetAllowedDetents: detents,
  sheetGrabberVisible: true,
  sheetCornerRadius: radius.sheet,
  headerShown: false,
  contentStyle: { backgroundColor: background },
});
