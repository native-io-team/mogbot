/**
 * Files in a conversation. Images show inline as the Mac's thumbnails (one
 * at its own shape, several as a grid) and open in the photo viewer; any
 * other file is a chip that opens in Quick Look, and long-press shares it.
 * Everything is fetched with this phone's token, and cached once fetched.
 * Files staged in the composer, before they're sent, are tiles here too.
 */

import type { Attachment } from '@shipstudio/companion-protocol';
import { Image } from 'expo-image';
import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import {
  extensionOf,
  formatSize,
  isPreviewableImage,
  preview,
  share,
  type PickedFile,
} from '../lib/files';
import { useChatGallery, viewerParams } from '../lib/gallery';
import { attachmentSource, describeError, download, retryAttachmentSource } from '../lib/session';
import { useAttachmentSources } from '../lib/relayImages';
import type { PendingAttachment } from '../lib/sync';
import { alpha, iconSize, radius, space, type, PRESSED } from '../lib/theme';
import { makeStyles, useColors } from '../lib/appearance';
import { Spinner } from './agent';
import { choose } from './menu';
import { Icon, T } from './ui';

/** Either a file on the Mac, or (before the Mac has it) the phone's own copy. */
export type Shown = Attachment & { localUri?: string };

const ONE_WIDE = 232;

/** What a tile says when its image can't be shown, above the file's name. */
export const IMAGE_UNAVAILABLE = 'Image not available';
const TILE = 112;

export function Attachments({
  agentId,
  attachments,
  align = 'left',
  width = ONE_WIDE,
  onError,
}: {
  agentId: string;
  attachments: Shown[];
  align?: 'left' | 'right';
  /** A lone image's width; a phone screenshot reads fine smaller. */
  width?: number;
  onError?: (text: string) => void;
}) {
  const styles = useStyles();
  const images = attachments.filter((a) => isPreviewableImage(a.mime));
  const others = attachments.filter((a) => !isPreviewableImage(a.mime));
  const end = align === 'right' ? 'flex-end' : 'flex-start';
  return (
    <View style={{ gap: space.tight, alignItems: end }}>
      {images.length === 1 ? (
        <Thumb agentId={agentId} file={images[0]} width={width} />
      ) : images.length > 1 ? (
        <View style={[styles.grid, { justifyContent: end }]}>
          {images.map((a) => (
            <Thumb key={a.path || a.localUri} agentId={agentId} file={a} width={TILE} square />
          ))}
        </View>
      ) : null}
      {others.map((a) => (
        <FileChip key={a.path || a.localUri} agentId={agentId} file={a} onError={onError} />
      ))}
    </View>
  );
}

/** How long a picture may take before its tile says it's loading. */
export const THUMB_SLOW_MS = 600;
/** A picture with no answer by then counts as failed: never a blank box. */
export const THUMB_GIVE_UP_MS = 30_000;
/** What a failed tile says under "Image not available". */
export const TAP_TO_RETRY = 'Tap to try again';

/**
 * A tile's size as two numbers, never `aspectRatio`: in the wrapping grid of
 * a many-picture card, iOS's layout gave `aspectRatio` tiles no height while
 * the grid kept the room for them, so a result card drew as one big blank box
 * (seen on a real iPhone; the web build lays out with CSS and never did).
 */
export const thumbSize = (width: number, ratio: number) => ({
  width,
  height: Math.round(width / ratio),
});

/**
 * One picture. Loading, failed and loaded are the same tile (one view, never
 * swapped for another): on iOS a view mounted in place of another while a
 * layout animation ran could stay invisible, and a ten-picture result card
 * drew as blank space. No fade either, for the same reason.
 */
function Thumb({
  agentId,
  file,
  width,
  square,
}: {
  agentId: string;
  file: Shown;
  width: number;
  square?: boolean;
}) {
  const styles = useStyles();
  const router = useRouter();
  const colors = useColors();
  // Opened, it pages through every picture in the chat, starting here.
  const gallery = useChatGallery();
  // Until it loads its shape is unknown; then it keeps its own, within reason.
  const [ratio, setRatio] = useState(square ? 1 : 4 / 3);
  // Kept by the address that failed (or loaded), so a picture fetched again
  // over the relay (a new file) gets its chance instead of staying failed.
  const [failedUri, setFailedUri] = useState<string | null>(null);
  const [loadedUri, setLoadedUri] = useState<string | null>(null);
  // "Tap to try again" on a direct route: the image view loads it afresh.
  const [attempt, setAttempt] = useState(0);
  // The address (and try) that has been loading a while.
  const [slowOn, setSlowOn] = useState<string | null>(null);
  // The address (and try) that had no answer in time.
  const [gaveUpOn, setGaveUpOn] = useState<string | null>(null);
  useAttachmentSources();
  const source = file.localUri
    ? { uri: file.localUri }
    : attachmentSource(agentId, file.path, width);
  const uri = source?.uri;
  const waitKey = `${uri ?? 'pending'}#${attempt}`;
  const failed = !source || (!!uri && (failedUri === uri || gaveUpOn === waitKey));
  const loaded = !failed && !!uri && loadedUri === uri;
  const loading = !failed && !loaded;

  // A loading tile shows a spinner after a short wait (a cached picture never
  // flashes one), and one with no answer in time counts as failed. Over the
  // relay, the fetch itself gives up (`RELAY_IMAGE_GIVE_UP_MS`).
  useEffect(() => {
    if (!loading) return;
    const showSpinner = setTimeout(() => setSlowOn(waitKey), THUMB_SLOW_MS);
    const giveUp = uri ? setTimeout(() => setGaveUpOn(waitKey), THUMB_GIVE_UP_MS) : undefined;
    return () => {
      clearTimeout(showSpinner);
      clearTimeout(giveUp);
    };
  }, [loading, uri, waitKey]);

  const retry = () => {
    setGaveUpOn(null);
    setFailedUri(null);
    setLoadedUri(null);
    setAttempt((n) => n + 1);
    if (!file.localUri) retryAttachmentSource(agentId, file.path, width);
  };

  const label = failed
    ? `${file.name}, ${IMAGE_UNAVAILABLE.toLowerCase()}. ${TAP_TO_RETRY}`
    : loading
      ? `${file.name}, image loading`
      : `${file.name}, image`;
  return (
    <Pressable
      testID={`thumb:${file.path || file.localUri}`}
      accessibilityRole={failed ? 'button' : 'imagebutton'}
      accessibilityLabel={label}
      disabled={loading || (!failed && !!file.localUri)}
      onPress={() => {
        if (failed) return retry();
        router.push({
          pathname: '/viewer',
          params: viewerParams(gallery, agentId, file),
        });
      }}
      style={({ pressed }) => [
        styles.thumb,
        thumbSize(width, failed ? (square ? 1 : 4 / 3) : ratio),
        failed && styles.missing,
        pressed && styles.pressed,
      ]}
    >
      {uri && !failed ? (
        // Never an Image with no address: expo-image calls that an error.
        <Image
          key={attempt}
          source={source}
          style={StyleSheet.absoluteFill}
          contentFit="cover"
          // A chat opened again (or scrolled back to) draws its pictures from
          // memory, already decoded, instead of reading and decoding them again.
          cachePolicy="memory-disk"
          recyclingKey={file.path || file.localUri}
          onError={() => setFailedUri(uri)}
          onLoad={(e) => {
            setLoadedUri(uri);
            if (square) return;
            const { width: w, height: h } = e.source;
            if (w && h) setRatio(Math.min(1.8, Math.max(0.62, w / h)));
          }}
        />
      ) : null}
      {loading && slowOn === waitKey ? (
        <View style={[StyleSheet.absoluteFill, styles.center]} testID="thumb-loading">
          <Spinner />
        </View>
      ) : null}
      {failed ? (
        <>
          <Icon
            name="arrow.clockwise"
            size={iconSize.body}
            color={colors.textMuted}
            fallback={<T color={colors.textMuted}>↻</T>}
          />
          <T variant="caption" color={colors.textSecondary} style={styles.missingName}>
            {IMAGE_UNAVAILABLE}
          </T>
          <T variant="caption" color={colors.textMuted} style={styles.missingName}>
            {TAP_TO_RETRY}
          </T>
          <T
            variant="caption"
            color={colors.textMuted}
            numberOfLines={1}
            style={styles.missingName}
          >
            {file.name}
          </T>
        </>
      ) : null}
    </Pressable>
  );
}

/** Open a file the way the phone opens files: Quick Look for documents. */
export async function openFile(agentId: string, file: Attachment) {
  const uri = await download({ agentId, path: file.path });
  await preview(uri, file.mime);
}

export function FileChip({
  agentId,
  file,
  onError,
}: {
  agentId: string;
  file: Shown;
  onError?: (text: string) => void;
}) {
  const colors = useColors();
  const styles = useStyles();
  const [busy, setBusy] = useState(false);
  const run = async (action: 'open' | 'share') => {
    if (file.localUri || busy) return;
    setBusy(true);
    try {
      if (action === 'open') await openFile(agentId, file);
      else await share(await download({ agentId, path: file.path }), file.mime);
    } catch (error) {
      onError?.(describeError(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${file.name}, ${formatSize(file.size)}. Opens in Quick Look`}
      onPress={() => void run('open')}
      onLongPress={() =>
        choose(file.name, [
          { label: 'Open', run: () => void run('open') },
          { label: 'Share…', run: () => void run('share') },
        ])
      }
      style={({ pressed }) => [styles.chip, pressed && styles.pressed]}
    >
      <View style={styles.badge}>
        {busy ? (
          <Spinner />
        ) : (
          <T variant="caption" color={colors.textSecondary} style={styles.badgeText}>
            {extensionOf(file.name)}
          </T>
        )}
      </View>
      <View style={{ flexShrink: 1, gap: space['2xs'] }}>
        <T variant="small" color={colors.textStrong} numberOfLines={1}>
          {file.name}
        </T>
        <T variant="caption" color={colors.textMuted}>
          {formatSize(file.size)}
        </T>
      </View>
    </Pressable>
  );
}

export interface Staged {
  key: string;
  file: PickedFile;
  progress: number;
  blob?: PendingAttachment;
  error?: string;
}

/** One file waiting to go: its picture or type, how far the upload is, and ×. */
export function StagedTile({
  item,
  onRemove,
  onRetry,
}: {
  item: Staged;
  onRemove: () => void;
  onRetry: () => void;
}) {
  const colors = useColors();
  const styles = useStyles();
  const { file, progress, blob, error } = item;
  return (
    <View style={styles.tile}>
      <Pressable
        disabled={!error}
        onPress={onRetry}
        accessibilityRole={error ? 'button' : 'image'}
        accessibilityLabel={error ? `${file.name} didn’t upload. Tap to try again` : file.name}
        style={({ pressed }) => [styles.tileBody, pressed && PRESSED]}
      >
        {isPreviewableImage(file.mime) ? (
          <Image source={{ uri: file.uri }} style={StyleSheet.absoluteFill} contentFit="cover" />
        ) : (
          <View style={styles.tileFile}>
            <T variant="caption" color={colors.textSecondary} style={styles.tileExt}>
              {extensionOf(file.name)}
            </T>
            <T
              variant="caption"
              color={colors.textSecondary}
              numberOfLines={2}
              style={styles.tileName}
            >
              {file.name}
            </T>
          </View>
        )}
        {!blob && (
          <View style={[StyleSheet.absoluteFill, styles.tileVeil]}>
            {error ? (
              <Icon
                name="arrow.clockwise"
                size={iconSize.body}
                color={colors.textStrong}
                fallback={<T>↻</T>}
              />
            ) : (
              <View style={styles.progressTrack}>
                <View style={[styles.progressFill, { width: `${Math.max(6, progress * 100)}%` }]} />
              </View>
            )}
          </View>
        )}
      </Pressable>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Remove ${file.name}`}
        hitSlop={12}
        onPress={onRemove}
        style={({ pressed }) => [styles.remove, pressed && PRESSED]}
      >
        <Icon
          name="xmark"
          size={iconSize.micro}
          color={colors.textStrong}
          fallback={<T variant="caption">×</T>}
        />
      </Pressable>
    </View>
  );
}

const useStyles = makeStyles((colors) => ({
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: space.xs,
    maxWidth: TILE * 2 + space.xs,
  },
  // No hairline: the image is its own edge.
  thumb: {
    borderRadius: radius.card,
    overflow: 'hidden',
    backgroundColor: colors.surfaceControl,
  },
  pressed: { opacity: 0.8, transform: [{ scale: 0.98 }] },
  missing: {
    alignItems: 'center',
    justifyContent: 'center',
    gap: space['2xs'],
    padding: space.sm,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.cardBorder,
  },
  missingName: { textAlign: 'center' },
  center: { alignItems: 'center', justifyContent: 'center' },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    maxWidth: 280,
    paddingVertical: space.sm,
    paddingLeft: space.sm,
    paddingRight: space.md,
    borderRadius: radius.card,
    backgroundColor: colors.surfacePanel,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.cardBorder,
  },
  badge: {
    width: 40,
    height: 40,
    borderRadius: radius.inner,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surfaceControl,
  },
  badgeText: { letterSpacing: 0.4, fontSize: type.micro },
  tile: { width: 64, height: 64, marginTop: space.tight, marginRight: space.tight },
  tileBody: {
    flex: 1,
    borderRadius: radius.control,
    overflow: 'hidden',
    backgroundColor: colors.surfaceControl,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.cardBorder,
  },
  tileFile: { flex: 1, padding: space.tight, justifyContent: 'space-between' },
  tileExt: { fontSize: type.micro, letterSpacing: 0.4 },
  tileName: { fontSize: type.micro, lineHeight: 12 },
  tileVeil: {
    backgroundColor: alpha(colors.surfaceApp, 0.55),
    alignItems: 'center',
    justifyContent: 'center',
  },
  progressTrack: {
    width: 40,
    height: 4,
    borderRadius: radius.pill,
    overflow: 'hidden',
    backgroundColor: alpha(colors.textStrong, 0.25),
  },
  progressFill: { height: 4, borderRadius: radius.pill, backgroundColor: colors.textStrong },
  remove: {
    position: 'absolute',
    top: -6,
    right: -6,
    width: 20,
    height: 20,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surfaceSelected,
    borderWidth: 2,
    borderColor: colors.surfaceApp,
  },
}));
