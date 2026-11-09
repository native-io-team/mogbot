/**
 * A sideways-scrolling well (a command, a code block, a table, a diff) that
 * says when it runs past the edge. iOS hides a scroll indicator until
 * something scrolls, so a line cut at the edge looked like the whole of it:
 * `pnpm deploy --pr` read as the command. While there is more to the right,
 * the far edge fades into the well's own colour, and the indicator flashes
 * once the first time it does. Scrolled to the end, the fade goes.
 */

import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  type LayoutChangeEvent,
  type ScrollViewInstance,
  ScrollView,
  type StyleProp,
  StyleSheet,
  View,
  type ViewStyle,
} from 'react-native';
import { moreToTheRight } from '../lib/overflow';
import { chatFade } from '../lib/theme';

export function SideScroll({
  fade,
  children,
  style,
  contentContainerStyle,
  indicator = true,
  testID,
}: {
  /** The well's background: what the far edge fades into. */
  fade: string;
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
  contentContainerStyle?: StyleProp<ViewStyle>;
  /** The scroll indicator; a table or code block keeps it off and leans on the fade. */
  indicator?: boolean;
  testID?: string;
}) {
  const scroll = useRef<ScrollViewInstance>(null);
  const [view, setView] = useState(0);
  const [content, setContent] = useState(0);
  const [x, setX] = useState(0);
  const more = moreToTheRight(content, view, x);
  const flashed = useRef(false);
  useEffect(() => {
    if (more && indicator && !flashed.current) {
      flashed.current = true;
      scroll.current?.flashScrollIndicators?.();
    }
  }, [more, indicator]);
  return (
    <View style={style}>
      <ScrollView
        ref={scroll}
        testID={testID}
        horizontal
        showsHorizontalScrollIndicator={indicator}
        contentContainerStyle={contentContainerStyle}
        onLayout={(e: LayoutChangeEvent) => setView(e.nativeEvent.layout.width)}
        onContentSizeChange={(w) => setContent(w)}
        onScroll={(e) => setX(e.nativeEvent.contentOffset.x)}
        scrollEventThrottle={32}
        accessibilityHint={more ? 'Runs past the edge: scroll sideways to read it all' : undefined}
      >
        {children}
      </ScrollView>
      {more && <SideFade color={fade} testID={testID && `${testID}-more`} />}
    </View>
  );
}

/** The well's colour in `chatFade.bands` steps, clear inward. Never takes a tap or focus. */
function SideFade({ color, testID }: { color: string; testID?: string }) {
  const bands = Array.from({ length: chatFade.bands }, (_, i) => {
    const t = (i + 1) / chatFade.bands;
    return t * t;
  });
  return (
    <View
      testID={testID}
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={styles.fade}
    >
      {bands.map((opacity, i) => (
        <View key={i} style={{ flex: 1, backgroundColor: color, opacity }} />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  fade: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    width: chatFade.height * 1.5,
    flexDirection: 'row',
  },
});
