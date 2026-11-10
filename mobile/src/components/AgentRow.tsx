/**
 * An agent on the home list. Tap opens the chat. Hold for the native
 * context menu on iOS (Pin, Mark as Unread, Mute, Hide), or a sheet on
 * Android and in the iPad split. Swipe left for Mute and Hide, with Undo;
 * swipe right to pin.
 *
 * While the Mac can't be reached the row says only what was last known:
 * status marks go grey and stop moving (`live` false).
 */

import type { Agent } from '@shipstudio/companion-protocol';
import { Link, type Href } from 'expo-router';
import { memo, useRef, useState } from 'react';
import {
  type LayoutChangeEvent,
  Platform,
  Pressable,
  StyleSheet,
  useWindowDimensions,
  View,
} from 'react-native';
import ReanimatedSwipeable, {
  type SwipeableMethods,
} from 'react-native-gesture-handler/ReanimatedSwipeable';
import Animated, { interpolate, useAnimatedStyle, type SharedValue } from 'react-native-reanimated';
import { agentActions, type Action, type AgentAction, type AgentCaps } from '../lib/actions';
import {
  agentKeyState,
  formatAgo,
  lineState,
  needsLine,
  needsYou,
  roleLabel,
  rowPill,
  subtitle,
  waitingForSlot,
  waitingOnMac,
} from '../lib/agents';
import { useClock } from '../lib/useClock';
import { useSteadyLine } from '../lib/steady';
import { useApp } from '../lib/store';
import { useAgentLevelLabel } from './IndependenceSetting';
import { haptic } from '../lib/haptics';
import { roleCutPastReading } from '../lib/accountsView';
import { keySize, chromeScale, iconSize, radius, space, type } from '../lib/theme';
import { makeStyles, useColors } from '../lib/appearance';
import { StatusMark } from './agent';
import { AgentKey } from './AgentKey';
import { showActions } from './menu';
import { Icon, StatusPill, useRipple, T } from './ui';

/** How far a row's words follow Dynamic Type: past this they'd outgrow the title above them. */
const NAME_SCALE = 2;

/** iOS 18+: the system's own context menu and preview (expo-router's Link.Menu). */
const NATIVE_MENU = Platform.OS === 'ios';
const ACTION_W = 76;

/** A quiet row's line: an agent still being set up after an import. */
export const SETTING_UP_LINE = 'Being set up · in your Chief of Staff’s chat';

export const AgentRow = memo(function AgentRow({
  agent,
  quiet,
  caps,
  live,
  selected,
  onPress,
  onAction,
}: {
  agent: Agent;
  /** Still being set up after an import: no "Needs your OK", no amber (lib/home). */
  quiet?: boolean;
  caps: AgentCaps;
  /** Connected: what the row shows is current. */
  live: boolean;
  /** The chat open beside the list (iPad). */
  selected?: boolean;
  /** Given in the iPad split: open beside the list instead of pushing. */
  onPress?: () => void;
  onAction: (agent: Agent, action: AgentAction) => void;
}) {
  const colors = useColors();
  const styles = useStyles();
  const swipe = useRef<SwipeableMethods>(null);
  const actions = agentActions(agent, caps);
  const canToggle = live && caps.update;
  const href: Href = { pathname: '/chat/[id]', params: { id: agent.id } };

  const body = (
    <RowBody
      agent={agent}
      quiet={quiet}
      live={live}
      selected={selected}
      onPress={onPress}
      // The swipes and the hold menu, for VoiceOver and TalkBack: the actions rotor.
      actions={live ? actions : []}
      onAction={(id) => onAction(agent, id)}
      onLongPress={
        NATIVE_MENU && !onPress
          ? undefined
          : () => {
              haptic.select();
              showActions(agent.name, live ? actions : [], (id) => onAction(agent, id));
            }
      }
    />
  );

  // One shape for the row's whole life. Whether the Mac answers, and what its
  // welcome offers, change under a finger: a reconnect, the welcome arriving
  // after pairing, the Chief turning unread. A Link that gains or loses its
  // Menu is a different component (expo-router swaps in its native preview
  // link), and a row that gains or loses its swipe is a different parent, so
  // React remounted the row mid-tap and the tap was lost. So the menu is
  // always there, its items greyed while they can't run, and the swipe is
  // always there, switched off while it can't.
  const row =
    NATIVE_MENU && !onPress ? (
      <Link href={href} asChild>
        <Link.Trigger>{body}</Link.Trigger>
        <Link.Menu>
          {actions.length > 0 ? (
            actions.map((a) => (
              <Link.MenuAction
                key={a.id}
                icon={a.icon}
                destructive={a.destructive}
                disabled={!live}
                onPress={() => onAction(agent, a.id)}
              >
                {a.title}
              </Link.MenuAction>
            ))
          ) : (
            <Link.MenuAction disabled onPress={() => {}}>
              {live ? 'Nothing to change from this phone' : 'Not connected to your Mac right now.'}
            </Link.MenuAction>
          )}
        </Link.Menu>
      </Link>
    ) : (
      body
    );

  const act = (id: AgentAction) => {
    swipe.current?.close();
    onAction(agent, id);
  };
  return (
    <ReanimatedSwipeable
      ref={swipe}
      enabled={canToggle}
      friction={1.6}
      overshootFriction={8}
      rightThreshold={ACTION_W / 2}
      leftThreshold={ACTION_W / 2}
      onSwipeableWillOpen={() => haptic.select()}
      renderLeftActions={(progress) => (
        <SwipeAction
          progress={progress}
          side="left"
          icon={agent.pinned ? 'pin.slash' : 'pin.fill'}
          label={agent.pinned ? 'Unpin' : 'Pin'}
          color={colors.surfaceSelected}
          onPress={() => act(agent.pinned ? 'unpin' : 'pin')}
        />
      )}
      renderRightActions={(progress) => (
        <View style={styles.actions}>
          <SwipeAction
            progress={progress}
            side="right"
            icon={agent.muted ? 'bell' : 'bell.slash'}
            label={agent.muted ? 'Unmute' : 'Mute'}
            color={colors.surfaceSelected}
            onPress={() => act(agent.muted ? 'unmute' : 'mute')}
          />
          {!agent.isMain && (
            <SwipeAction
              progress={progress}
              side="right"
              icon={agent.hidden ? 'eye' : 'eye.slash'}
              label={agent.hidden ? 'Unhide' : 'Hide'}
              // Neutral, like Mute: hiding is undone in a tap, and the agent keeps working.
              color={colors.surfaceSelected}
              onPress={() => act(agent.hidden ? 'unhide' : 'hide')}
            />
          )}
        </View>
      )}
    >
      {row}
    </ReanimatedSwipeable>
  );
});

function SwipeAction({
  progress,
  side,
  icon,
  label,
  color,
  onPress,
}: {
  progress: SharedValue<number>;
  side: 'left' | 'right';
  icon: Parameters<typeof Icon>[0]['name'];
  label: string;
  color: string;
  onPress: () => void;
}) {
  const colors = useColors();
  const styles = useStyles();
  // Nothing is drawn while closed: the row lifts out for its context menu,
  // and these mustn't show through the gap it leaves.
  const fill = useAnimatedStyle(() => ({
    opacity: interpolate(progress.value, [0, 0.05], [0, 1], 'clamp'),
  }));
  const style = useAnimatedStyle(() => ({
    opacity: interpolate(progress.value, [0, 0.6, 1], [0, 0.6, 1]),
    transform: [{ scale: interpolate(progress.value, [0, 1], [0.8, 1], 'clamp') }],
  }));
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={styles.action}
    >
      <Animated.View
        style={[
          StyleSheet.absoluteFill,
          { backgroundColor: color },
          side === 'left' && styles.actionLeft,
          fill,
        ]}
      />
      <Animated.View style={[styles.actionInner, style]}>
        <Icon name={icon} size={iconSize.button} color={colors.textStrong} />
        <T variant="caption" color={colors.textStrong} maxFontSizeMultiplier={chromeScale}>
          {label}
        </T>
      </Animated.View>
    </Pressable>
  );
}

function RowBody({
  agent,
  quiet,
  live,
  selected,
  onPress,
  onLongPress,
  actions,
  onAction,
  ...trigger
}: {
  agent: Agent;
  quiet?: boolean;
  live: boolean;
  selected?: boolean;
  onPress?: () => void;
  onLongPress?: () => void;
  actions: Action<AgentAction>[];
  onAction: (id: AgentAction) => void;
}) {
  const colors = useColors();
  const styles = useStyles();
  const ripple = useRipple();
  const { fontScale, width } = useWindowDimensions();
  // At the largest sizes the time moves under the subtitle so the name keeps its room.
  const stacked = fontScale >= 1.6;
  // Waiting only on the Mac (an import to review): said plainly, not in amber.
  const onMac = useApp((s) =>
    waitingOnMac(
      agent,
      s.chats[agent.id]?.messages,
      !!s.welcome?.methods.includes('agents.import.review')
    )
  );
  const state = onMac || quiet ? undefined : lineState(agent);
  // Its own level, only when it differs from the team's ("Unleashed").
  const level = useAgentLevelLabel(agent);
  // Running (not queued for a slot): the line says what and how long, on a
  // clock that ticks only while it works (the key is pressed meanwhile).
  const running = live && !quiet && agent.status.state === 'working' && !waitingForSlot(agent);
  const now = useClock(running);
  // Waiting on you: say what for, when the saved chat knows.
  const line = useApp((s) =>
    quiet
      ? SETTING_UP_LINE
      : needsYou(agent)
        ? needsLine(agent, s.chats[agent.id]?.messages)
        : subtitle(agent, now)
  );
  const role = roleLabel(agent.role);
  // A role squeezed to "Invo…" says nothing: dropped until what shares its
  // line (the name, pin, level, time) or the row's width changes.
  const fit = `${agent.name}|${role}|${width}|${fontScale}|${type.caption}|${agent.pinned}|${agent.muted}|${level}|${formatAgo(agent.lastActivityAt)}`;
  const [cutAt, setCutAt] = useState<string | null>(null);
  const roleShown = cutAt === fit ? '' : role;
  // Waiting on you, a turn that didn't finish, or out of usage: the state as
  // a pill, the rest in the line's own ink (one coloured thing per row).
  const pill = state && live ? rowPill(agent, line) : null;
  // Unread is the line's ink, not a dot: the right edge is the key's and the time's.
  const unread = agent.unread > 0;
  // What the key says, in words for VoiceOver ("Inbox, working").
  const keyState = live ? agentKeyState(agent, running) : 'idle';
  const keyWords =
    keyState === 'working'
      ? ', working'
      : keyState === 'live'
        ? ', live'
        : keyState === 'paused'
          ? ', paused'
          : '';
  // You're driving it: "Live", in green, leads the line (as on the desk).
  const driving = live && !!agent.takeover && !needsYou(agent);
  const cut = line.indexOf(' · ');
  // Steadied while it works, so step → "Thinking" → step doesn't flicker.
  const head = useSteadyLine(cut < 0 ? line : line.slice(0, cut), running);
  const tail = cut < 0 ? '' : line.slice(cut);
  const time = (
    <T
      variant="caption"
      color={colors.textMuted}
      numberOfLines={1}
      maxFontSizeMultiplier={chromeScale}
      style={[styles.time, !!level && !stacked && styles.timeAfterLevel]}
    >
      {formatAgo(agent.lastActivityAt)}
    </T>
  );
  return (
    <Pressable
      // Link.Trigger hands its own onPress in through these props.
      {...trigger}
      onPress={onPress ?? (trigger as { onPress?: () => void }).onPress}
      onLongPress={onLongPress}
      delayLongPress={350}
      android_ripple={ripple}
      style={({ pressed }) => [
        styles.row,
        selected && styles.selected,
        // The moment the finger lands. The panel grey was six levels off the
        // list's in dark, so a tap that registered looked like one that hadn't.
        pressed && Platform.OS === 'ios' && { backgroundColor: colors.surfaceControl },
      ]}
      accessibilityRole="button"
      accessibilityState={{ selected: !!selected }}
      accessibilityLabel={`${agent.name}${keyWords}. ${line}${unread ? '. Unread' : ''}${
        live ? '' : '. Last known'
      }`}
      accessibilityActions={actions.map((a) => ({ name: a.id, label: a.title }))}
      onAccessibilityAction={(e) => {
        const id = actions.find((a) => a.id === e.nativeEvent.actionName)?.id;
        if (id) onAction(id);
      }}
    >
      {({ pressed }) => (
        <>
          {/* The key says what it's doing by how it sits (pressed, lit, proud, a
          socket); the line says what. Last known: it rests. */}
          <View style={styles.key}>
            <AgentKey
              id={agent.id}
              name={agent.name}
              color={agent.color}
              state={keyState}
              size={keySize.lg}
              pressed={pressed}
            />
          </View>
          <View style={styles.text}>
            <View style={styles.nameLine}>
              <T
                variant="headline"
                color={colors.textStrong}
                numberOfLines={1}
                // Names stop growing at twice the size, under Home's large title.
                maxFontSizeMultiplier={NAME_SCALE}
                style={styles.name}
              >
                {agent.name}
              </T>
              {/* Its role, muted, one line: it gives way before the name does. */}
              {roleShown ? (
                <T
                  variant="caption"
                  color={colors.textMuted}
                  numberOfLines={1}
                  maxFontSizeMultiplier={NAME_SCALE}
                  style={styles.role}
                  onLayout={(e: LayoutChangeEvent) => {
                    const size = type.caption * Math.min(fontScale, NAME_SCALE);
                    if (roleCutPastReading(e.nativeEvent.layout.width, roleShown, size))
                      setCutAt(fit);
                  }}
                >
                  {roleShown}
                </T>
              ) : (
                <View style={styles.role} />
              )}
              {agent.pinned && (
                <Icon name="pin.fill" size={iconSize.inline} color={colors.textMuted} />
              )}
              {agent.muted && (
                <Icon name="bell.slash.fill" size={iconSize.inline} color={colors.textMuted} />
              )}
              {!!level && (
                <T
                  variant="caption"
                  color={colors.textMuted}
                  numberOfLines={1}
                  maxFontSizeMultiplier={NAME_SCALE}
                  style={styles.level}
                >
                  {/* Beside the time it reads as one quiet line: "Careful · 3 h ago". */}
                  {stacked ? level : `${level} ·`}
                </T>
              )}
              {!stacked && time}
            </View>
            <View style={styles.nameLine}>
              {pill && <StatusPill tone={pill.tone} label={pill.label} />}
              <T
                variant="small"
                numberOfLines={stacked ? 3 : 1}
                maxFontSizeMultiplier={NAME_SCALE}
                color={unread ? colors.textStrong : colors.textSecondary}
                style={{ flex: 1 }}
              >
                {driving && <T color={colors.accentSuccess}>Live · </T>}
                {/* Working: the steadied step, so step → "Thinking" → step doesn't flicker. */}
                {pill ? pill.rest : `${head}${tail}`}
              </T>
              {/*
            Waiting on you is said once, in the row's words ("Needs your OK",
            or that it waits on your Mac) under the Needs you header: no dot
            beside them as well. Every other state keeps its mark.
          */}
              <View style={styles.mark}>
                {!needsYou(agent) && !running && (
                  <StatusMark
                    agent={live ? { ...agent, unread: 0 } : agent}
                    live={live}
                    onMac={onMac}
                  />
                )}
              </View>
            </View>
            {stacked && time}
          </View>
        </>
      )}
    </Pressable>
  );
}

const useStyles = makeStyles((colors) => ({
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
  key: { width: keySize.lg },
  text: { flex: 1, gap: space['2xs'] },
  nameLine: { flexDirection: 'row', alignItems: 'center', gap: space.tight },
  // The name wins the line: it shrinks last, and the time never takes more than it needs.
  name: { flexShrink: 0, maxWidth: '60%' },
  // Takes what the name leaves; the pin, level and time stay at the right.
  role: { flexShrink: 1, flexGrow: 1, minWidth: 0 },
  time: { flexShrink: 0, marginLeft: space.sm },
  timeAfterLevel: { marginLeft: 0 },
  // A label, not a status: quiet, and it never pushes the name off the line.
  // Words, not a bordered box: a box on a row reads as a button.
  level: { flexShrink: 0 },
  mark: { width: 14, alignItems: 'flex-end' },
  actions: { flexDirection: 'row' },
  action: { width: ACTION_W, alignItems: 'center', justifyContent: 'center' },
  actionLeft: { borderTopRightRadius: radius.inner, borderBottomRightRadius: radius.inner },
  actionInner: { alignItems: 'center', gap: space.xs },
}));
