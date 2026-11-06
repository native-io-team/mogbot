/**
 * Pictures, full screen, on black. Opened from a chat it is a gallery of
 * every picture in that chat (`galleryOf`, the desk's order too), starting
 * at the one tapped: swipe sideways for the next, pinch or double-tap to
 * zoom, swipe down or Done to close, "3 of 8" and the caption over it,
 * Share to send the one shown on. An attachment shows the Mac's thumbnail
 * at once and swaps in the full file when that has loaded; a file already
 * on the phone (`uri`, such as a preview screenshot) shows as it is.
 */

import { galleryCounter, galleryKey, type GalleryImage } from '@shipstudio/companion-protocol';
import { Image } from 'expo-image';
import { StatusBar } from 'expo-status-bar';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useMemo, useRef, useState, type ComponentRef } from 'react';
import {
  FlatList,
  Pressable,
  ScrollView,
  StyleSheet,
  useWindowDimensions,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Spinner } from '../components/agent';
import { T } from '../components/ui';
import { share } from '../lib/files';
import { getGallery, viewerStart } from '../lib/gallery';
import { attachmentSource, describeError, download } from '../lib/session';
import { IMAGE_UNAVAILABLE } from '../components/attachments';
import { alpha, iconSize, radius, space, PRESSED } from '../lib/theme';
import { makeStyles, useColors } from '../lib/appearance';

/** Pulled down this far past the top, at normal zoom, closes, as Photos does. */
const CLOSE_PULL = 90;
/** Two taps this close together zoom in (or back out). */
const DOUBLE_TAP_MS = 280;
const MAX_ZOOM = 4;
const TAP_ZOOM = 2.5;

/** One page: a picture that zooms on its own. */
function Page({
  image,
  uri,
  width,
  height,
  onClose,
  onZoomed,
  onError,
}: {
  image: GalleryImage | null;
  uri?: string;
  width: number;
  height: number;
  onClose: () => void;
  onZoomed: (zoomed: boolean) => void;
  onError: (text: string) => void;
}) {
  const scroll = useRef<ComponentRef<typeof ScrollView>>(null);
  const zoom = useRef(1);
  const lastTap = useRef(0);
  const name = image?.file.name ?? '';
  const remote = image ? { agentId: image.agentId, path: image.file.path } : null;

  const tapped = (x: number, y: number) => {
    const now = Date.now();
    if (now - lastTap.current > DOUBLE_TAP_MS) {
      lastTap.current = now;
      return;
    }
    lastTap.current = 0;
    const zoomIn = zoom.current <= 1.01;
    const w = zoomIn ? width / TAP_ZOOM : width;
    const h = zoomIn ? height / TAP_ZOOM : height;
    // iOS zooms a ScrollView to a rectangle; Android has no zooming ScrollView.
    const responder = scroll.current as unknown as {
      scrollResponderZoomTo?: (r: {
        x: number;
        y: number;
        width: number;
        height: number;
        animated: boolean;
      }) => void;
    } | null;
    responder?.scrollResponderZoomTo?.({
      x: zoomIn ? x - w / 2 : 0,
      y: zoomIn ? y - h / 2 : 0,
      width: w,
      height: h,
      animated: true,
    });
  };

  const onScroll = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const z = e.nativeEvent.zoomScale ?? 1;
    if (z > 1.01 !== zoom.current > 1.01) onZoomed(z > 1.01);
    zoom.current = z;
  };

  return (
    <ScrollView
      ref={scroll}
      style={{ width, height }}
      contentContainerStyle={{ width, height }}
      maximumZoomScale={MAX_ZOOM}
      minimumZoomScale={1}
      centerContent
      alwaysBounceVertical
      showsHorizontalScrollIndicator={false}
      showsVerticalScrollIndicator={false}
      bouncesZoom
      scrollEventThrottle={32}
      onScroll={onScroll}
      onScrollEndDrag={(e) => {
        if ((e.nativeEvent.zoomScale ?? 1) <= 1 && e.nativeEvent.contentOffset.y < -CLOSE_PULL)
          onClose();
      }}
    >
      <Pressable
        onPress={(e) => tapped(e.nativeEvent.locationX, e.nativeEvent.locationY)}
        accessibilityRole="image"
        accessibilityLabel={image?.caption ?? name}
        accessibilityHint="Double-tap to zoom"
        testID="viewer-page"
      >
        <Image
          source={uri ? { uri } : remote && attachmentSource(remote.agentId, remote.path)}
          placeholder={remote ? attachmentSource(remote.agentId, remote.path, 232) : undefined}
          placeholderContentFit="contain"
          style={{ width, height }}
          contentFit="contain"
          transition={150}
          recyclingKey={image?.key ?? uri}
          onError={() => onError(`${IMAGE_UNAVAILABLE}: ${name}`)}
        />
      </Pressable>
    </ScrollView>
  );
}

export default function Viewer() {
  const colors = useColors();
  const styles = useStyles();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const params = useLocalSearchParams<{
    agentId?: string;
    path?: string;
    name: string;
    mime: string;
    uri?: string;
    gallery?: string;
  }>();
  const { agentId, path, name, mime, uri } = params;

  // The chat's pictures when it handed them over, else just the one opened.
  const images = useMemo<GalleryImage[]>(() => {
    const kept = getGallery(params.gallery);
    if (kept?.length) return kept;
    if (!agentId || !path) return [];
    return [
      {
        key: galleryKey(agentId, path),
        agentId,
        messageId: '',
        file: { name, path, mime, size: 0 },
        caption: name,
      },
    ];
  }, [params.gallery, agentId, path, name, mime]);
  const start = useMemo(() => viewerStart(images, agentId, path), [images, agentId, path]);
  const [index, setIndex] = useState(start);
  const [zoomed, setZoomed] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const shown = images[index] ?? null;
  const counter = galleryCounter(index, images.length);
  const caption = shown?.caption ?? name;
  const close = useCallback(() => router.back(), [router]);

  const doShare = async () => {
    setSharing(true);
    try {
      const file = uri ?? (await download({ agentId: shown!.agentId, path: shown!.file.path }));
      await share(file, shown?.file.mime ?? mime);
    } catch (e) {
      setError(describeError(e));
    } finally {
      setSharing(false);
    }
  };

  return (
    <View style={styles.root} testID="viewer">
      {uri ? (
        <Page
          image={null}
          uri={uri}
          width={width}
          height={height}
          onClose={close}
          onZoomed={setZoomed}
          onError={setError}
        />
      ) : (
        <FlatList
          data={images}
          keyExtractor={(g) => g.key}
          horizontal
          pagingEnabled
          // Zoomed in, a drag pans the picture rather than turning the page.
          scrollEnabled={!zoomed}
          initialScrollIndex={start}
          getItemLayout={(_, i) => ({ length: width, offset: width * i, index: i })}
          showsHorizontalScrollIndicator={false}
          windowSize={3}
          initialNumToRender={1}
          onMomentumScrollEnd={(e) => {
            const at = Math.round(e.nativeEvent.contentOffset.x / Math.max(width, 1));
            if (at !== index) {
              setIndex(at);
              setError(null);
            }
          }}
          renderItem={({ item }) => (
            <Page
              image={item}
              width={width}
              height={height}
              onClose={close}
              onZoomed={setZoomed}
              onError={setError}
            />
          )}
          style={StyleSheet.absoluteFill}
          testID="viewer-pages"
        />
      )}
      {/* A photo sits on black in either appearance, so the clock is white over it. */}
      <StatusBar style="light" />
      <View style={[styles.bar, { paddingTop: insets.top + space.xs }]} pointerEvents="box-none">
        <Pressable
          onPress={close}
          hitSlop={10}
          accessibilityRole="button"
          style={({ pressed }) => [styles.pill, pressed && PRESSED]}
        >
          <T variant="subhead" color={colors.onMedia}>
            Done
          </T>
        </Pressable>
        <View style={styles.nameWrap}>
          {counter && (
            <T
              variant="small"
              color={colors.onMedia}
              style={styles.name}
              accessibilityLiveRegion="polite"
              testID="viewer-counter"
            >
              {counter}
            </T>
          )}
        </View>
        <Pressable
          onPress={() => void doShare()}
          disabled={sharing}
          hitSlop={10}
          accessibilityRole="button"
          accessibilityLabel="Share"
          style={({ pressed }) => [styles.pill, pressed && PRESSED]}
        >
          {sharing ? (
            <Spinner size={iconSize.body} color={colors.onMedia} />
          ) : (
            <T variant="subhead" color={colors.onMedia}>
              Share
            </T>
          )}
        </Pressable>
      </View>
      {!!caption && !error && (
        <View
          style={[styles.captionWrap, { bottom: 0, paddingBottom: insets.bottom + space.lg }]}
          pointerEvents="none"
        >
          <T
            variant="small"
            color={colors.onMedia}
            numberOfLines={2}
            style={styles.caption}
            testID="viewer-caption"
          >
            {caption}
          </T>
        </View>
      )}
      {error && (
        <Pressable
          onPress={() => setError(null)}
          style={[styles.error, { bottom: insets.bottom + space.lg }]}
        >
          <T variant="small" color={colors.onMedia}>
            {error}
          </T>
        </Pressable>
      )}
    </View>
  );
}

const useStyles = makeStyles((colors) => ({
  root: { flex: 1, backgroundColor: colors.black },
  bar: {
    position: 'absolute',
    left: 0,
    right: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingHorizontal: space.lg,
  },
  nameWrap: { flex: 1, alignItems: 'center' },
  name: {
    maxWidth: '100%',
    paddingHorizontal: space.md,
    paddingVertical: space.tight,
    borderRadius: radius.pill,
    overflow: 'hidden',
    backgroundColor: colors.mediaScrim,
    fontVariant: ['tabular-nums'],
  },
  captionWrap: {
    position: 'absolute',
    left: 0,
    right: 0,
    paddingHorizontal: space.lg,
    paddingTop: space.md,
    backgroundColor: colors.mediaScrim,
    alignItems: 'center',
  },
  caption: { textAlign: 'center' },
  pill: {
    minWidth: 64,
    height: 34,
    paddingHorizontal: space.md,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.mediaScrim,
  },
  error: {
    position: 'absolute',
    left: space.lg,
    right: space.lg,
    padding: space.md,
    borderRadius: radius.card,
    backgroundColor: colors.mediaScrim,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: alpha(colors.onMedia, 0.2),
  },
}));
