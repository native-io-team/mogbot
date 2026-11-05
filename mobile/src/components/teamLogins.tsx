/**
 * "What your team needs" (desktop `agents_logins_team`): every login card
 * waiting, one row per service, not per agent. Gmail and Calendar are one
 * Google row; three agents asking for GitHub are one GitHub row. One Connect
 * signs in once (here, when the Mac lets the phone: `phoneWay`; else on the
 * Mac), the token is kept on the Mac, and every agent on the row gets its
 * own permission; "Not needed" puts one agent's ask away without waking it.
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
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { makeStyles, useColors } from '../lib/appearance';
import { haptic } from '../lib/haptics';
import {
  CLAUDE_AI_CONNECTORS,
  agentList,
  connectNeed,
  hasSignInSheet,
  loginDismiss,
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
import { fonts, space, type } from '../lib/theme';
import { ACTION_ROW, Card, CardActions, Line, TextAction } from './surfaces';
import { Button, T } from './ui';

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
  /** Inside another card: no "nothing waiting" line of its own. */
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
      <T variant="small" color={colors.textSecondary} testID="team-progress">
        {teamProgress(team)}
      </T>
      {team.total === 0 && !embedded && (
        <Line text="Nothing waiting. When an agent needs an app, it shows here and in its chat." />
      )}
      {team.needs.map((n) => (
        <Need
          key={n.key}
          need={n}
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
        />
      ))}
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
  live,
  busy,
  way,
  onConnect,
  onDismiss,
}: {
  need: TeamNeed;
  live: boolean;
  busy: string | null;
  way: (o: LoginOption) => ReturnType<typeof phoneWay>;
  onConnect: (option: LoginOption) => void;
  onDismiss: (card: TeamCard) => void;
}) {
  const colors = useColors();
  const styles = useStyles();
  const waiting = need.cards.filter((c) => c.state === 'waiting');
  const names = agentList(need.cards.map((c) => c.agentName));
  if (need.done) {
    return <Line icon="checkmark" tone="success" lead="Done" text={`${need.title} · ${names}`} />;
  }
  const [first, ...rest] = need.options.filter((o) => o.method !== 'key');
  const running = waiting.some(onMac);
  const off = !live || !!busy || running;
  return (
    <Card
      icon="puzzlepiece"
      title={need.title}
      source={`Used by ${names}`}
      testID={`need-${need.key}`}
      style={styles.card}
    >
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
            {c.state === 'waiting' && !onMac(c) && (
              <TextAction
                label="Not needed"
                muted
                disabled={!live || !!busy}
                onPress={() => onDismiss(c)}
              />
            )}
          </View>
        ))}
      </View>
      {running ? (
        <RunningLine card={waiting.find(onMac)} />
      ) : (
        <>
          {!!need.noConnector && (
            <T variant="small" color={colors.textMuted}>
              {need.noConnector}
            </T>
          )}
          {first && (
            <T variant="small" color={colors.textMuted}>
              {phoneDetail(first, way(first), need.title)}
            </T>
          )}
        </>
      )}
      {running ? null : first ? (
        <CardActions>
          <Button
            title={`${first.label}${waiting.length > 1 ? ` for ${waiting.length}` : ''}`}
            variant="answer"
            busy={busy === `${need.key}:${first.id}`}
            disabled={off}
            onPress={() => onConnect(first)}
            style={ACTION_ROW}
          />
          {rest.map((o) => (
            <Button
              key={o.id}
              title={o.label}
              variant="outline"
              busy={busy === `${need.key}:${o.id}`}
              disabled={off}
              onPress={() => onConnect(o)}
              style={ACTION_ROW}
            />
          ))}
        </CardActions>
      ) : (
        <T variant="small" color={colors.textMuted}>
          Nothing on your Mac can connect this. Open each agent’s card to enter a key, or mark it
          Not needed.
        </T>
      )}
    </Card>
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
            title="Open claude.ai"
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
  // On a sheet the page is the card's own colour: the grouped surface sets it apart.
  card: { backgroundColor: colors.surfaceGroup },
  loading: { padding: space.xl, alignItems: 'center' },
  cards: { gap: space.tight },
  cardRow: { flexDirection: 'row', alignItems: 'center', gap: space.md },
}));
