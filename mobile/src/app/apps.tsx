/**
 * "Apps your agents can use" on the phone, the desk's dialog
 * (`AgentAppsModal`) through the companion protocol (`lib/apps.ts`):
 *
 * - **Connected**: each connection, its account, where its sign-in is kept
 *   and who can use it; Needs sign-in when it stopped working. "Who can use
 *   it" ticks agents and Read only / Read and change for them, and saves as
 *   the user's own answer, as on the desk: it narrows or widens (a full grant
 *   still asks on a card before each change). Remove asks first.
 * - **Connect an app**: the apps the Mac signs in to itself. Pick the agents
 *   first (the one this opened for, else the Chief), then sign in on this
 *   phone's sheet, or on the Mac when the phone can't. The token is made and
 *   kept in the Mac's Keychain; this phone never receives it.
 * - **Through claude.ai**: Gmail, Calendar, Slack and the rest are connected
 *   on claude.ai, opened here.
 *
 * Opened from Settings → Logins and from an agent's controls (`agentId`).
 */

import type { AppConnectFlow, AppConnection, ConnectableApp } from '@shipstudio/companion-protocol';
import { useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { choose } from '../components/menu';
import { SheetTitle } from '../components/SheetTitle';
import { CardActions, ACTION, TextAction } from '../components/surfaces';
import { NeedRow } from '../components/teamLogins';
import { Button, Icon, Segmented, SheetPage, T, tap, groupSurface } from '../components/ui';
import { makeStyles, useColors } from '../lib/appearance';
import {
  ACCESS_CHOICES,
  anySigningIn,
  appFlowLine,
  appSections,
  appSigningIn,
  appWay,
  cancelAppConnect,
  connectAppHere,
  connectAppOnMac,
  connectionAccount,
  defaultGrantees,
  grantNote,
  grantsLine,
  grantsOf,
  keptWhere,
  pickerAccess,
  readApps,
  removeApp,
  setAppGrants,
} from '../lib/apps';
import { haptic } from '../lib/haptics';
import { CLAUDE_AI_CONNECTORS, hasSignInSheet, openHere } from '../lib/logins';
import { describeError } from '../lib/session';
import { useApp, useServed } from '../lib/store';
import { iconSize, radius, space } from '../lib/theme';
import type { AppsOverview } from '@shipstudio/companion-protocol';

/** How often the list is read again while a sign-in runs on the Mac. */
const LIVE_MS = 2500;

type Access = 'read' | 'full';

export default function Apps() {
  const colors = useColors();
  const styles = useStyles();
  const { agentId } = useLocalSearchParams<{ agentId?: string }>();
  const live = useApp((s) => s.link.kind === 'connected');
  const agents = useApp((s) => s.overview?.agents);
  const team = useMemo(
    () => (agents ?? []).map((a) => ({ id: a.id, name: a.name, isMain: a.isMain })),
    [agents]
  );
  const names = useMemo(() => new Map(team.map((a) => [a.id, a.name])), [team]);
  const servesSheet = useServed('agents.appsPhoneBegin');
  const way = appWay(servesSheet, hasSignInSheet());
  const [data, setData] = useState<AppsOverview | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    readApps().then(
      (o) => {
        setData(o);
        setError(null);
      },
      (e) => setError(describeError(e))
    );
  }, []);
  useEffect(() => {
    if (live) load();
  }, [live, load]);
  const signing = anySigningIn(data);
  useEffect(() => {
    if (!signing || !live) return;
    const timer = setInterval(load, LIVE_MS);
    return () => clearInterval(timer);
  }, [signing, live, load]);

  const sections = data ? appSections(data) : null;
  const initial = defaultGrantees(team, agentId);

  return (
    <SheetPage>
      <ScrollView contentContainerStyle={styles.root} keyboardShouldPersistTaps="handled">
        <SheetTitle>Apps your agents can use</SheetTitle>
        <T color={colors.textSecondary}>
          Connect an app once and choose which agents can use it. You sign in here when the app
          allows it, or on your Mac; the sign-in stays in your Mac’s Keychain.
        </T>

        {!sections && !error && (
          <View style={styles.loading}>
            {live ? (
              <ActivityIndicator color={colors.textMuted} />
            ) : (
              <T variant="small" color={colors.textMuted}>
                Needs your Mac.
              </T>
            )}
          </View>
        )}

        {sections && sections.connected.length > 0 && (
          <Group title="Connected" testID="apps-connected">
            {sections.connected.map((c, i) => (
              <ConnectionRow
                key={c.connectionId}
                connection={c}
                ours={data!.apps.some((a) => a.service === c.service)}
                team={team}
                names={names}
                flow={sections.flows[c.service]}
                way={way}
                live={live}
                last={i === sections.connected.length - 1}
                onChanged={load}
              />
            ))}
          </Group>
        )}

        {sections && sections.toConnect.length > 0 && (
          <Group title="Connect an app" testID="apps-connect">
            {sections.toConnect.map((app, i) => (
              <ConnectRow
                key={app.service}
                app={app}
                team={team}
                initial={initial}
                flow={sections.flows[app.service]}
                way={way}
                live={live}
                last={i === sections.toConnect.length - 1}
                onChanged={load}
              />
            ))}
          </Group>
        )}

        {sections && (
          <Group title="Through claude.ai" testID="apps-claude-ai">
            <NeedRow
              last
              title="Gmail, Google Calendar, Slack and more"
              subtitle="Connect these on claude.ai, under Customize → Connectors. They reach agents on Claude Code signed in with that account."
              primary={{
                title: 'Open claude.ai',
                onPress: () =>
                  void openHere(CLAUDE_AI_CONNECTORS).catch((e) => setError(describeError(e))),
              }}
            />
          </Group>
        )}

        {!!error && (
          <T variant="small" color={colors.accentErrorLight}>
            {error}
          </T>
        )}
      </ScrollView>
    </SheetPage>
  );
}

function Group({
  title,
  children,
  testID,
}: {
  title: string;
  children: React.ReactNode;
  testID?: string;
}) {
  const colors = useColors();
  const styles = useStyles();
  return (
    <View style={styles.section} testID={testID}>
      <T
        variant="caption"
        color={colors.textMuted}
        style={styles.heading}
        accessibilityRole="header"
      >
        {title}
      </T>
      <View style={styles.group}>{children}</View>
    </View>
  );
}

/** A row's state, left-aligned under its title: Needs sign-in, Connected as …. */
function Status({
  icon,
  color,
  text,
}: {
  icon: 'checkmark' | 'exclamationmark.triangle';
  color: string;
  text: string;
}) {
  const styles = useStyles();
  return (
    <View style={styles.status} testID="app-status">
      <Icon name={icon} size={iconSize.inline} color={color} />
      <T variant="small" color={color}>
        {text}
      </T>
    </View>
  );
}

/* --------------------------------------------------------------- grants */

/** "Which agents can use it?": ticks, and read or read-and-change for all of them (as the desk). */
function GrantPicker({
  team,
  picked,
  access,
  onPick,
  onAccess,
}: {
  team: readonly { id: string; name: string }[];
  picked: readonly string[];
  access: Access;
  onPick: (ids: string[]) => void;
  onAccess: (a: Access) => void;
}) {
  const colors = useColors();
  const styles = useStyles();
  return (
    <View style={styles.picker} testID="grant-picker">
      <T variant="small" color={colors.textSecondary}>
        Which agents can use it?
      </T>
      <View style={styles.agents}>
        {team.map((a) => {
          const on = picked.includes(a.id);
          return (
            <Pressable
              key={a.id}
              accessibilityRole="checkbox"
              accessibilityState={{ checked: on }}
              accessibilityLabel={a.name}
              onPress={() => {
                tap();
                onPick(on ? picked.filter((id) => id !== a.id) : [...picked, a.id]);
              }}
              style={({ pressed }) => [styles.agent, pressed && { opacity: 0.6 }]}
            >
              <View style={[styles.box, on && styles.boxOn]}>
                {on && (
                  <Icon name="checkmark" size={iconSize.inline} color={colors.onSelectedFill} />
                )}
              </View>
              <T color={colors.textBody} style={{ flex: 1 }}>
                {a.name}
              </T>
            </Pressable>
          );
        })}
      </View>
      <Segmented<Access>
        value={access}
        onChange={onAccess}
        options={ACCESS_CHOICES.map((c) => ({ value: c.value, label: c.label }))}
      />
      <T variant="small" color={colors.textMuted}>
        {grantNote(access, picked.length === 0)}
      </T>
    </View>
  );
}

/* ----------------------------------------------------------------- rows */

/** A connect under way, failed or stopped: the desk's words, and Stop. */
function FlowLine({
  service,
  title,
  live,
  onStopped,
}: {
  service: string;
  title: string;
  live: AppConnectFlow;
  onStopped: () => void;
}) {
  const colors = useColors();
  const styles = useStyles();
  const flow = live.flow;
  if (!flow) return null;
  if (appSigningIn(live)) {
    return (
      <View style={styles.flow} testID="app-flow" accessibilityRole="text">
        <ActivityIndicator size="small" color={colors.textMuted} />
        <T variant="small" color={colors.textBody} style={{ flex: 1 }}>
          {appFlowLine(live, title)}
        </T>
        <TextAction
          label="Stop"
          muted
          onPress={() => void cancelAppConnect(service).then(onStopped, onStopped)}
        />
      </View>
    );
  }
  return (
    <T
      variant="small"
      color={flow.state === 'failed' ? colors.accentErrorLight : colors.textMuted}
      testID="app-flow"
    >
      {appFlowLine(live, title)}
    </T>
  );
}

/** Sign in: on this phone's sheet, else on the Mac. */
async function signIn(
  way: 'sheet' | 'mac',
  service: string,
  grants: ReturnType<typeof grantsOf>,
  again?: string
) {
  if (way === 'sheet') return connectAppHere(service, grants, again);
  return connectAppOnMac(service, grants, again);
}

function ConnectRow({
  app,
  team,
  initial,
  flow,
  way,
  live,
  last,
  onChanged,
}: {
  app: ConnectableApp;
  team: readonly { id: string; name: string }[];
  initial: string[];
  flow?: AppConnectFlow;
  way: 'sheet' | 'mac';
  live: boolean;
  last: boolean;
  onChanged: () => void;
}) {
  const colors = useColors();
  const [choosing, setChoosing] = useState(false);
  const [picked, setPicked] = useState<string[]>(initial);
  const [access, setAccess] = useState<Access>('read');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const running = appSigningIn(flow);
  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      await signIn(way, app.service, grantsOf(picked, access));
      haptic.select();
      setChoosing(false);
    } catch (e) {
      haptic.error();
      setError(describeError(e));
    } finally {
      setBusy(false);
      onChanged();
    }
  };
  return (
    <NeedRow
      last={last}
      title={app.title}
      subtitle={app.read}
      testID={`app-${app.service}`}
      primary={
        choosing || running
          ? undefined
          : {
              title: flow?.flow?.state === 'failed' ? 'Try again' : 'Connect',
              disabled: !live,
              hint: `Connect ${app.title}`,
              onPress: () => setChoosing(true),
            }
      }
      detail={
        <>
          {choosing && !running && (
            <>
              <GrantPicker
                team={team}
                picked={picked}
                access={access}
                onPick={setPicked}
                onAccess={setAccess}
              />
              <T variant="small" color={colors.textMuted}>
                {way === 'sheet'
                  ? `${app.title}’s sign-in opens here. The sign-in stays on your Mac.`
                  : `${app.title}’s sign-in opens on your Mac. Finish there.`}
              </T>
              <CardActions>
                <Button
                  title="Cancel"
                  variant="outline"
                  onPress={() => setChoosing(false)}
                  style={ACTION}
                />
                <Button
                  title={`Sign in to ${app.title}`}
                  variant="answer"
                  busy={busy}
                  disabled={!live}
                  onPress={() => void start()}
                  style={ACTION}
                />
              </CardActions>
            </>
          )}
          {flow && !choosing && (
            <FlowLine service={app.service} title={app.title} live={flow} onStopped={onChanged} />
          )}
          {!!error && (
            <T variant="small" color={colors.accentErrorLight}>
              {error}
            </T>
          )}
        </>
      }
    />
  );
}

function ConnectionRow({
  connection: c,
  ours,
  team,
  names,
  flow,
  way,
  live,
  last,
  onChanged,
}: {
  connection: AppConnection;
  /** Ours to sign in to again; not for claude.ai or GitHub's CLI. */
  ours: boolean;
  team: readonly { id: string; name: string }[];
  names: ReadonlyMap<string, string>;
  flow?: AppConnectFlow;
  way: 'sheet' | 'mac';
  live: boolean;
  last: boolean;
  onChanged: () => void;
}) {
  const colors = useColors();
  const [editing, setEditing] = useState(false);
  const [picked, setPicked] = useState<string[]>(() => c.grants.map((g) => g.agentId));
  const [access, setAccess] = useState<Access>(() => pickerAccess(c.grants));
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const account = connectionAccount(c);
  const running = appSigningIn(flow);
  const justNow = flow?.connected?.connectionId === c.connectionId ? flow.connected.line : null;

  const act = async (tag: string, run: () => Promise<unknown>, after?: () => void) => {
    setBusy(tag);
    setError(null);
    try {
      await run();
      haptic.select();
      after?.();
    } catch (e) {
      haptic.error();
      setError(describeError(e));
    } finally {
      setBusy(null);
      onChanged();
    }
  };
  const edit = () => {
    setPicked(c.grants.map((g) => g.agentId));
    setAccess(pickerAccess(c.grants));
    setEditing(true);
  };
  const confirmRemove = () =>
    choose(
      `Remove ${c.title}?`,
      [
        {
          label: 'Remove',
          destructive: true,
          run: () => void act('remove', () => removeApp(c.connectionId)),
        },
      ],
      c.kind === 'oauth'
        ? 'No agent can use it any more, and its sign-in leaves your Mac’s Keychain.'
        : 'No agent can use it any more. It stays connected where it was signed in.'
    );

  const words =
    editing || running
      ? []
      : [
          ...(c.needsSignIn && ours
            ? [
                {
                  label: 'Sign in again',
                  disabled: !live || !!busy,
                  onPress: () =>
                    void act('again', () =>
                      signIn(
                        way,
                        c.service,
                        c.grants.map((g) => ({ agentId: g.agentId, access: g.access })),
                        c.connectionId
                      )
                    ),
                },
              ]
            : []),
          { label: 'Who can use it', disabled: !live || !!busy, onPress: edit },
          { label: 'Remove', muted: true, disabled: !live || !!busy, onPress: confirmRemove },
        ];

  return (
    <NeedRow
      last={last}
      title={account ? `${c.title} · ${account}` : c.title}
      subtitle={`${keptWhere(c.kind)} · ${grantsLine(c, names)}`}
      testID={`connection-${c.connectionId}`}
      detail={
        <>
          {c.needsSignIn ? (
            <Status
              icon="exclamationmark.triangle"
              color={colors.accentWarning}
              text="Needs sign-in"
            />
          ) : (
            !!justNow && <Status icon="checkmark" color={colors.accentSuccess} text={justNow} />
          )}
          {editing && (
            <>
              <GrantPicker
                team={team}
                picked={picked}
                access={access}
                onPick={setPicked}
                onAccess={setAccess}
              />
              <CardActions>
                <Button
                  title="Cancel"
                  variant="outline"
                  onPress={() => setEditing(false)}
                  style={ACTION}
                />
                <Button
                  title="Save"
                  variant="answer"
                  busy={busy === 'save'}
                  disabled={!live}
                  onPress={() =>
                    void act(
                      'save',
                      () => setAppGrants(c.connectionId, grantsOf(picked, access)),
                      () => setEditing(false)
                    )
                  }
                  style={ACTION}
                />
              </CardActions>
            </>
          )}
          {flow && ours && (
            <FlowLine service={c.service} title={c.title} live={flow} onStopped={onChanged} />
          )}
          {!!error && (
            <T variant="small" color={colors.accentErrorLight}>
              {error}
            </T>
          )}
        </>
      }
      secondary={words}
    />
  );
}

const useStyles = makeStyles((colors) => ({
  root: { padding: space.lg, paddingTop: space.xl, gap: space.md, paddingBottom: space['2xl'] },
  loading: { padding: space.xl, alignItems: 'center' },
  section: { gap: space.sm, marginTop: space.sm },
  heading: { marginLeft: space.lg },
  group: { ...groupSurface(colors), paddingHorizontal: space.lg },
  picker: { gap: space.sm },
  agents: { gap: space['2xs'] },
  agent: { flexDirection: 'row', alignItems: 'center', gap: space.md, minHeight: 44 },
  box: {
    width: 22,
    height: 22,
    borderRadius: radius.sm,
    borderWidth: StyleSheet.hairlineWidth * 3,
    borderColor: colors.borderStrong,
    alignItems: 'center',
    justifyContent: 'center',
  },
  boxOn: { backgroundColor: colors.selectedFill, borderColor: colors.selectedFill },
  flow: { flexDirection: 'row', alignItems: 'center', gap: space.sm, minHeight: 32 },
  status: { flexDirection: 'row', alignItems: 'center', gap: space.xs },
}));

/** A throw while drawing stays on this screen, with the way back. */
export { ScreenError as ErrorBoundary } from '../components/ScreenError';
