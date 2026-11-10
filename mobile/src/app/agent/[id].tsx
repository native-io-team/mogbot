/**
 * The agent sheet: who it is; its instructions, Files and usage; Pin, Mute
 * and Hide without a gesture; what it may do without asking (each "Always
 * allow" revocable); and its check-ins and routines, each one a tap from
 * Run now, Pause, Edit or Cancel, the same four the desktop offers; how full
 * its conversation is (when its engine says) and Start fresh. The
 * lists are the Mac's, live: whatever changes them, here or at the desk,
 * arrives with the next registry event.
 */

import {
  ON_ITS_OWN_STANDING,
  describeCheckInTime,
  stepsLine,
  describeWatchStatus,
  describeWatchTitle,
  isAdmin,
  keyLookFor,
  MAC_FEATURES,
  onClaudePlan,
  routineConversationLine,
  routineMoveChoices,
  routineWeekLine,
  sortCheckIns,
  sumTotals,
  type Agent,
  type CheckIn,
  type PermissionRule,
  type UsageSummary,
} from '@shipstudio/companion-protocol';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { Alert, Pressable, ScrollView, Switch, View } from 'react-native';
import Animated, { FadeIn, FadeOut, LinearTransition } from 'react-native-reanimated';
import { Spinner } from '../../components/agent';
import { AgentKey } from '../../components/AgentKey';
import { announce } from '../../lib/a11y';
import { useQuotaLines } from '../../lib/quota';
import { useNow } from '../../components/ConnectionPill';
import { choose } from '../../components/menu';
import { TextAction } from '../../components/surfaces';
import { WhatItCanReach } from '../../components/reach';
import { WhatItCanDo } from '../../components/policy';
import { AgentLevelRow } from '../../components/IndependenceSetting';
import { ColorSwatches, KeyChoices } from '../../components/pickers';
import {
  Button,
  Icon,
  InsetDivider,
  Row,
  SectionTitle,
  SheetPage,
  T,
  groupSurface,
  pageRhythm,
} from '../../components/ui';
import { SheetTitle } from '../../components/SheetTitle';
import {
  describeScope,
  engineCantAsk,
  engineLine,
  canStartFresh,
  contextLine,
  contextPercent,
  CONTEXT_SUGGEST_AT,
  engineName,
  folderName,
  modelName,
  usageLine,
  agentKeyState,
} from '../../lib/agents';
import { haptic } from '../../lib/haptics';
import {
  call,
  canCall,
  describeError,
  moveRoutine,
  readUsage,
  refreshConversations,
  revokePermission,
  schedule,
  setAgentToggles,
  startFresh,
} from '../../lib/session';
import { useApp } from '../../lib/store';
import { useSwitchColors } from '../../lib/accent';
import { withAgentAccent } from '../../lib/accentScreen';
import { iconSize, keySize, space } from '../../lib/theme';
import { makeStyles, useColors } from '../../lib/appearance';

// Its key (colourway, which also moves its chat's accent, legend and bound key)
// changes here only on a Mac that keeps keys (MAC_FEATURES.agentKeys); an older one
// that keeps looks (MAC_FEATURES.keycaps) takes its colour (AgentToggles in companion/router.rs).
export default withAgentAccent(AgentSheet);

function AgentSheet() {
  const colors = useColors();
  const styles = useStyles();
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const agent = useApp((s) => s.overview?.agents.find((a) => a.id === id));
  const welcome = useApp((s) => s.welcome);
  const engines = useApp((s) => s.overview?.engines);
  const live = useApp((s) => s.link.kind === 'connected');
  const [error, setErrorText] = useState<string | null>(null);
  // At the top of the sheet, and said aloud: a toggle that failed at the top
  // mustn't look like nothing happened while its reason sits a screen below.
  const setError = useCallback((text: string | null) => {
    setErrorText(text);
    if (text) announce(text, true);
  }, []);
  const [usage, setUsage] = useState<UsageSummary | null>(null);
  const keys = !!welcome?.features?.includes(MAC_FEATURES.agentKeys);
  const looks = keys || !!welcome?.features?.includes(MAC_FEATURES.keycaps);
  const [showLook, setShowLook] = useState(false);
  const taken = useApp((s) =>
    (s.overview?.agents ?? [])
      .filter((a) => a.id !== id && a.boundKey)
      .map((a) => a.boundKey)
      .join('')
  );
  const servesUsage = canCall('agents.usage', welcome);
  // Which conversation each routine runs in, on a Mac that keeps several.
  const conversations = useApp((s) => s.conversations[id]);
  const servesConversations = canCall('agents.conversations', welcome);
  const canMoveRoutines = canCall('agents.conversationRoutine', welcome);
  useEffect(() => {
    if (servesConversations && live) refreshConversations(id).catch(() => {});
  }, [id, servesConversations, live]);
  useEffect(() => {
    if (!servesUsage || !live) return;
    let on = true;
    readUsage(id).then(
      (u) => on && setUsage(u),
      () => {}
    );
    return () => {
      on = false;
    };
  }, [id, servesUsage, live]);
  // On a Claude plan a dollar figure is a list price, not the bill: tokens instead.
  const onPlan = onClaudePlan(useQuotaLines());
  if (!agent) return null;
  const canSchedule = canCall('agents.schedule.create', welcome);
  const checkIns = sortCheckIns(agent.checkIns ?? []);
  // "When…" routines: shown (read-only) by a Mac that sends them apart.
  const watches = welcome?.features?.includes(MAC_FEATURES.whenRoutines)
    ? sortCheckIns(agent.watches ?? [])
    : [];
  const cantAsk = engineCantAsk(agent, engines);
  const where = [engineLine(agent, engines), agent.project && folderName(agent.project)]
    .filter(Boolean)
    .join(' · ');

  return (
    <SheetPage>
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.who}>
          {/* A Mac that keeps keys: the key opens its colour, icon and keyboard key. */}
          <Pressable
            disabled={!looks}
            onPress={() => setShowLook((open) => !open)}
            accessibilityRole={looks ? 'button' : undefined}
            accessibilityLabel={looks ? 'Change how it looks' : undefined}
            accessibilityState={looks ? { expanded: showLook } : undefined}
          >
            <AgentKey
              id={agent.id}
              name={agent.name}
              color={agent.color}
              state={agentKeyState(agent)}
              size={keySize.xl}
            />
          </Pressable>
          <View style={{ flex: 1, gap: space['2xs'] }}>
            <SheetTitle numberOfLines={2}>{agent.name}</SheetTitle>
            {!!agent.role && (
              <T variant="small" color={colors.textSecondary} numberOfLines={2}>
                {agent.role}
              </T>
            )}
            {!!where && (
              <T variant="caption" color={colors.textMuted}>
                {where}
              </T>
            )}
          </View>
        </View>

        {looks && showLook && (
          <Animated.View entering={FadeIn.duration(150)} style={styles.look}>
            {keys ? (
              <KeyChoices
                name={agent.name}
                {...keyLookFor(agent)}
                taken={[...taken]}
                onColorway={(colorway) =>
                  setAgentToggles(agent.id, { colorway }).catch((e: unknown) =>
                    setError(describeError(e))
                  )
                }
                onIcon={(icon) =>
                  setAgentToggles(agent.id, { icon }).catch((e: unknown) =>
                    setError(describeError(e))
                  )
                }
                onBoundKey={(boundKey) =>
                  setAgentToggles(agent.id, { boundKey }).catch((e: unknown) =>
                    setError(describeError(e))
                  )
                }
              />
            ) : (
              <ColorSwatches
                value={agent.color}
                onChange={(color) =>
                  setAgentToggles(agent.id, { color }).catch((e: unknown) =>
                    setError(describeError(e))
                  )
                }
              />
            )}
          </Animated.View>
        )}

        {error && (
          <Animated.View entering={FadeIn.duration(150)} style={styles.error}>
            <Icon
              name="exclamationmark.circle"
              size={iconSize.inline}
              color={colors.accentErrorLight}
            />
            <T variant="small" color={colors.accentErrorLight} style={{ flex: 1 }}>
              {error}
            </T>
          </Animated.View>
        )}

        <View style={styles.list}>
          {canCall('agents.instructions', welcome) && (
            <Row
              label="Instructions"
              leading={
                <Icon name="text.alignleft" size={iconSize.body} color={colors.textSecondary} />
              }
              onPress={() => router.push({ pathname: '/instructions', params: { id } })}
            />
          )}
          {canCall('agents.memory', welcome) && (
            <Row
              label="Memory"
              leading={<Icon name="brain" size={iconSize.body} color={colors.textSecondary} />}
              onPress={() => router.push({ pathname: '/memory', params: { id } })}
            />
          )}
          {canCall('agents.onItsOwn', welcome) && (
            <Row
              label={ON_ITS_OWN_STANDING}
              leading={
                <Icon name="checkmark.shield" size={iconSize.body} color={colors.textSecondary} />
              }
              onPress={() => router.push({ pathname: '/on-its-own', params: { id } })}
            />
          )}
          {canCall('agents.files', welcome) && (
            <Row
              label="Files"
              leading={<Icon name="doc.on.doc" size={iconSize.body} color={colors.textSecondary} />}
              onPress={() => router.push({ pathname: '/files/[id]', params: { id } })}
            />
          )}
          <Toggle
            agent={agent}
            field="pinned"
            label="Pinned"
            detail="Stays at the top of your agents."
            enabled={live}
            onError={setError}
          />
          <Toggle
            agent={agent}
            field="muted"
            label="Muted"
            detail="No alerts from it. Unread still counts."
            enabled={live}
            onError={setError}
            last={agent.isMain}
          />
          {!agent.isMain && (
            <Toggle
              agent={agent}
              field="hidden"
              label="Hidden"
              detail="Tucked under Hidden in your list. It keeps working."
              enabled={live}
              onError={setError}
              last
            />
          )}
        </View>

        {canCall('agents.setAgentIndependence', welcome) && (
          <View style={styles.list}>
            <AgentLevelRow agent={agent} enabled={live} onError={setError} last />
          </View>
        )}

        {canCall('agents.setAdmin', welcome) && (
          <View style={styles.list}>
            <AdminToggle agent={agent} enabled={live} onError={setError} />
          </View>
        )}

        <Conversation
          agent={agent}
          canFresh={canCall('agents.startFresh', welcome)}
          live={live}
          onError={setError}
        />

        {!!agent.engine && (
          // Read-only here: switching engines starts a new session, a choice for the desk.
          <View style={styles.list}>
            <Row label="Runs on" value={engineName(agent)} />
            <Row label="Model" value={modelName(agent, engines)} last />
          </View>
        )}
        {!!cantAsk && (
          <T variant="small" color={colors.textMuted} style={styles.note}>
            {cantAsk}
          </T>
        )}

        {usage && <Usage usage={usage} onPlan={onPlan} />}

        {!!agent.permissions?.length && (
          <>
            <SectionTitle title="Allowed without asking" style={styles.sectionTitle} />
            <View style={styles.list}>
              {agent.permissions.map((rule, i, all) => (
                <Animated.View
                  key={rule.id}
                  exiting={FadeOut.duration(150)}
                  layout={LinearTransition.springify().damping(20)}
                >
                  <PermissionRow
                    agent={agent}
                    rule={rule}
                    last={i === all.length - 1}
                    enabled={live && canCall('agents.revokePermission', welcome)}
                    onError={setError}
                  />
                </Animated.View>
              ))}
            </View>
          </>
        )}

        <WhatItCanDo agentId={agent.id} name={agent.name} />

        <WhatItCanReach agentId={agent.id} />

        <View style={styles.sectionHead}>
          <SectionTitle title="Routines" style={styles.headTitle} />
          {canSchedule && (
            <Button
              title="Add"
              size="compact"
              variant="ghost"
              icon="plus"
              onPress={() => router.push({ pathname: '/schedule', params: { agentId: id } })}
            />
          )}
        </View>
        <View style={styles.list}>
          {checkIns.length === 0 ? (
            <T variant="small" color={colors.textMuted} style={styles.none}>
              Nothing scheduled. Add a routine, like every weekday at 9:00, “Draft my day”.
            </T>
          ) : (
            checkIns.map((c, i) => (
              <Animated.View
                key={c.id}
                entering={FadeIn.duration(180)}
                exiting={FadeOut.duration(150)}
                layout={LinearTransition.springify().damping(20)}
              >
                <CheckInRow
                  agent={agent}
                  checkIn={c}
                  spent={routineWeekLine(usage?.routines?.find((r) => r.id === c.id)?.week, onPlan)}
                  place={routineConversationLine(conversations, c.id)}
                  moveTo={canMoveRoutines ? routineMoveChoices(conversations, c.id) : []}
                  last={i === checkIns.length - 1}
                  // Offline its menu's actions would all fail: it waits for the Mac.
                  enabled={canSchedule && live}
                  onError={setError}
                />
              </Animated.View>
            ))
          )}
        </View>
        {watches.length > 0 && (
          <>
            <SectionTitle title="When something happens" style={styles.sectionTitle} />
            <View style={styles.list}>
              {watches.map((c, i) => (
                <WatchRow
                  key={c.id}
                  checkIn={c}
                  // One cost store for checks and runs, worded for the plan.
                  spent={routineWeekLine(usage?.routines?.find((r) => r.id === c.id)?.week, onPlan)}
                  last={i === watches.length - 1}
                />
              ))}
            </View>
            <T variant="caption" color={colors.textMuted} style={styles.note}>
              Set up and changed on your Mac.
            </T>
          </>
        )}
      </ScrollView>
    </SheetPage>
  );
}

function CheckInRow({
  agent,
  checkIn: c,
  spent,
  place,
  moveTo,
  last,
  enabled,
  onError,
}: {
  agent: Agent;
  checkIn: CheckIn;
  /** "$0.84 at API prices this week" or "96k tokens this week", when it ran on its own this week (as its engine reported). */
  spent: string | null;
  /** "In “Launch plan”": the conversation it runs in, when the agent has several. */
  place: string | null;
  /** The other conversations it could run in instead (a Mac that moves routines). */
  moveTo: { id: string; title: string }[];
  last: boolean;
  enabled: boolean;
  onError: (text: string | null) => void;
}) {
  const colors = useColors();
  const styles = useStyles();
  const router = useRouter();
  const now = useNow(30_000);
  const [busy, setBusy] = useState(false);
  const act = (run: () => Promise<unknown>) => () => {
    setBusy(true);
    onError(null);
    run()
      .catch((e: unknown) => onError(describeError(e)))
      .finally(() => setBusy(false));
  };
  const menu = () =>
    choose(c.note, [
      { label: 'Run now', run: act(() => schedule.runNow(agent.id, c.id)) },
      {
        label: c.paused ? 'Resume' : 'Pause',
        run: act(() => schedule.pause(agent.id, c.id, !c.paused)),
      },
      {
        label: 'Edit',
        run: () => router.push({ pathname: '/schedule', params: { agentId: agent.id, id: c.id } }),
      },
      ...(moveTo.length > 0
        ? [
            {
              label: 'Run it in another conversation',
              run: () =>
                choose(
                  'Run it in',
                  moveTo.map((to) => ({
                    label: to.title,
                    run: act(() => moveRoutine(agent.id, c.id, to.id)),
                  }))
                ),
            },
          ]
        : []),
      {
        label: 'Cancel routine',
        destructive: true,
        run: () =>
          Alert.alert('Cancel this routine?', `${agent.name} won’t be woken for it again.`, [
            { text: 'Keep', style: 'cancel' },
            {
              text: 'Cancel it',
              style: 'destructive',
              onPress: act(() => schedule.cancel(agent.id, c.id)),
            },
          ]),
      },
    ]);
  return (
    <Pressable
      disabled={!enabled || busy}
      onPress={menu}
      accessibilityRole="button"
      accessibilityState={{ disabled: !enabled, busy }}
      accessibilityHint={enabled ? 'Run now, pause, edit or cancel' : undefined}
      style={({ pressed }) => [styles.row, pressed && { backgroundColor: colors.surfaceControl }]}
    >
      <Icon
        name={c.repeat ? 'arrow.trianglehead.2.clockwise' : 'clock'}
        size={iconSize.body}
        color={c.paused ? colors.textMuted : colors.textSecondary}
      />
      <View style={{ flex: 1, gap: space['2xs'] }}>
        <T color={c.paused ? colors.textMuted : colors.textStrong} numberOfLines={2}>
          {c.note}
        </T>
        <T variant="caption" color={colors.textSecondary}>
          {describeCheckInTime(c, now)}
          {stepsLine(c) ? ` · ${stepsLine(c)}` : ''}
        </T>
        {!!place && (
          <T variant="caption" color={colors.textMuted} numberOfLines={1}>
            {place}
          </T>
        )}
        {c.waiting && (
          <T variant="caption" color={colors.accentWarning}>
            Waiting for your OK in the chat
          </T>
        )}
        {!!spent && (
          <T variant="caption" color={colors.textMuted}>
            {spent}
          </T>
        )}
      </View>
      {busy ? (
        <Spinner />
      ) : (
        enabled && <Icon name="ellipsis" size={iconSize.body} color={colors.textMuted} />
      )}
      {!last && <InsetDivider />}
    </Pressable>
  );
}

/**
 * A "When…" routine, read-only: what it waits for, what it does, and what
 * its last check came to. It's set up and changed on the Mac.
 */
function WatchRow({
  checkIn: c,
  spent: cost,
  last,
}: {
  checkIn: CheckIn;
  /** Its checks' and runs' week, as `routineWeekLine` words it. */
  spent: string | null;
  last: boolean;
}) {
  const colors = useColors();
  const styles = useStyles();
  const now = useNow(30_000);
  if (!c.watch) return null;
  const title = describeWatchTitle(c.watch.source);
  const status = describeWatchStatus(c, now);
  return (
    <View
      style={styles.row}
      accessible
      accessibilityLabel={[title, c.note, status, cost].filter(Boolean).join('. ')}
    >
      <Icon
        name="bolt"
        size={iconSize.body}
        color={c.paused ? colors.textMuted : colors.textSecondary}
      />
      <View style={{ flex: 1, gap: space['2xs'] }}>
        <T color={c.paused ? colors.textMuted : colors.textStrong} numberOfLines={2}>
          {title}
        </T>
        <T variant="small" color={colors.textSecondary} numberOfLines={2}>
          {c.note}
        </T>
        <T variant="caption" color={colors.textMuted}>
          {status}
          {cost ? ` · ${cost}` : ''}
        </T>
      </View>
      {!last && <InsetDivider />}
    </View>
  );
}

/** Pin, Mute or Hide as a switch: the path that needs no gesture. */
function Toggle({
  agent,
  field,
  label,
  detail,
  enabled,
  onError,
  last,
}: {
  agent: Agent;
  field: 'pinned' | 'muted' | 'hidden';
  label: string;
  detail: string;
  enabled: boolean;
  onError: (text: string | null) => void;
  last?: boolean;
}) {
  const switchProps = useSwitchColors(agent[field]);
  return (
    <Row
      label={label}
      detail={detail}
      last={last}
      trailing={
        <Switch
          value={agent[field]}
          {...switchProps}
          disabled={!enabled}
          accessibilityLabel={label}
          onValueChange={(on) => {
            haptic.select();
            onError(null);
            setAgentToggles(agent.id, { [field]: on }).catch((e: unknown) =>
              onError(describeError(e))
            );
          }}
        />
      }
    />
  );
}

/**
 * "Admin — can manage and approve for other agents": the user's own switch
 * (`agents.setAdmin`, audited on the Mac). On for the Chief by default.
 */
function AdminToggle({
  agent,
  enabled,
  onError,
}: {
  agent: Agent;
  enabled: boolean;
  onError: (text: string | null) => void;
}) {
  const on = isAdmin(agent);
  const switchProps = useSwitchColors(on);
  return (
    <Row
      label="Admin"
      detail="Can manage and approve for other agents. Spending, sending, publishing, pushing and keys still come to you."
      last
      trailing={
        <Switch
          value={on}
          {...switchProps}
          disabled={!enabled}
          accessibilityLabel="Admin — can manage and approve for other agents"
          onValueChange={(next) => {
            haptic.select();
            onError(null);
            call('agents.setAdmin', { agentId: agent.id, admin: next }).catch((e: unknown) =>
              onError(describeError(e))
            );
          }}
        />
      }
    />
  );
}

/** What a rule lets it do without asking, and Revoke. */
function PermissionRow({
  agent,
  rule,
  last,
  enabled,
  onError,
}: {
  agent: Agent;
  rule: PermissionRule;
  last: boolean;
  enabled: boolean;
  onError: (text: string | null) => void;
}) {
  const colors = useColors();
  const styles = useStyles();
  const [busy, setBusy] = useState(false);
  const revoke = () =>
    Alert.alert(`Revoke “${rule.label}”?`, `${agent.name} asks again before it does this.`, [
      { text: 'Keep', style: 'cancel' },
      {
        text: 'Revoke',
        style: 'destructive',
        onPress: () => {
          setBusy(true);
          onError(null);
          revokePermission(agent.id, rule.id)
            .then(() => haptic.warning())
            .catch((e: unknown) => {
              haptic.error();
              onError(describeError(e));
            })
            .finally(() => setBusy(false));
        },
      },
    ]);
  return (
    <View style={styles.row}>
      <View style={{ flex: 1, gap: space['2xs'] }}>
        <T variant="mono" color={colors.textStrong} numberOfLines={2}>
          {rule.label}
        </T>
        <T variant="caption" color={colors.textSecondary}>
          {describeScope(rule, agent.name, false)}
        </T>
      </View>
      {/* A text action, so it ends on the same edge as every row's value. */}
      <TextAction
        label={busy ? 'Revoking…' : 'Revoke'}
        disabled={!enabled || busy}
        onPress={revoke}
      />
      {!last && <InsetDivider />}
    </View>
  );
}

/**
 * How full its conversation is (only from its engine's own numbers) and
 * Start fresh: a new conversation from its next message, memory kept. Older
 * Macs don't serve it, and then only the reading shows, if any.
 */
function Conversation({
  agent,
  canFresh,
  live,
  onError,
}: {
  agent: Agent;
  canFresh: boolean;
  live: boolean;
  onError: (text: string | null) => void;
}) {
  const colors = useColors();
  const styles = useStyles();
  const [busy, setBusy] = useState(false);
  const router = useRouter();
  const context = contextLine(agent);
  const percent = contextPercent(agent);
  // A Mac with several conversations: a new one any time, nothing left
  // behind (the others stay a tap away), so no confirm and no waiting.
  const several = canCall('agents.conversationNew');
  const freshable = canFresh && (several || canStartFresh(agent));
  if (!context && !freshable) return null;
  const idle = several || agent.status.state === 'idle';
  // Why it can't be tapped right now, in one line; nothing when it can.
  const unavailable = !idle
    ? `Available once ${agent.name} is done`
    : !live
      ? 'Available once your Mac is connected'
      : undefined;
  const startNew = () => {
    setBusy(true);
    onError(null);
    startFresh(agent.id)
      .then(() => {
        haptic.success();
        router.push({ pathname: '/chat/[id]', params: { id: agent.id } });
      })
      .catch((e: unknown) => {
        haptic.error();
        onError(describeError(e));
      })
      .finally(() => setBusy(false));
  };
  const confirm = () =>
    Alert.alert(
      `Start ${agent.name} fresh?`,
      'Its next message starts a new conversation. Its instructions and memory carry over; this chat stays here.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Start Fresh',
          onPress: () => {
            setBusy(true);
            onError(null);
            startFresh(agent.id)
              .then(() => haptic.success())
              .catch((e: unknown) => {
                haptic.error();
                onError(describeError(e));
              })
              .finally(() => setBusy(false));
          },
        },
      ]
    );
  return (
    <>
      <View style={styles.list}>
        {!!context && <Row label="Conversation" value={context} last={!freshable} />}
        {freshable && (
          <Row
            label={
              several
                ? busy
                  ? 'Starting a new conversation…'
                  : 'New conversation'
                : busy
                  ? 'Starting fresh…'
                  : 'Start fresh'
            }
            leading={
              <Icon
                name="arrow.counterclockwise"
                size={iconSize.body}
                color={colors.textSecondary}
              />
            }
            // Its turn is in the conversation it would leave.
            onPress={busy ? undefined : several ? startNew : confirm}
            disabled={!!unavailable}
            detail={unavailable}
            last
          />
        )}
      </View>
      {freshable && percent !== null && percent >= CONTEXT_SUGGEST_AT && (
        <T variant="small" color={colors.textMuted} style={styles.note}>
          This conversation is getting long — {agent.name} may lose track of early details.{' '}
          {several ? 'Start a new conversation' : 'Start fresh'} to give it a new one; its memory is
          kept.
        </T>
      )}
    </>
  );
}

function Usage({ usage, onPlan }: { usage: UsageSummary; onPlan: boolean }) {
  const colors = useColors();
  const styles = useStyles();
  const routines = routineWeekLine(sumTotals((usage.routines ?? []).map((r) => r.week)), onPlan);
  return (
    <>
      <SectionTitle title="Usage" style={styles.sectionTitle} />
      <View style={styles.list}>
        {(
          [
            ['This week', usage.week],
            ['All time', usage.allTime],
          ] as const
        ).map(([label, totals], i) => (
          <View key={label} style={styles.row}>
            <View style={{ flex: 1, gap: space['2xs'] }}>
              <T color={colors.textPrimary}>{label}</T>
              <T variant="small" color={colors.textSecondary}>
                {usageLine(totals, onPlan)}
              </T>
            </View>
            {i === 0 && <InsetDivider />}
          </View>
        ))}
      </View>
      {!!routines && (
        <T variant="small" color={colors.textMuted} style={styles.note}>
          Its routines this week: {routines.replace(/ this week$/, '')}.
        </T>
      )}
    </>
  );
}

const RHYTHM = pageRhythm(space.md);

const useStyles = makeStyles((colors) => ({
  content: { padding: space.lg, paddingTop: space.xl, gap: space.md, paddingBottom: space['2xl'] },
  who: { flexDirection: 'row', alignItems: 'center', gap: space.md, marginBottom: space.sm },
  // A title with its action (Routines · Add): the rhythm's air above, and the
  // compact button's own height standing in for the title's space below.
  sectionHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: RHYTHM.title.marginTop,
    marginBottom: -space.xs,
  },
  sectionTitle: RHYTHM.title,
  headTitle: { marginBottom: 0 },
  error: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: space.sm,
    paddingHorizontal: space.lg,
  },
  look: { gap: space.sm },
  list: groupSurface(colors),
  none: { padding: space.lg },
  note: { marginHorizontal: space.lg, ...RHYTHM.note },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
  },
}));

/** A throw while drawing stays on this screen, with the way back. */
export { ScreenError as ErrorBoundary } from '../../components/ScreenError';
