/**
 * "What it can do" (desktop `agents_policy`, `agents/policy.rs`): the
 * agent's settings in one list, each saying whether it's the team's or its
 * own and which are only instructions. Read-only here; changing it happens
 * in chat: "Change in chat" opens the Chief of Staff with the request
 * started, and the Chief proposes it on a card the user allows.
 */

import {
  ENFORCED_NOTE,
  chatDraft,
  type AgentPolicyView,
  type PolicyLine,
} from '@shipstudio/companion-protocol';
import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { View } from 'react-native';
import { makeStyles, useColors } from '../lib/appearance';
import { setComposer } from '../lib/drafts';
import { call } from '../lib/session';
import { useApp, useServed } from '../lib/store';
import { radius, space } from '../lib/theme';
import { TextAction } from './surfaces';
import { Row, SectionTitle, T } from './ui';

export const readPolicy = (agentId: string) => call('agents.policy', { agentId });

/** One line's detail: its value, then whose it is and whether the app enforces it. */
export function policyDetail(line: PolicyLine): string {
  return `${line.value} · ${line.team ? 'Team default' : 'Its own'}${
    line.enforced === 'prompt' ? ' · instructions' : ''
  }`;
}

export function WhatItCanDo({ agentId, name }: { agentId: string; name: string }) {
  const colors = useColors();
  const styles = useStyles();
  const served = useServed('agents.policy');
  const live = useApp((s) => s.link.kind === 'connected');
  const chief = useApp((s) => s.overview?.agents.find((a) => a.isMain)?.id);
  // A settings card answered changes it: read it again then.
  const stamp = useApp((s) => s.overview?.agents.find((a) => a.id === agentId)?.pendingApprovals);
  const [view, setView] = useState<AgentPolicyView | null>(null);
  useEffect(() => {
    if (!served || !live) return;
    let on = true;
    readPolicy(agentId).then(
      (v) => on && setView(v),
      () => {}
    );
    return () => {
      on = false;
    };
  }, [agentId, served, live, stamp]);
  if (!served || !view) return null;
  return (
    <>
      <SectionTitle title="What it can do" style={styles.title} />
      <View style={styles.list} testID="policy">
        {view.lines.map((l, i) => (
          <Row key={l.key} label={l.label} detail={policyDetail(l)} last={i === view.lines.length - 1} />
        ))}
      </View>
      <T variant="caption" color={colors.textMuted} style={styles.note}>
        {ENFORCED_NOTE}
      </T>
      {chief && (
        <TextAction
          label="Change in chat"
          hint="Your Chief of Staff shows you the change on a card first."
          onPress={() => {
            setComposer(chief, { text: chatDraft(name) });
            router.push({ pathname: '/chat/[id]', params: { id: chief, compose: '1' } });
          }}
        />
      )}
    </>
  );
}

const useStyles = makeStyles((colors) => ({
  title: { marginBottom: 0 },
  list: { backgroundColor: colors.surfaceGroup, borderRadius: radius.card, overflow: 'hidden' },
  note: { paddingHorizontal: space.lg },
}));
