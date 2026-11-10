/**
 * A room as the agents list shows it (stacked member badges, its name, what
 * is happening, unread) and as an agent's own chat folds it ("In Month end ·
 * 2 messages"). Kept apart from the room's thread, so the list never loads
 * the chat's keyboard machinery.
 */

import type { Agent, RoomView } from '@shipstudio/companion-protocol';
import { useRouter } from 'expo-router';
import { memo, useMemo } from 'react';
import { Pressable, View } from 'react-native';
import { formatAgo } from '../lib/agents';
import { foldLine, membersOf, roomKey, roomLine, workingHere, type RoomFold } from '../lib/rooms';
import { useApp } from '../lib/store';
import { keySize, chromeScale, iconSize, radius, space } from '../lib/theme';
import { makeStyles, useColors } from '../lib/appearance';
import { Spinner } from './agent';
import { AgentKey } from './AgentKey';
import { keyGeometry } from '../lib/agentKey';
import { Dot, Icon, StatusPill, T, useRipple } from './ui';

const NONE: never[] = [];
/** The page's ring around each badge: wide enough to keep two apart, thin enough to stay quiet. */
const RING = 2;

/**
 * Two members' keys and "+N" for the rest, the newest speaker never
 * singled out: a room is nobody's in particular. Whole keys only: two
 * small keys share the list's key square corner to corner (rings touching),
 * and the header sets them side by side. The ring is drawn in the surface
 * it sits on (`on`).
 */
export function StackedKeys({
  members,
  size = 'list',
}: {
  members: Agent[];
  size?: 'list' | 'header';
}) {
  const colors = useColors();
  const styles = useStyles();
  const tile = keySize.sm;
  const ringed = tile + RING * 2;
  // A key stands on its depth: its box is that much taller than wide.
  const ringedTall = ringed + keyGeometry(tile).rest;
  const shown = members.slice(0, 2);
  const more = members.length - shown.length;
  const ring = { borderColor: size === 'header' ? colors.surfacePanel : colors.surfaceApp };
  const plus = more > 0 && (
    <T
      variant="caption"
      color={colors.textSecondary}
      maxFontSizeMultiplier={chromeScale}
      style={size === 'list' ? styles.moreList : undefined}
    >
      +{more}
    </T>
  );
  if (size === 'header') {
    return (
      <View style={styles.pairRow} accessible={false}>
        {shown.map((m) => (
          <View key={m.id} style={[styles.ring, ring, { borderRadius: radius.inner }]}>
            <AgentKey id={m.id} name={m.name} color={m.color} size={tile} />
          </View>
        ))}
        {plus}
      </View>
    );
  }
  const box = keySize.lg;
  // One badge sits centred; two share the square corner to corner.
  const spots =
    shown.length === 1
      ? [[(box - ringed) / 2, (box - ringedTall) / 2]]
      : [
          [0, 0],
          [box - ringed, box - ringedTall],
        ];
  return (
    <View style={{ width: box, height: box }} accessible={false}>
      {shown.map((m, i) => (
        <View
          key={m.id}
          style={[
            styles.ring,
            styles.stacked,
            ring,
            { left: spots[i][0], top: spots[i][1], borderRadius: radius.inner },
          ]}
        >
          <AgentKey id={m.id} name={m.name} color={m.color} size={tile} />
        </View>
      ))}
      {plus}
    </View>
  );
}

/** A room on the agents list: its members, its name, what's happening, unread. */
export const RoomRow = memo(function RoomRow({
  room,
  live,
  selected,
  onPress,
}: {
  room: RoomView;
  live: boolean;
  selected?: boolean;
  /** Given in the iPad split: open beside the list instead of pushing. */
  onPress?: () => void;
}) {
  const colors = useColors();
  const styles = useStyles();
  const ripple = useRipple();
  const router = useRouter();
  const agents = useApp((s) => s.overview?.agents ?? NONE);
  const members = useMemo(() => membersOf(room, agents), [room, agents]);
  const line = useApp((s) => roomLine(room, members, s.chats[roomKey(room.id)]?.messages));
  const asking = line === 'Needs your OK';
  const working = workingHere(members, room.id).length > 0;
  return (
    <Pressable
      onPress={onPress ?? (() => router.push({ pathname: '/room/[id]', params: { id: room.id } }))}
      android_ripple={ripple}
      accessibilityRole="button"
      accessibilityState={{ selected: !!selected }}
      accessibilityLabel={`Room ${room.name}, ${members.length} agents. ${line}${
        room.unread ? '. Unread' : ''
      }${live ? '' : '. Last known'}`}
      style={({ pressed }) => [
        styles.row,
        selected && styles.selected,
        pressed && { backgroundColor: colors.surfaceControl },
      ]}
    >
      <StackedKeys members={members} />
      <View style={styles.text}>
        <View style={styles.line}>
          <T
            variant="headline"
            color={colors.textStrong}
            numberOfLines={1}
            maxFontSizeMultiplier={2}
            style={styles.name}
          >
            {room.name}
          </T>
          {room.muted && (
            <Icon name="bell.slash.fill" size={iconSize.inline} color={colors.textMuted} />
          )}
          <T variant="caption" color={colors.textMuted} maxFontSizeMultiplier={chromeScale}>
            {formatAgo(room.lastActivityAt)}
          </T>
        </View>
        <View style={styles.line}>
          {asking && live ? (
            // Waiting on you, as the agent rows say it: a pill, not an amber line.
            <View style={{ flex: 1 }}>
              <StatusPill tone="waiting" label={line} />
            </View>
          ) : (
            <T
              variant="small"
              numberOfLines={1}
              maxFontSizeMultiplier={2}
              color={colors.textSecondary}
              style={{ flex: 1 }}
            >
              {line}
            </T>
          )}
          {/* "Needs your OK" says it once, in words: no dot beside it as well. */}
          <View style={styles.mark}>
            {asking ? null : working && live ? (
              <Spinner />
            ) : room.unread > 0 ? (
              <Dot color={live ? colors.textStrong : colors.textMuted} />
            ) : null}
          </View>
        </View>
      </View>
    </Pressable>
  );
});

/** In an agent's own chat: what it said in a room, as one line that opens the room. */
export function RoomFoldRow({ fold }: { fold: RoomFold }) {
  const colors = useColors();
  const styles = useStyles();
  const router = useRouter();
  const room = useApp((s) => s.rooms?.find((r) => r.id === fold.roomId));
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityHint={room ? 'Opens the room' : undefined}
      disabled={!room}
      onPress={() => router.push({ pathname: '/room/[id]', params: { id: fold.roomId } })}
      hitSlop={{ top: 10, bottom: 10 }}
      style={({ pressed }) => [styles.fold, pressed && { opacity: 0.6 }]}
    >
      <Icon name="person.2" size={iconSize.inline} color={colors.textMuted} />
      <T variant="small" color={colors.textSecondary} style={{ flexShrink: 1 }}>
        {foldLine(fold, room?.name)}
      </T>
      {room && <Icon name="chevron.right" size={iconSize.inline} color={colors.textMuted} />}
    </Pressable>
  );
}

const useStyles = makeStyles((colors) => ({
  stacked: { position: 'absolute' },
  // A ring of the surface around each badge, so touching ones stay apart.
  ring: { borderWidth: RING, overflow: 'hidden' },
  pairRow: { flexDirection: 'row', alignItems: 'center', gap: space['2xs'] },
  // "+N" in the corner the two badges leave free.
  moreList: { position: 'absolute', left: space['2xs'], bottom: 0 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
    minHeight: 72,
    backgroundColor: colors.surfaceApp,
  },
  selected: { backgroundColor: colors.surfaceControl },
  text: { flex: 1, gap: space['2xs'] },
  line: { flexDirection: 'row', alignItems: 'center', gap: space.tight },
  name: { flexShrink: 1, flexGrow: 1 },
  mark: { width: 14, alignItems: 'flex-end' },
  fold: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.tight,
    alignSelf: 'flex-start',
    paddingVertical: space.xs,
  },
}));
