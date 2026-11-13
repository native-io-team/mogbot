/**
 * A visual result's before and after, one page at a time: a slider over the
 * two pictures (drag to reveal the after), or the two side by side; a
 * switcher when the agent shot several pages; the agent's captions under
 * them. A tap opens the picture in the viewer, which pages through every
 * picture in the chat. A page with only one side shows that one picture.
 */

import { comparePageName, type Attachment, type ComparePage } from '@shipstudio/companion-protocol';
import { Image } from 'expo-image';
import { useRouter } from 'expo-router';
import { useMemo, useRef, useState } from 'react';
import { PanResponder, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { haptic } from '../lib/haptics';
import { makeStyles, useColors } from '../lib/appearance';
import { useChatGallery, viewerParams } from '../lib/gallery';
import { attachmentSource } from '../lib/session';
import { useAttachmentSources } from '../lib/relayImages';
import { radius, space, PRESSED } from '../lib/theme';
import { T } from './ui';

export type CompareMode = 'slider' | 'side';

/** Where the slider starts: halfway. */
const START = 0.5;
/** A touch that moved less than this is a tap. */
const TAP_SLOP = 6;
/** The slider's grip, a thin line with a round handle. */
const GRIP = 28;
/** The tallest a picture is drawn in the card (width / height). */
const MIN_RATIO = 3 / 4;

/** The words under a page: the agent's captions, else Before / After. */
export function compareCaption(page: ComparePage): string {
  const before = page.before ? (page.beforeLabel ?? 'Before') : null;
  const after = page.after ? (page.afterLabel ?? 'After') : null;
  return [before, after].filter(Boolean).join(' · ');
}

function Picture({
  agentId,
  file,
  width,
  ratio,
  onRatio,
}: {
  agentId: string;
  file: Attachment;
  width: number;
  ratio: number;
  onRatio?: (r: number) => void;
}) {
  useAttachmentSources();
  const colors = useColors();
  const source = attachmentSource(agentId, file.path, Math.round(width));
  // The box takes the shape; the picture only fills it, with no fade-in: a
  // fade the reshaping interrupted left the picture unpainted on the web build.
  // The box is always a visible surface, and never an Image with no address
  // (expo-image calls that an error): never blank space.
  return (
    <View
      style={{ width, height: Math.round(width / ratio), backgroundColor: colors.surfaceControl }}
    >
      {source?.uri ? (
        <Image
          source={source}
          style={StyleSheet.absoluteFill}
          contentFit="cover"
          contentPosition="top"
          recyclingKey={file.path}
          accessibilityIgnoresInvertColors
          onLoad={(e) => {
            const { width: w, height: h } = e.source;
            // A tall page shows its top: what changed reads there, and the card stays short.
            if (w && h && onRatio) onRatio(Math.min(1.8, Math.max(MIN_RATIO, w / h)));
          }}
        />
      ) : null}
    </View>
  );
}

function Slider({
  agentId,
  page,
  width,
  onOpen,
}: {
  agentId: string;
  page: Required<Pick<ComparePage, 'before' | 'after'>>;
  width: number;
  onOpen: (file: Attachment) => void;
}) {
  const colors = useColors();
  const styles = useStyles();
  const [at, setAt] = useState(START);
  const [ratio, setRatio] = useState(4 / 3);
  const atRef = useRef(at);
  atRef.current = at;
  const from = useRef(START);
  const pan = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        // Sideways is the slider's; up and down stay the chat's scroll.
        onMoveShouldSetPanResponder: (_, g) => Math.abs(g.dx) > Math.abs(g.dy),
        onPanResponderTerminationRequest: () => false,
        onPanResponderGrant: () => {
          from.current = atRef.current;
        },
        onPanResponderMove: (_, g) => {
          if (width > 0) setAt(Math.min(1, Math.max(0, from.current + g.dx / width)));
        },
        onPanResponderRelease: (e, g) => {
          if (Math.abs(g.dx) < TAP_SLOP && Math.abs(g.dy) < TAP_SLOP) {
            // A tap opens the side it landed on.
            const x = e.nativeEvent.locationX;
            onOpen(x < atRef.current * width ? page.before : page.after);
          }
        },
      }),
    [width, page.before, page.after, onOpen]
  );
  const split = at * width;
  return (
    <View
      {...pan.panHandlers}
      style={[styles.frame, { width }]}
      accessible
      accessibilityRole="adjustable"
      accessibilityLabel="Before and after"
      accessibilityValue={{ text: `${Math.round(at * 100)}% before` }}
      accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }, { name: 'activate' }]}
      onAccessibilityAction={(e) => {
        if (e.nativeEvent.actionName === 'increment') setAt((v) => Math.min(1, v + 0.25));
        else if (e.nativeEvent.actionName === 'decrement') setAt((v) => Math.max(0, v - 0.25));
        else onOpen(page.after);
      }}
      testID="compare-slider"
    >
      <Picture agentId={agentId} file={page.after} width={width} ratio={ratio} onRatio={setRatio} />
      <View style={[StyleSheet.absoluteFill, { width: split, overflow: 'hidden' }]}>
        <Picture agentId={agentId} file={page.before} width={width} ratio={ratio} />
      </View>
      <View style={[styles.line, { left: split - StyleSheet.hairlineWidth }]} pointerEvents="none">
        <View style={[styles.grip, { backgroundColor: colors.onMedia }]} />
      </View>
      <T variant="caption" color={colors.onMedia} style={[styles.tag, styles.tagLeft]}>
        Before
      </T>
      <T variant="caption" color={colors.onMedia} style={[styles.tag, styles.tagRight]}>
        After
      </T>
    </View>
  );
}

function Side({
  agentId,
  page,
  width,
  onOpen,
}: {
  agentId: string;
  page: ComparePage;
  width: number;
  onOpen: (file: Attachment) => void;
}) {
  const colors = useColors();
  const styles = useStyles();
  const sides: [string, Attachment, string | undefined][] = [];
  if (page.before) sides.push(['Before', page.before, page.beforeLabel]);
  if (page.after) sides.push(['After', page.after, page.afterLabel]);
  const each = sides.length > 1 ? (width - space.sm) / 2 : width;
  return (
    <View style={styles.side} testID="compare-side">
      {sides.map(([role, file, label]) => (
        <Pressable
          key={role}
          onPress={() => onOpen(file)}
          accessibilityRole="imagebutton"
          accessibilityLabel={`${label ?? role}, image`}
          style={({ pressed }) => [{ width: each, gap: space.xs }, pressed && PRESSED]}
        >
          <View style={styles.frame}>
            <Picture
              agentId={agentId}
              file={file}
              width={each}
              ratio={sides.length > 1 ? 3 / 4 : 4 / 3}
            />
          </View>
          <T variant="caption" color={colors.textMuted} numberOfLines={2}>
            {label ?? role}
          </T>
        </Pressable>
      ))}
    </View>
  );
}

export function Compare({ agentId, pages }: { agentId: string; pages: ComparePage[] }) {
  const colors = useColors();
  const styles = useStyles();
  const router = useRouter();
  const gallery = useChatGallery();
  const [width, setWidth] = useState(0);
  const [index, setIndex] = useState(0);
  const [mode, setMode] = useState<CompareMode>('slider');
  const page = pages[Math.min(index, pages.length - 1)];
  if (!page) return null;
  const both = !!page.before && !!page.after;
  const open = (file: Attachment) => {
    router.push({ pathname: '/viewer', params: viewerParams(gallery, agentId, file) });
  };
  return (
    <View
      style={{ gap: space.sm }}
      onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
      testID="result-compare"
    >
      {pages.length > 1 && (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.pages}
          accessibilityRole="tablist"
        >
          {pages.map((p, i) => {
            const on = i === index;
            return (
              <Pressable
                key={`${i}:${p.page}`}
                accessibilityRole="tab"
                accessibilityState={{ selected: on }}
                onPress={() => {
                  haptic.select();
                  setIndex(i);
                }}
                style={({ pressed }) => [
                  styles.pageChip,
                  on && {
                    backgroundColor: colors.surfaceSelected,
                    borderColor: colors.borderStrong,
                  },
                  pressed && PRESSED,
                ]}
              >
                <T variant="small" color={on ? colors.textPrimary : colors.textSecondary}>
                  {comparePageName(p, i)}
                </T>
              </Pressable>
            );
          })}
        </ScrollView>
      )}
      {width > 0 &&
        (both && mode === 'slider' ? (
          <Slider
            key={`${index}`}
            agentId={agentId}
            page={{ before: page.before!, after: page.after! }}
            width={width}
            onOpen={open}
          />
        ) : (
          <Side agentId={agentId} page={page} width={width} onOpen={open} />
        ))}
      <View style={styles.foot}>
        {/* Side by side, each picture carries its own caption. */}
        <T variant="caption" color={colors.textMuted} numberOfLines={2} style={{ flex: 1 }}>
          {both && mode === 'slider' ? compareCaption(page) : ''}
        </T>
        {both && (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={mode === 'slider' ? 'Show side by side' : 'Show as a slider'}
            hitSlop={10}
            onPress={() => {
              haptic.select();
              setMode((m) => (m === 'slider' ? 'side' : 'slider'));
            }}
            style={({ pressed }) => pressed && PRESSED}
            testID="compare-mode"
          >
            <T variant="caption" color={colors.textSecondary} style={styles.mode}>
              {mode === 'slider' ? 'Side by side' : 'Slider'}
            </T>
          </Pressable>
        )}
      </View>
    </View>
  );
}

const useStyles = makeStyles((colors) => ({
  frame: {
    borderRadius: radius.inner,
    overflow: 'hidden',
    backgroundColor: colors.surfaceControl,
  },
  line: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    width: StyleSheet.hairlineWidth * 2,
    backgroundColor: colors.onMedia,
    alignItems: 'center',
    justifyContent: 'center',
  },
  grip: { width: GRIP / 2, height: GRIP, borderRadius: radius.pill },
  tag: {
    position: 'absolute',
    top: space.sm,
    paddingHorizontal: space.tight,
    paddingVertical: space['2xs'],
    borderRadius: radius.sm,
    overflow: 'hidden',
    backgroundColor: colors.mediaScrim,
  },
  tagLeft: { left: space.sm },
  tagRight: { right: space.sm },
  side: { flexDirection: 'row', gap: space.sm },
  pages: { gap: space.tight },
  pageChip: {
    paddingHorizontal: space.md,
    paddingVertical: space.tight,
    borderRadius: radius.pill,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle,
    backgroundColor: colors.surfaceControl,
  },
  foot: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  mode: { fontWeight: '600' as const },
}));
