/**
 * One image, full screen, on black: pinch to zoom, swipe down or Done to
 * close, Share to send it on. An attachment shows the Mac's thumbnail at
 * once and swaps in the full file when that has loaded; a file already on
 * the phone (`uri`, such as a preview screenshot) shows as it is.
 */

import { Image } from 'expo-image';
import { StatusBar } from 'expo-status-bar';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Spinner } from '../components/agent';
import { T } from '../components/ui';
import { share } from '../lib/files';
import { attachmentSource, describeError, download } from '../lib/session';
import { alpha, radius, space } from '../lib/theme';
import { makeStyles, useColors } from '../lib/appearance';

export default function Viewer() {
  const colors = useColors();
  const styles = useStyles();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const { agentId, path, name, mime, uri } = useLocalSearchParams<{
    agentId?: string;
    path?: string;
    name: string;
    mime: string;
    uri?: string;
  }>();
  const remote = agentId && path ? { agentId, path } : null;
  const [sharing, setSharing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const doShare = async () => {
    setSharing(true);
    try {
      await share(uri ?? (await download(remote!)), mime);
    } catch (e) {
      setError(describeError(e));
    } finally {
      setSharing(false);
    }
  };

  return (
    <View style={styles.root}>
      <ScrollView
        style={StyleSheet.absoluteFill}
        contentContainerStyle={{ width, height }}
        maximumZoomScale={4}
        minimumZoomScale={1}
        centerContent
        showsHorizontalScrollIndicator={false}
        showsVerticalScrollIndicator={false}
        bouncesZoom
        onScrollEndDrag={(e) => {
          // Pulled down past the top at normal zoom: close, as Photos does.
          if ((e.nativeEvent.zoomScale ?? 1) <= 1 && e.nativeEvent.contentOffset.y < -90)
            router.back();
        }}
      >
        <Image
          source={uri ? { uri } : remote && attachmentSource(remote.agentId, remote.path)}
          placeholder={remote ? attachmentSource(remote.agentId, remote.path, 232) : undefined}
          placeholderContentFit="contain"
          style={{ width, height }}
          contentFit="contain"
          transition={150}
          accessibilityLabel={name}
        />
      </ScrollView>
      {/* A photo sits on black in either appearance, so the clock is white over it. */}
      <StatusBar style="light" />
      <View style={[styles.bar, { paddingTop: insets.top + space.xs }]} pointerEvents="box-none">
        <Pressable
          onPress={() => router.back()}
          hitSlop={10}
          accessibilityRole="button"
          style={styles.pill}
        >
          <T variant="subhead" color={colors.onMedia}>
            Done
          </T>
        </Pressable>
        <View style={styles.nameWrap}>
          <T variant="small" color={colors.onMedia} numberOfLines={1} style={styles.name}>
            {name}
          </T>
        </View>
        <Pressable
          onPress={() => void doShare()}
          disabled={sharing}
          hitSlop={10}
          accessibilityRole="button"
          accessibilityLabel="Share"
          style={styles.pill}
        >
          {sharing ? (
            <Spinner size={14} color={colors.onMedia} />
          ) : (
            <T variant="subhead" color={colors.onMedia}>
              Share
            </T>
          )}
        </Pressable>
      </View>
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
  },
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
    borderRadius: radius.lg,
    backgroundColor: colors.mediaScrim,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: alpha(colors.onMedia, 0.2),
  },
}));
