/** Header styling every stack shares: the root one and each tab's own, in the palette in force. */

import type { Stack } from 'expo-router';
import { useMemo, type ComponentProps } from 'react';
import { useColors } from './appearance';
import { fonts, radius, type Palette } from './theme';

type NativeStackNavigationOptions = Exclude<
  ComponentProps<typeof Stack.Screen>['options'],
  ((...args: never[]) => unknown) | undefined
>;

/**
 * A tab's root screen: the large title, flush with the page. Pass the result
 * through `useMemo`: `Stack.Screen` calls `setOptions` whenever its `options`
 * object is new, and a header rebuilt on every render (each overview push,
 * each turn of a pull to refresh) re-applies the navigation bar under a
 * large title mid-gesture, which is one of the ways a pull can end janky or
 * held part-way down.
 */
export const largeTitle = (
  colors: Palette,
  title: string,
  extra?: NativeStackNavigationOptions
): NativeStackNavigationOptions => ({
  title,
  headerLargeTitle: true,
  headerLargeTitleShadowVisible: false,
  headerLargeStyle: { backgroundColor: colors.surfaceApp },
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
