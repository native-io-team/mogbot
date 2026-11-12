/**
 * "Send to agent…": what was shared into the app, and the agents to hand it
 * to. Picking one puts it in that agent's composer (the words as a quote
 * above whatever you'd typed, which stays as it was; the files uploaded to
 * the Mac as attachments) and opens the chat, for you to add a line and
 * send. Nothing is sent from here.
 *
 * Files come only from the share sheet, through the in-memory hand-over in
 * `lib/share.ts`. A `share?` link brings words alone, shown in full and
 * marked as from a link (`fromLinkParams`).
 */

import { MAX_ATTACHMENTS, type Agent } from '@shipstudio/companion-protocol';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { FlatList, Pressable, StyleSheet, View } from 'react-native';
import { AgentKey } from '../components/AgentKey';
import { Button, SectionTitle, SheetPage, T, useRipple } from '../components/ui';
import { SheetTitle } from '../components/SheetTitle';
import { makeStyles, useColors } from '../lib/appearance';
import { sortAgents } from '../lib/agents';
import { addFile, addQuote } from '../lib/drafts';
import { admit } from '../lib/files';
import { haptic } from '../lib/haptics';
import { canCall, describeError, upload } from '../lib/session';
import {
  describeShare,
  isEmptyShare,
  payloadForRoute,
  releaseShare,
  sharedQuote,
  type SharedPayload,
} from '../lib/share';
import { getApp, useApp } from '../lib/store';
import { keySize, radius, space } from '../lib/theme';
import { useComputer } from '../lib/computer';

export default function Share() {
  const comp = useComputer();
  const colors = useColors();
  const styles = useStyles();
  const router = useRouter();
  const params = useLocalSearchParams();
  // Read once: the share sheet's payload is released when the screen goes.
  const [payload] = useState(() => payloadForRoute(params));
  const key = typeof params.k === 'string' ? params.k : undefined;
  useEffect(() => () => releaseShare(key), [key]);
  const overview = useApp((s) => s.overview);
  const connected = useApp((s) => s.link.kind === 'connected');
  const canAttach = useApp((s) => canCall('agents.files', s.welcome));
  const macName = useApp((s) => s.credentials?.name) ?? comp.your;
  const [busy, setBusy] = useState<{ agentId: string; note: string } | null>(null);
  // Synchronous, unlike `busy`: a second tap in the same frame, on this row
  // or another, never adds the quote twice.
  const delivering = useRef(false);
  const agents = useMemo(
    () => sortAgents(overview?.agents ?? []).filter((a) => !a.hidden),
    [overview]
  );
  const files = payload.files ?? [];
  const filesBlocked = files.length > 0 && (!connected || !canAttach);

  /**
   * Delivered once, to one agent: the quote goes in, the files go up, and
   * the chat opens whatever happened. What didn't make it (a failed upload,
   * files past the cap) is said in that chat, where the draft is, rather
   * than on a sheet that has already put the words somewhere.
   */
  const deliver = async (agent: Agent) => {
    if (delivering.current) return;
    delivering.current = true;
    haptic.select();
    const draft = getApp().composer[agent.id];
    // A quote above the draft, never mixed into what was typed there.
    addQuote(agent.id, sharedQuote(payload));
    let notice: string | undefined;
    if (files.length && !filesBlocked) {
      const room = MAX_ATTACHMENTS - (draft?.files?.length ?? 0);
      const { kept, refused } = admit(files, room);
      let sent = 0;
      try {
        for (const [i, file] of kept.entries()) {
          setBusy({
            agentId: agent.id,
            note: kept.length > 1 ? `Uploading ${i + 1} of ${kept.length}…` : 'Uploading…',
          });
          await upload(file).then((ref) =>
            addFile(agent.id, {
              blobId: ref.blobId,
              uri: file.uri,
              name: ref.name,
              mime: ref.mime,
              size: ref.size,
              stagedAt: Date.now(),
            })
          );
          sent++;
        }
        notice = refused ?? undefined;
      } catch (e) {
        haptic.error();
        const left = kept.length - sent;
        notice = `${describeError(e)} ${left === 1 ? '1 file' : `${left} files`} didn’t attach; attach ${left === 1 ? 'it' : 'them'} here.`;
      }
    }
    setBusy(null);
    router.replace({
      pathname: '/chat/[id]',
      params: { id: agent.id, compose: '1', ...(notice ? { notice } : {}) },
    });
  };

  if (isEmptyShare(payload)) {
    return (
      <SheetPage>
        <View style={styles.root}>
          <SheetTitle>Nothing to send</SheetTitle>
          <T color={colors.textSecondary}>
            What was shared didn’t reach the app. Share it again, or paste it into a chat.
          </T>
          <Button title="Close" onPress={() => router.back()} />
        </View>
      </SheetPage>
    );
  }

  return (
    <SheetPage>
      <FlatList
        data={agents}
        keyExtractor={(a) => a.id}
        contentContainerStyle={styles.list}
        ListHeaderComponent={
          <View style={styles.header}>
            <SheetTitle>Send to agent…</SheetTitle>
            <Preview payload={payload} />
            {filesBlocked && (
              <T variant="caption" color={colors.textSecondary}>
                {connected
                  ? `${macName} can’t take files from this phone yet, so only the words go.`
                  : `Files need ${macName}: only the words go while it’s away.`}
              </T>
            )}

            <SectionTitle title="Put it in a chat for you to send" style={styles.eyebrow} />
          </View>
        }
        ListEmptyComponent={
          <T color={colors.textSecondary} style={styles.empty}>
            {overview
              ? 'No agents yet.'
              : connected
                ? `Connecting to ${macName}…`
                : `${macName} is away. Your agents show here once it’s back.`}
          </T>
        }
        renderItem={({ item, index }) => (
          <AgentChoice
            agent={item}
            first={index === 0}
            last={index === agents.length - 1}
            note={busy?.agentId === item.id ? busy.note : null}
            disabled={!!busy}
            onPress={() => void deliver(item)}
          />
        )}
      />
    </SheetPage>
  );
}

function Preview({ payload }: { payload: SharedPayload }) {
  const colors = useColors();
  const styles = useStyles();
  const files = payload.files ?? [];
  const what = describeShare(payload);
  return (
    <View
      style={styles.preview}
      accessibilityLabel={`Shared: ${what}${payload.fromLink ? ', from a link' : ''}`}
    >
      <T variant="caption" color={colors.textMuted}>
        {payload.fromLink ? `${what}, from a link. Read it before you send it.` : what}
      </T>
      {payload.title && (
        <T variant="headline" color={colors.textStrong} numberOfLines={2}>
          {payload.title}
        </T>
      )}
      {payload.url && (
        <T variant="small" color={colors.textSecondary} numberOfLines={1}>
          {payload.url}
        </T>
      )}
      {payload.text && (
        // In full: this is what goes into the chat, and you should see all of it first.
        <T variant="small" color={colors.textPrimary} selectable>
          {payload.text}
        </T>
      )}
      {files.length > 0 && (
        <T variant="small" color={colors.textSecondary} numberOfLines={2}>
          {files.map((f) => f.name).join(', ')}
        </T>
      )}
    </View>
  );
}

function AgentChoice({
  agent,
  first,
  last,
  note,
  disabled,
  onPress,
}: {
  agent: Agent;
  first: boolean;
  last: boolean;
  note: string | null;
  disabled: boolean;
  onPress: () => void;
}) {
  const colors = useColors();
  const styles = useStyles();
  const ripple = useRipple();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Send to ${agent.name}`}
      accessibilityHint="Puts it in the chat for you to send"
      disabled={disabled}
      onPress={onPress}
      android_ripple={ripple}
      style={({ pressed }) => [
        styles.row,
        first && styles.rowFirst,
        last && styles.rowLast,
        pressed && { backgroundColor: colors.surfaceGroupPressed },
      ]}
    >
      <AgentKey id={agent.id} name={agent.name} color={agent.color} size={keySize.md} />
      <View style={styles.rowText}>
        <T variant="headline" color={colors.textStrong} numberOfLines={1}>
          {agent.name}
        </T>
        {(note || agent.role) && (
          <T variant="caption" color={colors.textSecondary} numberOfLines={1}>
            {note ?? agent.role}
          </T>
        )}
      </View>
      {!last && <View style={styles.divider} />}
    </Pressable>
  );
}

const useStyles = makeStyles((colors) => ({
  root: { padding: space.lg, paddingTop: space.xl, gap: space.md },
  list: { padding: space.lg, paddingTop: space.xl, paddingBottom: space['2xl'] },
  header: { gap: space.md, marginBottom: space.sm },
  eyebrow: { marginTop: space.sm, marginBottom: 0 },
  preview: {
    gap: space.xs,
    padding: space.md,
    borderRadius: radius.card,
    backgroundColor: colors.surfaceGroup,
    overflow: 'hidden',
  },
  empty: { padding: space.lg },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    minHeight: 56,
    paddingHorizontal: space.lg,
    paddingVertical: space.sm,
    backgroundColor: colors.surfaceGroup,
    overflow: 'hidden',
  },
  rowFirst: { borderTopLeftRadius: radius.card, borderTopRightRadius: radius.card },
  rowLast: { borderBottomLeftRadius: radius.card, borderBottomRightRadius: radius.card },
  rowText: { flex: 1, gap: space['2xs'] },
  divider: {
    position: 'absolute',
    left: space.lg + keySize.md + space.md,
    right: 0,
    bottom: 0,
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.borderDefault,
  },
}));

/** A throw while drawing stays on this screen, with the way back. */
export { ScreenError as ErrorBoundary } from '../components/ScreenError';
