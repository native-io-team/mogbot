/**
 * Pictures, full screen, on black. Opened from a chat it is a gallery of
 * every picture in that chat (`galleryOf`, the desk's order too), starting
 * at the one tapped. Pinch (to 5×) or double-tap to zoom where the fingers
 * are, drag to look around; at fit, swipe sideways for the next and down (or
 * Done) to close; one tap hides "3 of 8", the caption and Share (to send or
 * save the one shown). The gestures run on the UI thread (`ZoomGallery`). An attachment shows the Mac's thumbnail
 * at once and swaps in the full file when that has loaded; a file already
 * on the phone (`uri`, such as a preview screenshot) shows as it is.
 */

import { galleryCounter, galleryKey, type GalleryImage } from '@shipstudio/companion-protocol';
import { StatusBar } from 'expo-status-bar';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { Pressable, StyleSheet, useWindowDimensions, View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Spinner } from '../components/agent';
import { T } from '../components/ui';
import { ZoomGallery, type ZoomPage } from '../components/ZoomGallery';
import { share } from '../lib/files';
import { getGallery, viewerStart } from '../lib/gallery';
import { attachmentSource, describeError, download } from '../lib/session';
import { IMAGE_UNAVAILABLE } from '../components/attachments';
import { alpha, iconSize, radius, space, PRESSED } from '../lib/theme';
import { makeStyles, useColors } from '../lib/appearance';

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
  const [sharing, setSharing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const shown = images[index] ?? null;
  const counter = galleryCounter(index, images.length);
  const caption = shown?.caption ?? name;
  const close = useCallback(() => router.back(), [router]);
  const turned = useCallback((at: number) => {
    setIndex(at);
    setError(null);
  }, []);

  // A file already on the phone is one page; a chat's pictures, one each.
  const pages = useMemo<ZoomPage[]>(() => {
    if (uri) {
      return [
        {
          key: uri,
          source: { uri },
          label: name,
          onError: () => setError(`${IMAGE_UNAVAILABLE}: ${name}`),
        },
      ];
    }
    return images.map((image) => ({
      key: image.key,
      source: attachmentSource(image.agentId, image.file.path),
      placeholder: attachmentSource(image.agentId, image.file.path, 232),
      label: image.caption ?? image.file.name,
      onError: () => setError(`${IMAGE_UNAVAILABLE}: ${image.file.name}`),
    }));
  }, [uri, name, images]);

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

  const overlay = (
    <>
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
    </>
  );

  return (
    <GestureHandlerRootView style={styles.root} testID="viewer">
      <ZoomGallery
        pages={pages}
        start={uri ? 0 : start}
        width={width}
        height={height}
        onIndex={turned}
        onClose={close}
        overlay={overlay}
      />
      {/* A photo sits on black in either appearance, so the clock is white over it. */}
      <StatusBar style="light" />
      {error && (
        <Pressable
          onPress={() => setError(null)}
          accessibilityRole="alert"
          accessibilityHint="Hides this"
          style={[styles.error, { bottom: insets.bottom + space.lg }]}
        >
          <T variant="small" color={colors.onMedia}>
            {error}
          </T>
        </Pressable>
      )}
    </GestureHandlerRootView>
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

/** A throw while drawing stays on this screen, with the way back. */
export { ScreenError as ErrorBoundary } from '../components/ScreenError';
