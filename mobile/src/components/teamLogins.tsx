/**
 * "What your team needs" (desktop `agents_logins_team`): every login card
 * waiting, one row per service, not per agent. Gmail and Calendar are one
 * Google row; three agents asking for GitHub are one GitHub row. One Connect
 * signs in once, on the Mac, and every agent on the row gets its own
 * permission; "Not needed" puts one agent's ask away without waking it.
 *
 * Exported as a list so another screen (an onboarding checklist) can embed
 * it; `app/logins.tsx` is the screen around it.
 */

import type { TeamCard, TeamLogins, TeamNeed } from '@shipstudio/companion-protocol';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { makeStyles, useColors } from '../lib/appearance';
import { haptic } from '../lib/haptics';
import { agentList, connectNeed, loginDismiss, readTeam, signingIn, teamCardLine, teamProgress } from '../lib/logins';
import { describeError } from '../lib/session';
import { useApp } from '../lib/store';
import { space } from '../lib/theme';
import { ACTION_ROW, Card, CardActions, Line, TextAction } from './surfaces';
import { Button, T } from './ui';

/** How often the list is read again while a sign-in runs on the Mac. */
const LIVE_MS = 2500;

const onMac = signingIn;

export function TeamLoginsList({
  since,
  onProgress,
}: {
  /** Count rows answered since then in the progress line (default: when this opened). */
  since?: number;
  onProgress?: (team: TeamLogins) => void;
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

  const load = useCallback(() => {
    readTeam(opened).then(
      (t) => {
        setTeam(t);
        onProgress?.(t);
      },
      (e) => setError(describeError(e))
    );
  }, [opened, onProgress]);
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
      {team.total === 0 && (
        <Line text="Nothing waiting. When an agent needs an app, it shows here and in its chat." />
      )}
      {team.needs.map((n) => (
        <Need
          key={n.key}
          need={n}
          live={live}
          busy={busy}
          onConnect={(optionId) => void act(`${n.key}:${optionId}`, () => connectNeed(n.key, optionId, []))}
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
  onConnect,
  onDismiss,
}: {
  need: TeamNeed;
  live: boolean;
  busy: string | null;
  onConnect: (optionId: string) => void;
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
        <T variant="small" color={colors.textBody} testID="need-on-mac">
          Finish signing in on your Mac — it’s open there. Everyone on this row gets it when it’s done.
        </T>
      ) : (
        <>
          {!!need.noConnector && (
            <T variant="small" color={colors.textMuted}>
              {need.noConnector}
            </T>
          )}
          {first && (
            <T variant="small" color={colors.textMuted}>
              {first.detail}
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
            onPress={() => onConnect(first.id)}
            style={ACTION_ROW}
          />
          {rest.map((o) => (
            <Button
              key={o.id}
              title={o.label}
              variant="outline"
              busy={busy === `${need.key}:${o.id}`}
              disabled={off}
              onPress={() => onConnect(o.id)}
              style={ACTION_ROW}
            />
          ))}
        </CardActions>
      ) : (
        <T variant="small" color={colors.textMuted}>
          Nothing on your Mac can connect this. Open each agent’s card to enter a key, or mark it Not
          needed.
        </T>
      )}
    </Card>
  );
}

const useStyles = makeStyles((colors) => ({
  root: { gap: space.md },
  // On a sheet the page is the card's own colour: the grouped surface sets it apart.
  card: { backgroundColor: colors.surfaceGroup },
  loading: { padding: space.xl, alignItems: 'center' },
  cards: { gap: space.tight },
  cardRow: { flexDirection: 'row', alignItems: 'center', gap: space.md },
}));
