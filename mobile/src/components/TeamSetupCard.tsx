/**
 * "Setting up your team": one card in the Chief's chat after an import,
 * a row in the conversation where it was posted (`withSetupCard`), never
 * pinned under the newest message; the bar above the composer brings you
 * back to it. The phone's copy of the desk's (`TeamSetupCard` there,
 * desktop `agents/team_setup.rs`). Steps in a fixed order: logins, routines to switch
 * on, what the agents said they're missing, then saying hi to each. The
 * first open step is unfolded; done and skipped ones are a ticked row that
 * opens again on a tap. Finished, it's one quiet line.
 *
 * Everything it shows is the Mac's answer to `agents.teamSetup`, read again
 * after each tap and on every registry event; nothing here decides a step.
 */

import type { TeamSetupStep, TeamSetupStepId, TeamSetupView } from '@shipstudio/companion-protocol';
import { useRouter } from 'expo-router';
import { useMemo, useState } from 'react';
import { Pressable, Switch, View } from 'react-native';
import { useSwitchColors } from '../lib/accent';
import { makeStyles, useColors } from '../lib/appearance';
import { haptic } from '../lib/haptics';
import { describeError, teamSetup } from '../lib/session';
import { useApp } from '../lib/store';
import {
  ASKED_LINE,
  CHECK_AGAIN,
  COMPLETE_LINE,
  NOT_NEEDED,
  SET_ASIDE_NOTE,
  SETUP_TITLE,
  anyReplying,
  checkLine,
  openRows,
  reachedRows,
  reachedToggle,
  receipt,
  residueLine,
  rowAgents,
  groupLogins,
  helloWord,
  openStep,
  progress,
  shows,
  sourceLine,
  stateWord,
  stepHint,
  stepTitle,
} from '../lib/teamSetup';
import { iconSize, space, PRESSED } from '../lib/theme';
import { AgentAvatar, Spinner } from './agent';
import { Card, CardActions, Line } from './surfaces';
import { Button, Icon, T } from './ui';
import { TeamLoginsList } from './teamLogins';

export function TeamSetupCard({
  chief,
  onError,
}: {
  /** The Chief's name, for "Ask … to sort these". */
  chief: string;
  onError: (text: string) => void;
}) {
  const view = useApp((s) => s.teamSetup);
  const connected = useApp((s) => s.link.kind === 'connected');
  if (!shows(view)) return null;
  return <TeamSetup view={view} chief={chief} connected={connected} onError={onError} />;
}

/** The card for a view: split out so tests can draw any state. */
export function TeamSetup({
  view,
  chief,
  connected,
  onError,
}: {
  view: TeamSetupView;
  chief: string;
  connected: boolean;
  onError: (text: string) => void;
}) {
  const [opened, setOpened] = useState<TeamSetupStepId | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const run = (key: string, work: () => Promise<unknown>) => {
    setBusy(key);
    work()
      .then(() => haptic.success())
      .catch((e: unknown) => {
        haptic.error();
        onError(describeError(e));
      })
      .finally(() => setBusy(null));
  };
  if (view.complete) {
    return (
      <Line
        icon="checkmark"
        tone="success"
        lead="Done"
        text={COMPLETE_LINE}
        testID="team-setup-done"
        action={
          connected
            ? { label: 'Hide', onPress: () => run('dismiss', teamSetup.dismiss) }
            : undefined
        }
      />
    );
  }
  const shown = opened ?? openStep(view);
  return (
    <Card
      icon="person.2"
      title={SETUP_TITLE}
      meta={progress(view)}
      source={sourceLine(view)}
      note={view.setAside ? SET_ASIDE_NOTE : undefined}
      testID="team-setup"
    >
      {view.steps.map((step) => (
        <StepRow
          key={step.id}
          step={step}
          chief={chief}
          open={shown === step.id}
          connected={connected}
          busy={busy}
          onToggle={() => setOpened(shown === step.id ? null : step.id)}
          run={run}
        />
      ))}
    </Card>
  );
}

function StepRow({
  step,
  chief,
  open,
  connected,
  busy,
  onToggle,
  run,
}: {
  step: TeamSetupStep;
  chief: string;
  open: boolean;
  connected: boolean;
  busy: string | null;
  onToggle: () => void;
  run: (key: string, work: () => Promise<unknown>) => void;
}) {
  const colors = useColors();
  const styles = useStyles();
  const word = stateWord(step);
  const settled = step.state !== 'open';
  const off = !connected || busy !== null;
  return (
    <View style={styles.step} testID={`team-setup-${step.id}`}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={word ? `${stepTitle(step.id)}, ${word}` : stepTitle(step.id)}
        onPress={onToggle}
        style={({ pressed }) => [styles.stepHead, pressed && PRESSED]}
      >
        <Icon
          name={
            step.state === 'done'
              ? 'checkmark.circle.fill'
              : step.state === 'skipped'
                ? 'minus.circle'
                : 'circle'
          }
          size={iconSize.body}
          color={step.state === 'done' ? colors.accentSuccess : colors.textMuted}
        />
        <T
          variant="subhead"
          color={settled ? colors.textSecondary : colors.textStrong}
          style={{ flex: 1 }}
        >
          {stepTitle(step.id)}
        </T>
        {word && (
          <T variant="caption" color={colors.textMuted}>
            {word}
          </T>
        )}
        <Icon
          name={open ? 'chevron.down' : 'chevron.right'}
          size={iconSize.inline}
          color={colors.textMuted}
        />
      </Pressable>
      {open && (
        <View style={styles.body}>
          {!settled && (
            <T variant="small" color={colors.textSecondary}>
              {stepHint(step, chief)}
            </T>
          )}
          <StepItems step={step} connected={connected} busy={busy} run={run} />
          <CardActions>
            {step.state === 'skipped' ? (
              <Button
                title="Open again"
                variant="outline"
                size="compact"
                disabled={off}
                busy={busy === `${step.id}:open`}
                onPress={() => run(`${step.id}:open`, () => teamSetup.step(step.id, 'open'))}
              />
            ) : step.state === 'open' ? (
              <>
                <Button
                  title="Skip"
                  variant="ghost"
                  size="compact"
                  disabled={off}
                  busy={busy === `${step.id}:skip`}
                  onPress={() => run(`${step.id}:skip`, () => teamSetup.step(step.id, 'skipped'))}
                />
                {step.id === 'missing' ? (
                  <Button
                    title={`Ask ${chief} to sort these`}
                    variant="answer"
                    size="compact"
                    disabled={off}
                    busy={busy === 'missing'}
                    onPress={() => run('missing', teamSetup.missing)}
                  />
                ) : step.id !== 'logins' ? (
                  <Button
                    title="Done"
                    variant="answer"
                    size="compact"
                    disabled={off}
                    busy={busy === `${step.id}:done`}
                    onPress={() => run(`${step.id}:done`, () => teamSetup.step(step.id, 'done'))}
                  />
                ) : null}
              </>
            ) : null}
          </CardActions>
        </View>
      )}
    </View>
  );
}

function StepItems({
  step,
  connected,
  busy,
  run,
}: {
  step: TeamSetupStep;
  connected: boolean;
  busy: string | null;
  run: (key: string, work: () => Promise<unknown>) => void;
}) {
  const colors = useColors();
  const styles = useStyles();
  const router = useRouter();
  const openChat = (agentId: string) =>
    router.push({ pathname: '/chat/[id]', params: { id: agentId } });
  switch (step.id) {
    case 'logins':
      return (
        <View style={styles.items}>
          {!!step.later?.length && (
            <Reach step={step} connected={connected} busy={busy} run={run} openChat={openChat} />
          )}
          <SetupLogins logins={step.logins ?? []} onOpenChat={openChat} />
        </View>
      );
    case 'routines':
      return (
        <View style={styles.items}>
          {(step.routines ?? []).map((r) => (
            <RoutineRow
              key={r.checkInId}
              agentName={r.agentName}
              when={r.when}
              what={r.what}
              on={r.on}
              disabled={!connected || busy !== null}
              onChange={(on) =>
                run(`routine:${r.checkInId}`, () => teamSetup.routine(r.agentId, r.checkInId, on))
              }
            />
          ))}
        </View>
      );
    case 'missing':
      return (
        <View style={styles.items}>
          {(step.gaps ?? []).map((g) => (
            <View key={g.agentId} style={styles.group}>
              <T variant="small" color={colors.textStrong}>
                {g.agentName}
              </T>
              {g.lines.map((line) => (
                <T key={line} variant="caption" color={colors.textSecondary}>
                  {line}
                </T>
              ))}
            </View>
          ))}
        </View>
      );
    case 'hello': {
      const replying = anyReplying(step.agents);
      return (
        <View style={styles.items}>
          {(step.agents ?? []).map((a) => {
            const word = helloWord(a);
            return (
              <View key={a.agentId} style={styles.item} testID={`hello-${a.state}`}>
                <AgentAvatar name={a.agentName} color={a.color} />
                <T variant="small" color={colors.textStrong} style={{ flex: 1 }}>
                  {a.agentName}
                </T>
                {a.state === 'working' && <Spinner />}
                {word ? (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`${a.agentName}: ${word}. Open its chat`}
                    onPress={() => openChat(a.agentId)}
                    hitSlop={10}
                  >
                    <T variant="caption" color={colors.textMuted}>
                      {word}
                    </T>
                  </Pressable>
                ) : (
                  <Button
                    title="Say hi"
                    variant="secondary"
                    size="compact"
                    disabled={!connected || replying || busy !== null}
                    busy={busy === `hello:${a.agentId}`}
                    onPress={() => run(`hello:${a.agentId}`, () => teamSetup.hello(a.agentId))}
                  />
                )}
              </View>
            );
          })}
        </View>
      );
    }
  }
}

/**
 * What the team can already reach (desktop `agents/access_check.rs`): one
 * calm line while the Mac checks, then only the residue, each with one
 * sign-in button and "Not needed"; what it reached folds into receipts.
 */
function Reach({
  step,
  connected,
  busy,
  run,
  openChat,
}: {
  step: TeamSetupStep;
  connected: boolean;
  busy: string | null;
  run: (key: string, work: () => Promise<unknown>) => void;
  openChat: (agentId: string) => void;
}) {
  const colors = useColors();
  const styles = useStyles();
  const [showReached, setShowReached] = useState(false);
  const rows = step.later ?? [];
  const check = step.check;
  const off = !connected || busy !== null;
  if (check?.running) {
    return (
      <View style={styles.item} testID="team-setup-checking">
        <Spinner />
        <T variant="small" color={colors.textSecondary} style={{ flex: 1 }}>
          {checkLine(check)}
        </T>
      </View>
    );
  }
  const open = openRows(rows);
  const reached = reachedRows(rows);
  const waiting = rows.filter((r) => r.state === 'asked');
  const notNeeded = rows.filter((r) => r.state === 'not_needed');
  return (
    <View style={styles.items} testID="team-setup-reach">
      <T variant="small" color={colors.textStrong}>
        {residueLine(open.length)}
      </T>
      {open.map((r) => (
        <View key={r.key} style={styles.item} testID={`reach-open-${r.key}`}>
          <View style={{ flex: 1 }}>
            <T variant="small" color={colors.textStrong}>
              {r.title}
            </T>
            <T variant="caption" color={colors.textMuted}>
              {rowAgents(r)}
            </T>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`${r.title}: ${NOT_NEEDED}`}
              disabled={off}
              onPress={() => run(`later:${r.key}:no`, () => teamSetup.later(r.key, 'not_needed'))}
              hitSlop={10}
            >
              <T variant="caption" color={colors.textSecondary}>
                {NOT_NEEDED}
              </T>
            </Pressable>
          </View>
          {!!r.action && (
            <Button
              title={r.action}
              variant="secondary"
              size="compact"
              disabled={off}
              busy={busy === `later:${r.key}`}
              onPress={() =>
                run(`later:${r.key}`, async () => {
                  const raised = await teamSetup.later(r.key, 'connect', true);
                  if (raised) openChat(raised.agentId);
                })
              }
            />
          )}
        </View>
      ))}
      {waiting.map((r) => (
        <View key={r.key} style={styles.item} testID={`reach-asked-${r.key}`}>
          <View style={{ flex: 1 }}>
            <T variant="small" color={colors.textStrong}>
              {r.title}
            </T>
            <T variant="caption" color={colors.textMuted}>
              {ASKED_LINE}
            </T>
          </View>
          {r.state === 'asked' && (
            <Button
              title="Open"
              variant="ghost"
              size="compact"
              onPress={() => openChat(r.agentId)}
              accessibilityHint="Opens the chat with its sign-in card"
            />
          )}
        </View>
      ))}
      {notNeeded.map((r) => (
        <T key={r.key} variant="caption" color={colors.textMuted}>
          {r.title} · {NOT_NEEDED}
        </T>
      ))}
      {reached.length > 0 && (
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded: showReached }}
          onPress={() => setShowReached((v) => !v)}
          hitSlop={10}
          testID="reach-reached-toggle"
        >
          <T variant="caption" color={colors.textSecondary}>
            {reachedToggle(reached.length)}
          </T>
        </Pressable>
      )}
      {showReached &&
        reached.map((r) => (
          <T key={r.key} variant="caption" color={colors.textMuted}>
            {receipt(r)}
          </T>
        ))}
      <Pressable
        accessibilityRole="button"
        disabled={off}
        onPress={() => run('check', teamSetup.check)}
        hitSlop={10}
        testID="reach-check-again"
      >
        <T variant="caption" color={colors.textSecondary}>
          {CHECK_AGAIN}
        </T>
      </Pressable>
    </View>
  );
}

function RoutineRow({
  agentName,
  when,
  what,
  on,
  disabled,
  onChange,
}: {
  agentName: string;
  when: string;
  what: string;
  on: boolean;
  disabled: boolean;
  onChange: (on: boolean) => void;
}) {
  const colors = useColors();
  const styles = useStyles();
  const switchColors = useSwitchColors(on);
  return (
    <View style={styles.item}>
      <View style={{ flex: 1 }}>
        <T variant="small" color={colors.textStrong}>
          {agentName} · {when}
        </T>
        <T variant="caption" color={colors.textSecondary}>
          {what}
        </T>
      </View>
      <Switch
        value={on}
        disabled={disabled}
        onValueChange={onChange}
        {...switchColors}
        accessibilityLabel={`${agentName}: ${what}, ${when}`}
      />
    </View>
  );
}

const useStyles = makeStyles((colors) => ({
  // Under the newest message, apart from it like a new speaker.
  step: {
    gap: space.sm,
    paddingTop: space.sm,
    borderTopWidth: 1,
    borderTopColor: colors.cardBorder,
  },
  stepHead: { flexDirection: 'row', alignItems: 'center', gap: space.sm, minHeight: 36 },
  body: { gap: space.md },
  items: { gap: space.md },
  item: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  group: { gap: space['2xs'] },
}));

/**
 * The Logins step: apps an agent signs in to are "What your team needs",
 * for these agents only (one Connect per service); keys and other secure
 * inputs are one row per service, named by the app, never a raw key, each
 * agent's card a tap away in its chat.
 */
function SetupLogins({
  logins,
  onOpenChat,
}: {
  logins: NonNullable<TeamSetupStep['logins']>;
  onOpenChat: (agentId: string) => void;
}) {
  const colors = useColors();
  const styles = useStyles();
  const signIns = logins.filter((l) => l.kind === 'login');
  const idList = [...new Set(signIns.map((l) => l.agentId))].sort().join(',');
  const agentIds = useMemo(() => new Set(idList ? idList.split(',') : []), [idList]);
  const groups = groupLogins(logins.filter((l) => l.kind !== 'login'));
  return (
    <View style={styles.items}>
      {signIns.length > 0 && <TeamLoginsList agentIds={agentIds} embedded />}
      {groups.map((g) => (
        <View key={g.key} testID={`setup-login-${g.key}`}>
          <T variant="small" color={colors.textStrong}>
            {g.name}
          </T>
          {g.items.map((l) => (
            <View key={l.requestId} style={styles.item}>
              <View style={{ flex: 1 }}>
                <T variant="caption" color={colors.textSecondary}>
                  {l.agentName}
                </T>
                {!!l.purpose && (
                  <T variant="caption" color={colors.textMuted}>
                    {l.purpose}
                  </T>
                )}
              </View>
              <Button
                title="Add"
                variant="secondary"
                size="compact"
                onPress={() => onOpenChat(l.agentId)}
                accessibilityHint={`Opens ${l.agentName}’s chat, where the login goes in`}
              />
            </View>
          ))}
        </View>
      ))}
    </View>
  );
}
