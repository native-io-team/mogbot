/**
 * "Save what it learns" and "What it knows how to do" on the agent sheet
 * (desktop `agents_skills`, `agents/skills_learn.rs`). The setting is three
 * choices in a menu, saved at once (`agents.update` `learnSkills`); each
 * skill opens its steps, with Edit (the skill editor page) and Remove. The
 * words are the desk's (`companion-protocol/src/skills.ts`).
 */

import {
  LEARN_SKILLS_CHOICES,
  LEARN_SKILLS_LABEL,
  SKILLS_TITLE,
  learnSkillsDetail,
  learnSkillsLabel,
  learnSkillsOf,
  noSkillsLine,
  type Agent,
  type Skill,
  type SkillsView,
} from '@shipstudio/companion-protocol';
import { router } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { Alert, View } from 'react-native';
import { makeStyles, useColors } from '../lib/appearance';
import { haptic } from '../lib/haptics';
import { call, describeError, setAgentToggles } from '../lib/session';
import { useApp, useServed } from '../lib/store';
import { radius, space } from '../lib/theme';
import { choose } from './menu';
import { Row, SectionTitle, T } from './ui';

export const readSkills = (agentId: string) => call('agents.skills', { agentId });

export function WhatItKnows({
  agent,
  enabled,
  onError,
}: {
  agent: Agent;
  enabled: boolean;
  onError: (text: string | null) => void;
}) {
  const colors = useColors();
  const styles = useStyles();
  const served = useServed('agents.skills');
  const live = useApp((s) => s.link.kind === 'connected');
  // A skill card answered, or the setting changed: read it again then.
  const stamp = useApp((s) => {
    const a = s.overview?.agents.find((x) => x.id === agent.id);
    return `${a?.pendingApprovals ?? 0}:${a?.learnSkills ?? 'ask'}`;
  });
  const [view, setView] = useState<SkillsView | null>(null);
  const load = useCallback(() => {
    readSkills(agent.id).then(setView, () => {});
  }, [agent.id]);
  useEffect(() => {
    if (served && live) load();
  }, [served, live, load, stamp]);
  if (!served) return null;
  const setting = learnSkillsOf(agent);

  const pick = () =>
    choose(
      LEARN_SKILLS_LABEL,
      LEARN_SKILLS_CHOICES.map((c) => ({
        label: c.value === setting ? `${c.label} ✓` : c.label,
        run: () => {
          haptic.select();
          onError(null);
          setAgentToggles(agent.id, { learnSkills: c.value }).catch((e: unknown) =>
            onError(describeError(e))
          );
        },
      }))
    );

  const remove = (skill: Skill) =>
    Alert.alert(`Remove “${skill.name}”?`, `${agent.name} won’t follow these steps any more.`, [
      { text: 'Keep', style: 'cancel' },
      {
        text: 'Remove',
        style: 'destructive',
        onPress: () => {
          onError(null);
          call('agents.skillRemove', { agentId: agent.id, slug: skill.slug })
            .then(() => {
              haptic.warning();
              load();
            })
            .catch((e: unknown) => onError(describeError(e)));
        },
      },
    ]);

  const open = (skill: Skill) =>
    choose(skill.name, [
      {
        label: 'Edit',
        run: () =>
          router.push({ pathname: '/skill', params: { id: agent.id, slug: skill.slug } }),
      },
      { label: 'Remove', destructive: true, run: () => remove(skill) },
    ], skill.steps);

  const skills = view?.skills ?? [];
  return (
    <>
      <SectionTitle title={SKILLS_TITLE} style={styles.title} />
      <View style={styles.list} testID="skills">
        <Row
          label={LEARN_SKILLS_LABEL}
          value={learnSkillsLabel(setting)}
          onPress={enabled ? pick : undefined}
          last={skills.length === 0}
        />
        {skills.map((s, i) => (
          <Row
            key={s.slug}
            label={s.name}
            detail={s.when}
            onPress={enabled ? () => open(s) : undefined}
            last={i === skills.length - 1}
          />
        ))}
      </View>
      <T variant="caption" color={colors.textMuted} style={styles.note}>
        {view && skills.length === 0 ? noSkillsLine(agent.name, setting) : learnSkillsDetail(setting)}
      </T>
    </>
  );
}

/** One skill, for the editor page. */
export function useSkill(agentId: string, slug: string): Skill | null | undefined {
  const [skill, setSkill] = useState<Skill | null | undefined>(undefined);
  useEffect(() => {
    readSkills(agentId).then(
      (v) => setSkill(v.skills.find((s) => s.slug === slug) ?? null),
      () => setSkill(null)
    );
  }, [agentId, slug]);
  return skill;
}

const useStyles = makeStyles((colors) => ({
  title: { marginBottom: 0 },
  list: { backgroundColor: colors.surfaceGroup, borderRadius: radius.card, overflow: 'hidden' },
  note: { paddingHorizontal: space.lg },
}));
