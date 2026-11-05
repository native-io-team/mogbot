/** Header styling every stack shares: the root one and each tab's own, in the palette in force. */

import type { Stack } from 'expo-router';
import { useMemo, type ComponentProps } from 'react';
import { useColors } from './appearance';
import { fonts, type Palette } from './theme';

type NativeStackNavigationOptions = Exclude<
  ComponentProps<typeof Stack.Screen>['options'],
  ((...args: never[]) => unknown) | undefined
>;

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
  sheetCornerRadius: 22,
  headerShown: false,
  contentStyle: { backgroundColor: background },
});
