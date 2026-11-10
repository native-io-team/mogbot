/**
 * "What it can reach" (desktop `agents_reach`): the apps an agent was
 * connected to, its browser, and its keys. The list itself is read-only;
 * which agents can use an app is changed (or the app removed) one tap away
 * in Apps, which the footer opens on this agent. Its browser and keys change
 * on the desk. An app the user chose not to connect ("Not needed", for
 * every agent) can be turned back on here.
 */

import { MAC_FEATURES, type AgentReach } from '@shipstudio/companion-protocol';
import { reachRows } from '../lib/loginState';
import { useEffect, useState } from 'react';
import { useRouter } from 'expo-router';
import { View } from 'react-native';
import { makeStyles, useColors } from '../lib/appearance';
import { loginsUndecline, readReach } from '../lib/logins';
import { describeError } from '../lib/session';
import { useApp, useServed } from '../lib/store';
import { useRemembered } from '../lib/remembered';
import { iconSize, space } from '../lib/theme';
import { TextAction } from './surfaces';
import { Icon, Row, SectionTitle, T, groupSurface, pageRhythm } from './ui';

export function WhatItCanReach({ agentId }: { agentId: string }) {
  const colors = useColors();
  const styles = useStyles();
  const served = useServed('agents.reach', MAC_FEATURES.logins);
  const live = useApp((s) => s.link.kind === 'connected');
  // The registry changes when a card is answered: read it again then.
  const stamp = useApp((s) => s.overview?.agents.find((a) => a.id === agentId)?.pendingApprovals);
  const [reach, setReach] = useRemembered<AgentReach>(`reach:${agentId}`);
  const [turnedOn, setTurnedOn] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const canUndecline = useServed('agents.loginsUndecline');
  const servesApps = useServed('agents.apps');
  const router = useRouter();
  useEffect(() => {
    if (!served || !live) return;
    let on = true;
    readReach(agentId).then(
      (r) => on && setReach(r),
      () => {}
    );
    return () => {
      on = false;
    };
  }, [agentId, served, live, stamp, setReach]);
  if (!served || !reach) return null;
  const rows = reachRows(reach);
  const declined = (reach.declined ?? []).filter((d) => !turnedOn.includes(d.key));
  return (
    <>
      <SectionTitle title="What it can reach" style={styles.title} />
      <View style={styles.list} testID="reach">
        {rows.length === 0 ? (
          <T variant="small" color={colors.textMuted} style={styles.none}>
            Nothing connected yet. When it needs an app, it asks on a card.
          </T>
        ) : (
          rows.map((r, i) => (
            <Row
              key={r.key}
              label={r.label}
              detail={r.detail}
              warning={r.warning}
              leading={
                <Icon
                  name={
                    r.key === 'browser'
                      ? 'globe'
                      : r.key.startsWith('s:')
                        ? 'lock.fill'
                        : 'puzzlepiece'
                  }
                  size={iconSize.body}
                  color={colors.textSecondary}
                />
              }
              last={i === rows.length - 1}
            />
          ))
        )}
      </View>
      {declined.length > 0 && (
        <View style={styles.list} testID="reach-declined">
          {declined.map((d, i) => (
            <Row
              key={d.key}
              label={d.title}
              detail="You chose not to connect it. No agent asks for it."
              trailing={
                canUndecline ? (
                  <TextAction
                    label="Turn back on"
                    onPress={() =>
                      void loginsUndecline([d.key]).then(
                        () => setTurnedOn((t) => [...t, d.key]),
                        (e) => setError(describeError(e))
                      )
                    }
                  />
                ) : undefined
              }
              last={i === declined.length - 1}
            />
          ))}
        </View>
      )}
      {!!error && (
        <T variant="small" color={colors.accentErrorLight} style={styles.note}>
          {error}
        </T>
      )}
      {/* Where taking it away is: Apps for its apps, here on the phone; the
          browser and keys on the Mac. Never a footer that says only "not here". */}
      {servesApps && reach.connections.length > 0 ? (
        <View style={styles.note}>
          <TextAction
            label="Change who can use each app"
            onPress={() => router.push({ pathname: '/apps', params: { agentId } })}
          />
          {(!!reach.browser?.on || reach.secrets.length > 0) && (
            <T variant="caption" color={colors.textMuted}>
              Its browser and keys change on your Mac.
            </T>
          )}
        </View>
      ) : (
        <T variant="caption" color={colors.textMuted} style={styles.note}>
          Change this on your Mac.
        </T>
      )}
    </>
  );
}

/** It sits in the agent sheet's column. */
const RHYTHM = pageRhythm(space.md);

const useStyles = makeStyles((colors) => ({
  title: RHYTHM.title,
  note: { paddingHorizontal: space.lg, ...RHYTHM.note },
  list: groupSurface(colors),
  none: { padding: space.lg },
}));
