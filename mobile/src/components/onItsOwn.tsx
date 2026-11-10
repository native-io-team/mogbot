/**
 * "What can this agent do on its own?" on the phone (desktop
 * `agents_on_its_own`, `agents/on_its_own.rs`): its level and line, what
 * always asks, and every standing rule in the Mac's plain words, grouped as
 * on the desk, each with the one tap that takes it away
 * (`agents.onItsOwnNarrow`, applied at once with a line in its chat). The
 * team's view lists the shared rules and each agent, a tap away from its own.
 * Nothing here gives: more is always a card in the chat.
 */

import {
  ON_ITS_OWN_ALWAYS_ASKS,
  ON_ITS_OWN_FOOT,
  ON_ITS_OWN_NONE,
  ON_ITS_OWN_STANDING,
  INDEPENDENCE_LABEL,
  narrowA11y,
  narrowKey,
  narrowLabel,
  onItsOwnIsBare,
  onItsOwnLevel,
  onItsOwnSections,
  onItsOwnTeamRowLine,
  timeLeftLine,
  type OnItsOwn,
  type OnItsOwnItem,
  type OnItsOwnNarrow,
  type OnItsOwnTeam,
} from '@shipstudio/companion-protocol';
import { router } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { View } from 'react-native';
import { makeStyles, useColors } from '../lib/appearance';
import { haptic } from '../lib/haptics';
import { call, describeError } from '../lib/session';
import { useApp, useServed } from '../lib/store';
import { useRemembered } from '../lib/remembered';
import { space } from '../lib/theme';
import { TextAction } from './surfaces';
import { Row, SectionTitle, T, groupSurface, pageRhythm } from './ui';

export const readOnItsOwn = (agentId: string) => call('agents.onItsOwn', { agentId });
export const readOnItsOwnTeam = () => call('agents.onItsOwnTeam', {});
export const narrowOnItsOwn = (agentId: string, narrow: OnItsOwnNarrow) =>
  call('agents.onItsOwnNarrow', { agentId, narrow });

/** An item's second line: its detail, then a plan's time left. */
export function itemDetail(item: OnItsOwnItem, now: number): string | undefined {
  const parts = [item.detail, item.endsAt ? timeLeftLine(item.endsAt, now) : undefined].filter(
    Boolean
  );
  return parts.length ? parts.join(' · ') : undefined;
}

function Items({
  items,
  now,
  busy,
  enabled,
  onNarrow,
}: {
  items: OnItsOwnItem[];
  now: number;
  busy: string | null;
  enabled: boolean;
  onNarrow: (n: OnItsOwnNarrow) => void;
}) {
  const styles = useStyles();
  return (
    <View style={styles.list}>
      {items.map((item, i) => (
        <Row
          key={item.key}
          label={item.text}
          detail={itemDetail(item, now)}
          last={i === items.length - 1}
          trailing={
            item.narrow.length > 0 ? (
              <View style={styles.actions}>
                {item.narrow.map((n) => (
                  <TextAction
                    key={narrowKey(n)}
                    label={narrowLabel(n)}
                    hint={narrowA11y(n, item)}
                    disabled={!enabled || busy !== null}
                    onPress={() => onNarrow(n)}
                  />
                ))}
              </View>
            ) : undefined
          }
        />
      ))}
    </View>
  );
}

/** One agent's list. */
export function OnItsOwnList({ agentId }: { agentId: string }) {
  const colors = useColors();
  const styles = useStyles();
  const served = useServed('agents.onItsOwn');
  const canNarrow = useServed('agents.onItsOwnNarrow');
  const live = useApp((s) => s.link.kind === 'connected');
  // The registry changes when a rule, admin or browser does: read it again then.
  const stamp = useApp((s) => s.overview?.agents.find((a) => a.id === agentId));
  const [view, setView] = useRemembered<OnItsOwn>(`onItsOwn:${agentId}`);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!served || !live) return;
    let on = true;
    readOnItsOwn(agentId).then(
      (v) => {
        if (!on) return;
        setView(v);
        setNow(Date.now());
      },
      (e) => on && setError(describeError(e))
    );
    return () => {
      on = false;
    };
  }, [agentId, served, live, stamp, setView]);

  const narrow = useCallback(
    async (n: OnItsOwnNarrow) => {
      setBusy(narrowKey(n));
      setError(null);
      try {
        setView(await narrowOnItsOwn(agentId, n));
        setNow(Date.now());
        haptic.success();
      } catch (e) {
        haptic.error();
        setError(describeError(e));
      } finally {
        setBusy(null);
      }
    },
    [agentId]
  );

  if (!served) return null;
  if (!view) {
    return error ? (
      <T variant="small" color={colors.accentErrorLight} style={styles.pad}>
        {error}
      </T>
    ) : null;
  }
  return (
    <View testID="on-its-own" style={styles.root}>
      <View style={styles.level}>
        <T variant="body" color={colors.textStrong}>
          {onItsOwnLevel(view.level, view.ownLevel)}
        </T>
        <T variant="small" color={colors.textSecondary}>
          {view.levelLine}
        </T>
      </View>
      <SectionTitle title={ON_ITS_OWN_ALWAYS_ASKS} style={styles.title} />
      <View style={styles.list}>
        {view.alwaysAsks.map((line, i) => (
          <Row key={line} label={line} last={i === view.alwaysAsks.length - 1} />
        ))}
      </View>
      <SectionTitle title={ON_ITS_OWN_STANDING} style={styles.title} />
      {onItsOwnIsBare(view) && (
        <T variant="small" color={colors.textMuted} style={styles.note}>
          {ON_ITS_OWN_NONE}
        </T>
      )}
      {onItsOwnSections(view.items).map((s, i) => (
        // Each after the first a step further from the group above than from
        // its own, so "Plans you OK'd" reads as Plans' title, not Rules' foot.
        <View key={s.title} style={[styles.section, i > 0 && styles.later]}>
          <T variant="caption" color={colors.textMuted} style={styles.sub}>
            {s.title}
          </T>
          <Items
            items={s.items}
            now={now}
            busy={busy}
            enabled={live && canNarrow}
            onNarrow={(n) => void narrow(n)}
          />
        </View>
      ))}
      {!!error && (
        <T variant="small" color={colors.accentErrorLight} style={styles.note}>
          {error}
        </T>
      )}
      <T variant="caption" color={colors.textMuted} style={styles.foot}>
        {ON_ITS_OWN_FOOT}
      </T>
    </View>
  );
}

/** The team's list: its level, the shared rules, each agent a tap away. */
export function OnItsOwnTeamList() {
  const colors = useColors();
  const styles = useStyles();
  const served = useServed('agents.onItsOwnTeam');
  const canNarrow = useServed('agents.onItsOwnNarrow');
  const live = useApp((s) => s.link.kind === 'connected');
  const chief = useApp((s) => s.overview?.agents.find((a) => a.isMain)?.id);
  const agents = useApp((s) => s.overview?.agents);
  const [team, setTeam] = useRemembered<OnItsOwnTeam>('onItsOwn:team');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => {
    if (!served || !live) return;
    let on = true;
    readOnItsOwnTeam().then(
      (t) => on && setTeam(t),
      (e) => on && setError(describeError(e))
    );
    return () => {
      on = false;
    };
  }, [served, live, agents, setTeam]);

  // A team rule is taken back through the Chief: the line lands in its chat.
  const narrowTeam = async (n: OnItsOwnNarrow) => {
    if (!chief) return;
    setBusy(narrowKey(n));
    setError(null);
    try {
      await narrowOnItsOwn(chief, n);
      setTeam(await readOnItsOwnTeam());
      haptic.success();
    } catch (e) {
      haptic.error();
      setError(describeError(e));
    } finally {
      setBusy(null);
    }
  };

  if (!served) return null;
  if (!team) {
    return error ? (
      <T variant="small" color={colors.accentErrorLight} style={styles.pad}>
        {error}
      </T>
    ) : null;
  }
  return (
    <View testID="on-its-own-team" style={styles.root}>
      <View style={styles.level}>
        <T variant="body" color={colors.textStrong}>
          {INDEPENDENCE_LABEL[team.level]}
        </T>
        <T variant="small" color={colors.textSecondary}>
          {team.levelLine}
        </T>
        <T variant="small" color={colors.textSecondary}>
          {team.alwaysAsks.join(' ')}
        </T>
      </View>
      {team.teamRules.length > 0 && (
        <>
          <SectionTitle title="Rules for every agent" style={styles.title} />
          <Items
            items={team.teamRules}
            now={Date.now()}
            busy={busy}
            enabled={live && canNarrow && !!chief}
            onNarrow={(n) => void narrowTeam(n)}
          />
        </>
      )}
      <SectionTitle title="Agents" style={styles.title} />
      <View style={styles.list}>
        {team.agents.map((row, i) => (
          <Row
            key={row.agentId}
            label={row.name}
            detail={onItsOwnTeamRowLine(row)}
            last={i === team.agents.length - 1}
            onPress={() => router.push({ pathname: '/on-its-own', params: { id: row.agentId } })}
          />
        ))}
      </View>
      {!!error && (
        <T variant="small" color={colors.accentErrorLight} style={styles.note}>
          {error}
        </T>
      )}
      <T variant="caption" color={colors.textMuted} style={styles.foot}>
        {ON_ITS_OWN_FOOT}
      </T>
    </View>
  );
}

const RHYTHM = pageRhythm(space.sm);

const useStyles = makeStyles((colors) => ({
  root: { gap: space.sm },
  title: RHYTHM.title,
  section: { gap: space.xs },
  later: { marginTop: space.xs },
  sub: { paddingHorizontal: space.lg },
  list: groupSurface(colors),
  level: { ...groupSurface(colors), gap: space['2xs'], padding: space.lg },
  actions: { flexDirection: 'row', gap: space.md },
  note: { paddingHorizontal: space.lg },
  foot: { paddingHorizontal: space.lg, ...RHYTHM.note },
  pad: { padding: space.lg },
}));
