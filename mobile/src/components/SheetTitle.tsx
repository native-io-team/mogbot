/**
 * A sheet's title, apart from ui.tsx because it closes the sheet through the
 * router (and ui.tsx stays free of navigation).
 */

import { useRouter } from 'expo-router';
import type { ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import { useColors, useTextScale } from '../lib/appearance';
import { iconSize, lineHeight, space, track, tracking, type } from '../lib/theme';
import { IconButton, T } from './ui';

/** How far a sheet's title follows Dynamic Type: past this it crowds out the sheet. */
const SHEET_TITLE_SCALE = 1.6;

/**
 * A sheet's title: a header to VoiceOver, capped for Dynamic Type, and a ✕
 * that closes the sheet (the grabber's swipe is a gesture VoiceOver users
 * have to know). `trailing`: the sheet's own actions, beside the title.
 */
export function SheetTitle({
  children,
  close = true,
  leading,
  trailing,
  numberOfLines,
}: {
  children: ReactNode;
  close?: boolean;
  /** Before the title: a page's key, as the desk's page headers set one. */
  leading?: ReactNode;
  trailing?: ReactNode;
  numberOfLines?: number;
}) {
  const colors = useColors();
  const router = useRouter();
  // Read with the text size in force (it re-renders when that changes).
  useTextScale();
  // A step over a card's title, as the site's sheets set theirs: what the
  // sheet is reads first, over the groups' small capitals and their rows.
  const size = type.heading;
  return (
    <View style={styles.row}>
      {leading}
      <T
        variant="title"
        color={colors.textStrong}
        accessibilityRole="header"
        maxFontSizeMultiplier={SHEET_TITLE_SCALE}
        numberOfLines={numberOfLines}
        style={{
          flex: 1,
          fontSize: size,
          lineHeight: lineHeight(size, 1.25),
          letterSpacing: track(size, tracking.title),
        }}
      >
        {children}
      </T>
      {trailing}
      {close && (
        <IconButton
          name="xmark"
          label="Close"
          size={iconSize.body}
          fallback="×"
          onPress={() => (router.canGoBack() ? router.back() : router.replace('/'))}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  // The ✕ sits on the title's line; its 44pt target overhangs the sheet's padding a little.
  row: { flexDirection: 'row', alignItems: 'center', gap: space.sm, marginRight: -space.sm },
});
