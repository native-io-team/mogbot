/**
 * "What your team needs" (desktop `agents_logins_team`): every login card
 * waiting, one row per service, not per agent. Gmail and Calendar are one
 * Google row; three agents asking for GitHub are one GitHub row. One Connect
 * signs in once (here, when the Mac lets the phone: `phoneWay`; else on the
 * Mac), the token is kept on the Mac, and every agent on the row gets its
 * own permission; "Not needed" puts one agent's ask away without waking it.
 *
 * Every row has one anatomy (`NeedRow`), shared with the setup card's Logins
 * step: the service as the title, who uses it as a quieter line under it,
 * one answer at the right, and anything else ("Not needed", another way in)
 * as quiet words beside it.
 *
 * Exported as a list so another screen (an onboarding checklist) can embed
 * it; `app/logins.tsx` is the screen around it.
 */

import {
  MAC_FEATURES,
  type LoginOption,
  type TeamCard,
  type TeamLogins,
  type TeamNeed,
} from '@shipstudio/companion-protocol';
import * as Clipboard from 'expo-clipboard';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { makeStyles, useColors } from '../lib/appearance';
import { haptic } from '../lib/haptics';
import {
  CLAUDE_AI_CONNECTORS,
  agentList,
  connectNeed,
  hasSignInSheet,
  loginDismiss,
  loginsNotNeeded,
  openHere,
  phoneDetail,
  phoneWay,
  readTeam,
  scopeTeam,
  signInWithSheet,
  signingIn,
  teamCardLine,
  teamProgress,
} from '../lib/logins';
import { describeError } from '../lib/session';
import { useApp, useServed } from '../lib/store';
import { CARD_TITLE_SCALE, fonts, lineHeight, space, type } from '../lib/theme';
import { ACTION_ROW, CardActions, Line, TextAction } from './surfaces';
import { DeclineReceiptLine, useDeclineReceipt, useRecheckWhenBack } from './loginExtras';
import { Button, T, groupSurface } from './ui';

/** How often the list is read again while a sign-in runs on the Mac. */
const LIVE_MS = 2500;

const onMac = signingIn;

export function TeamLoginsList({
  since,
  onProgress,
  agentIds,
  embedded,
}: {
  /** Count rows answered since then in the progress line (default: when this opened). */
  since?: number;
  onProgress?: (team: TeamLogins) => void;
  /** Only these agents' asks (the setup card's); a Connect skips the rest. */
  agentIds?: ReadonlySet<string>;
  /** Inside another card: no "nothing waiting" line of its own, and no group around the rows. */
  embedded?: boolean;
}) {
  const colors = useColors();
  const styles = useStyles();
  const live = useApp((s) => s.link.kind === 'connected');
  // A card answered anywhere changes the registry: read the list again.
  const stamp = useApp((s) => s.overview?.agents.reduce((n, a) => n + a.pendingApprovals, 0));
  const opened = useRef(since ?? Date.now() - 60_000).current;
  const [team, setTeam] = useState<TeamLogins | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const phoneSignIn = useServed('agents.loginPhoneBegin', MAC_FEATURES.loginsPhone);
  const way = useCallback(
    (o: LoginOption) => phoneWay(o, phoneSignIn, hasSignInSheet()),
    [phoneSignIn]
  );

  const load = useCallback(() => {
    readTeam(opened).then(
      (all) => {
        const t = agentIds ? scopeTeam(all, agentIds) : all;
        setTeam(t);
        onProgress?.(t);
      },
      (e) => setError(describeError(e))
    );
  }, [opened, onProgress, agentIds]);
  useEffect(() => {
    if (live) load();
  }, [live, load, stamp]);
  const signingIn = !!team?.needs.some((n) => n.cards.some(onMac));
  const canDecline = useServed('agents.loginsNotNeeded');
  const [receipt, setReceipt] = useDeclineReceipt();
  useRecheckWhenBack(
    !!team?.needs.some((n) =>
      n.cards.some(
        (c) => c.flow?.state === 'waiting' && c.flow.onPhone && c.flow.option === 'claude_ai'
      )
    )
  );
  useEffect(() => {
    if (!signingIn || !live) return;
    const timer = setInterval(load, LIVE_MS);
    return () => clearInterval(timer);
  }, [signingIn, live, load]);

  const act = async (tag: string, run: () => Promise<unknown>) => {
    setBusy(tag);
    setError(null);
    try {
      await run();
      haptic.select();
      load();
    } catch (e) {
      haptic.error();
      setError(describeError(e));
    } finally {
      setBusy(null);
    }
  };

  const waitingKeys = (team?.needs ?? []).filter((n) => !n.done).map((n) => n.key);
  if (!team) {
    return (
      <View style={styles.loading}>
        {live ? (
          <ActivityIndicator color={colors.textMuted} />
        ) : (
          <T variant="small" color={colors.textMuted}>
            Needs your Mac.
          </T>
        )}
      </View>
    );
  }
  return (
    <View style={styles.root} testID="team-logins">
      <View style={styles.header}>
        <T variant="small" color={colors.textSecondary} testID="team-progress" style={{ flex: 1 }}>
          {teamProgress(team)}
        </T>
        {canDecline && waitingKeys.length > 1 && (
          <TextAction
            label="Skip the rest"
            hint="No agent will ask for these again"
            muted
            disabled={!live || !!busy}
            onPress={() =>
              void act('skip-rest', async () => setReceipt(await loginsNotNeeded(waitingKeys)))
            }
          />
        )}
      </View>
      {receipt && (
        <DeclineReceiptLine
          receipt={receipt}
          onDone={() => {
            setReceipt(null);
            load();
          }}
          onError={setError}
        />
      )}
      {team.total === 0 && !embedded && (
        <Line text="Nothing waiting. When an agent needs an app, it shows here and in its chat." />
      )}
      {team.needs.length > 0 && (
        <View style={!embedded && styles.group}>
          {team.needs.map((n, i) => (
            <Need
              key={n.key}
              need={n}
              last={i === team.needs.length - 1}
              live={live}
              busy={busy}
              way={way}
              onConnect={(o) =>
                void act(`${n.key}:${o.id}`, async () => {
                  // Agents this list leaves off (`agentIds`) are skipped too.
                  const skip = (n as TeamNeed & { hidden?: string[] }).hidden ?? [];
                  switch (way(o)) {
                    case 'sheet':
                      return signInWithSheet({ key: n.key, skip }, o.id);
                    case 'web':
                      await connectNeed(n.key, o.id, skip, true);
                      return openHere(CLAUDE_AI_CONNECTORS);
                    case 'device':
                      return connectNeed(n.key, o.id, skip, true);
                    default:
                      return connectNeed(n.key, o.id, skip);
                  }
                })
              }
              onDismiss={(c) => void act(c.requestId, () => loginDismiss(c.agentId, c.requestId))}
              onNotNeeded={
                canDecline
                  ? () =>
                      void act(`${n.key}:not-needed`, async () =>
                        setReceipt(await loginsNotNeeded([n.key]))
                      )
                  : undefined
              }
            />
          ))}
        </View>
      )}
      {error && (
        <T variant="small" color={colors.accentErrorLight}>
          {error}
        </T>
      )}
    </View>
  );
}

function Need({
  need,
  last,
  live,
  busy,
  way,
  onConnect,
  onDismiss,
  onNotNeeded,
}: {
  need: TeamNeed;
  last: boolean;
  live: boolean;
  busy: string | null;
  way: (o: LoginOption) => ReturnType<typeof phoneWay>;
  onConnect: (option: LoginOption) => void;
  onDismiss: (card: TeamCard) => void;
  /** The app, declined for the whole team (a Mac that serves it). */
  onNotNeeded?: () => void;
}) {
  const colors = useColors();
  const styles = useStyles();
  const waiting = need.cards.filter((c) => c.state === 'waiting');
  const names = agentList(need.cards.map((c) => c.agentName));
  if (need.done) {
    return (
      <View style={[styles.doneRow, !last && styles.divided]} testID={`need-${need.key}`}>
        <Line icon="checkmark" tone="success" lead="Done" text={`${need.title} · ${names}`} />
      </View>
    );
  }
  const [first, ...rest] = need.options.filter((o) => o.method !== 'key');
  const running = waiting.some(onMac);
  const off = !live || !!busy || running;
  // One agent on the row: its "Not needed" sits beside the answer. Several:
  // each agent's line carries its own, so one can be put away and not the rest.
  const single = need.cards.length === 1 && waiting.length === 1 ? waiting[0] : null;
  // With "Not needed" for the team on the row, one agent's own is "Skip".
  const dismiss = (c: TeamCard): RowWord => ({
    label: onNotNeeded ? 'Skip' : 'Not needed',
    muted: true,
    hint: onNotNeeded
      ? `Puts away ${c.agentName}’s card`
      : `Puts ${c.agentName}’s ask away without waking it`,
    disabled: !live || !!busy,
    onPress: () => onDismiss(c),
  });
  const notNeeded: RowWord[] = onNotNeeded
    ? [
        {
          label: 'Not needed',
          muted: true,
          hint: 'No agent will ask for it again',
          disabled: !live || !!busy,
          onPress: onNotNeeded,
        },
      ]
    : [];
  return (
    <NeedRow
      last={last}
      title={need.title}
      subtitle={`Used by ${names}`}
      testID={`need-${need.key}`}
      detail={
        running ? (
          <RunningLine card={waiting.find(onMac)} />
        ) : (
          <>
            {!single && (
              <View style={styles.cards}>
                {need.cards.map((c) => (
                  <View key={c.requestId} style={styles.cardRow}>
                    <T
                      variant="small"
                      color={c.state === 'waiting' ? colors.textBody : colors.textMuted}
                      style={{ flex: 1 }}
                    >
                      {teamCardLine(c)}
                    </T>
                    {c.state === 'waiting' && !onMac(c) && <TextAction {...dismiss(c)} />}
                  </View>
                ))}
              </View>
            )}
            {!!need.noConnector && (
              <T variant="small" color={colors.textMuted}>
                {need.noConnector}
              </T>
            )}
            <T variant="small" color={colors.textMuted}>
              {first
                ? phoneDetail(first, way(first), need.title)
                : 'Nothing on your Mac can connect this. Open each agent’s card to enter a key, or mark it Not needed.'}
            </T>
          </>
        )
      }
      primary={
        running || !first
          ? undefined
          : {
              title: `${first.label}${waiting.length > 1 ? ` for ${waiting.length}` : ''}`,
              busy: busy === `${need.key}:${first.id}`,
              disabled: off,
              onPress: () => onConnect(first),
            }
      }
      secondary={
        running
          ? []
          : [
              ...rest.map((o) => ({
                label: o.label,
                disabled: off,
                onPress: () => onConnect(o),
              })),
              ...(onNotNeeded ? notNeeded : single && !onMac(single) ? [dismiss(single)] : []),
            ]
      }
    />
  );
}

/** A quiet word beside a row's answer: "Not needed", another way in. */
export interface RowWord {
  label: string;
  onPress: () => void;
  hint?: string;
  muted?: boolean;
  disabled?: boolean;
}

/**
 * The row every login and key shares, here and in the setup card's Logins
 * step: the service as the title (17 semibold), who uses it under it,
 * quieter, then any detail; under that one line with the quiet words first
 * and the single answer last, at the right. At least 56pt tall, divided from
 * the next by a hairline.
 */
export function NeedRow({
  title,
  subtitle,
  detail,
  primary,
  secondary = [],
  last = false,
  testID,
}: {
  title: string;
  subtitle?: string;
  detail?: ReactNode;
  primary?: {
    title: string;
    onPress: () => void;
    busy?: boolean;
    disabled?: boolean;
    hint?: string;
  };
  secondary?: RowWord[];
  /** The last row of its list draws no divider under it. */
  last?: boolean;
  testID?: string;
}) {
  const colors = useColors();
  const styles = useStyles();
  return (
    <View style={[styles.row, !last && styles.divided]} testID={testID}>
      <View style={styles.top}>
        <View style={styles.head}>
          <T
            color={colors.textStrong}
            style={styles.title}
            maxFontSizeMultiplier={CARD_TITLE_SCALE}
            accessibilityRole="header"
          >
            {title}
          </T>
          {!!subtitle && (
            <T
              variant="small"
              color={colors.textSecondary}
              maxFontSizeMultiplier={CARD_TITLE_SCALE}
            >
              {subtitle}
            </T>
          )}
        </View>
        {primary && (
          <Button
            title={primary.title}
            variant="answer"
            busy={primary.busy}
            disabled={primary.disabled}
            accessibilityHint={primary.hint}
            onPress={primary.onPress}
            testID="need-answer"
          />
        )}
      </View>
      {detail}
      {secondary.length > 0 && (
        <View style={styles.words} testID="need-words">
          {secondary.map((w) => (
            <TextAction key={w.label} {...w} />
          ))}
        </View>
      )}
    </View>
  );
}

/** A row signing in: on the Mac, or here (GitHub's code, claude.ai). */
function RunningLine({ card }: { card?: TeamCard }) {
  const colors = useColors();
  const styles = useStyles();
  const flow = card?.flow;
  if (!flow?.onPhone) {
    return (
      <T variant="small" color={colors.textBody} testID="need-on-mac">
        Finish signing in on your Mac — it’s open there. Everyone on this row gets it when it’s
        done.
      </T>
    );
  }
  return (
    <View style={styles.running} testID="need-on-phone">
      <T variant="small" color={colors.textBody}>
        {flow.message ?? 'Signing in here.'} Everyone on this row gets it when it’s done.
      </T>
      {!!flow.userCode && (
        <T selectable style={styles.code} color={colors.textPrimary} testID="need-device-code">
          {flow.userCode}
        </T>
      )}
      <CardActions>
        {!!flow.userCode && (
          <Button
            title="Copy code"
            variant="outline"
            onPress={() => void Clipboard.setStringAsync(flow.userCode ?? '')}
            style={ACTION_ROW}
          />
        )}
        {!!flow.verificationUri && (
          <Button
            title="Open GitHub"
            variant="answer"
            onPress={() => void openHere(flow.verificationUri!)}
            style={ACTION_ROW}
          />
        )}
        {flow.option === 'claude_ai' && (
          <Button
            title="Open Claude’s connectors"
            variant="answer"
            onPress={() => void openHere(CLAUDE_AI_CONNECTORS)}
            style={ACTION_ROW}
          />
        )}
      </CardActions>
    </View>
  );
}

const useStyles = makeStyles((colors) => ({
  running: { gap: space.sm },
  code: { fontFamily: fonts.mono, fontSize: type.title },
  root: { gap: space.md },
  header: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  // On a sheet the rows are one grouped surface, divided, as Settings is.
  group: { ...groupSurface(colors), paddingHorizontal: space.lg },
  loading: { padding: space.xl, alignItems: 'center' },
  cards: { gap: space['2xs'] },
  cardRow: { flexDirection: 'row', alignItems: 'center', gap: space.md, minHeight: 44 },
  row: { minHeight: 56, paddingVertical: space.md, gap: space.sm },
  // The name and who uses it, and the one answer beside them.
  top: { flexDirection: 'row', alignItems: 'center', gap: space.md, minHeight: 44 },
  divided: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.borderDefault,
  },
  doneRow: { minHeight: 56, justifyContent: 'center', paddingVertical: space.sm },
  head: { flex: 1, gap: space['2xs'] },
  title: {
    fontFamily: fonts.semibold,
    fontSize: type.read,
    lineHeight: lineHeight(type.read, 1.3),
  },
  // The quiet words under it, well apart, each a 44pt target with its hit slop.
  words: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    columnGap: space.xl,
    rowGap: space.md,
    minHeight: 32,
  },
}));
