/**
 * Agent controls: the sheet the composer's chip opens. Only what really
 * exists and can change mid-conversation, each the Mac's own path:
 *
 * - Model, and under it another engine ("Switch to Codex…"): `agents.update`
 *   with `engine` / `model` (`MAC_FEATURES.engine`). A new engine carries the
 *   conversation over as a recap.
 * - Effort: `agents.update` with `effort` (`MAC_FEATURES.effort`), Claude
 *   Code's `--effort` or Codex's reasoning effort, for its conversation.
 * - How much it does on its own: `agents.setAgentIndependence`. Raising it
 *   past the team's asks first; it applies at the turn's next step, so it is
 *   the one control open while a turn runs.
 * - Usage: the team's mode, read-only (there's no per-agent budget), and a
 *   way to the usage sheet.
 * - More about it: the agent sheet.
 *
 * Model and effort apply from its next message; the Mac writes one quiet
 * line in the chat saying so. While a turn runs (or it's driven on the Mac)
 * they're shown, dimmed, with why.
 */

import {
  AGENT_INDEPENDENCE_TITLE,
  INDEPENDENCE_DETAIL,
  INDEPENDENCE_LABEL,
  INDEPENDENCE_LEVELS,
  INDEPENDENCE_STILL_ASKS,
  MAC_FEATURES,
  USAGE_MODE_LABEL,
  effectiveIndependence,
  sameAsTeamLabel,
  type Agent,
  type AgentEffort,
  type AgentEngine,
  type AgentIndependence,
  type UsageMode,
} from '@shipstudio/companion-protocol';
import { useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { Alert, ScrollView, View } from 'react-native';
import { useAccent } from '../lib/accent';
import { chipLabel, controlsLocked, effortRows } from '../lib/agentControls';
import { currentModels, modelRowLabel, otherEngines } from '../lib/agentEngine';
import { engineName } from '../lib/agents';
import { makeStyles, useColors } from '../lib/appearance';
import { haptic } from '../lib/haptics';
import { modelOptions } from '../lib/newAgentDefaults';
import { call, canCall, describeError, setAgentEngine } from '../lib/session';
import { useApp, useServed } from '../lib/store';
import { iconSize, space } from '../lib/theme';
import { choose } from './menu';
import { SheetTitle } from './SheetTitle';
import { Icon, Row, Section, T } from './ui';

export function AgentControls({ agentId }: { agentId: string }) {
  const styles = useStyles();
  const colors = useColors();
  const router = useRouter();
  const agent = useApp((s) => s.overview?.agents.find((a) => a.id === agentId));
  const engines = useApp((s) => s.overview?.engines);
  const team = useApp((s) => s.overview?.independence ?? null);
  const live = useApp((s) => s.link.kind === 'connected');
  const welcome = useApp((s) => s.welcome);
  const switches = useServed('agents.update', MAC_FEATURES.engine);
  const efforts = useServed('agents.update', MAC_FEATURES.effort);
  const levels = useServed('agents.setAgentIndependence');
  const mode = useUsageMode(canCall('agents.usagePlan', welcome) && live);
  const [error, setError] = useState<string | null>(null);
  if (!agent) return null;

  const locked = controlsLocked(agent);
  const off = !live || !!locked;
  const label = chipLabel(agent, engines);

  const save = (input: { engine?: AgentEngine; model?: string; effort?: AgentEffort | '' }) => {
    haptic.select();
    setError(null);
    setAgentEngine(agent.id, input).then(
      () => haptic.success(),
      (e: unknown) => {
        haptic.error();
        setError(describeError(e));
      }
    );
  };

  const models = switches && engines ? currentModels(agent, engines) : [];
  const moves = switches && engines ? otherEngines(agent, engines) : [];
  const effort = agent.effort ?? '';

  return (
    <ScrollView contentContainerStyle={styles.page}>
      <SheetTitle>Agent controls</SheetTitle>
      <T variant="small" color={colors.textSecondary} style={styles.lead}>
        {`${agent.name} · ${label.main}${label.effort ? ` · ${label.effort}` : ''}. Changes apply from its next message.`}
      </T>
      {(locked || error) && (
        <View style={styles.note}>
          <Icon
            name={error ? 'exclamationmark.circle' : 'clock'}
            size={iconSize.inline}
            color={error ? colors.accentErrorLight : colors.textMuted}
          />
          <T
            variant="small"
            color={error ? colors.accentErrorLight : colors.textSecondary}
            style={{ flex: 1 }}
          >
            {error ?? locked}
          </T>
        </View>
      )}

      {models.length > 0 && (
        <Section title="Model">
          {models.map((m, i) => (
            <Choice
              key={m.value || 'default'}
              // The model by its name ("Opus"), as the chip says it; what it's for under it.
              label={m.detail ?? m.label}
              detail={
                m.detail
                  ? m.label
                  : m.value
                    ? undefined
                    : `Whatever ${engineName(agent)} picks${m.current && label.main !== engineName(agent) ? `: ${label.main} now` : ''}`
              }
              on={m.current}
              disabled={off}
              onPress={() => save({ model: m.value })}
              last={i === models.length - 1 && moves.length === 0}
            />
          ))}
          {moves.map((e, i) => (
            <Row
              key={e.id}
              label={`Switch to ${e.label}…`}
              detail={`${agent.name} keeps the conversation so far.`}
              disabled={off}
              last={i === moves.length - 1}
              onPress={() =>
                engines &&
                choose(
                  `${e.label}: which model?`,
                  modelOptions(e.id, engines).map((m) => ({
                    label: modelRowLabel(m),
                    run: () => save({ engine: e.id, model: m.value }),
                  })),
                  `${agent.name} keeps the conversation so far.`
                )
              }
            />
          ))}
        </Section>
      )}

      {efforts && (
        <Section title="Effort" footer="How hard it thinks before it answers. Its routines keep the engine’s default.">
          {effortRows().map((e, i, all) => (
            <Choice
              key={e.value || 'default'}
              label={e.label}
              detail={e.detail ?? `Whatever ${engineName(agent)} picks`}
              on={e.value === effort}
              disabled={off}
              onPress={() => save({ effort: e.value })}
              last={i === all.length - 1}
            />
          ))}
        </Section>
      )}

      {levels && team && (
        <LevelChoices agent={agent} team={team} disabled={!live} onError={setError} />
      )}

      <Section>
        <Row
          label="Usage"
          detail={
            mode
              ? `${USAGE_MODE_LABEL[mode]}, for the whole team. Change it on the Mac or ask your Chief of Staff.`
              : undefined
          }
          onPress={() => router.push({ pathname: '/usage', params: { id: agent.id } })}
        />
        <Row
          label={`More about ${agent.name}`}
          onPress={() => router.push({ pathname: '/agent/[id]', params: { id: agent.id } })}
          last
        />
      </Section>
    </ScrollView>
  );
}

/** One choice in a list: a tick on the one in use, tapping another picks it. */
function Choice({
  label,
  detail,
  on,
  disabled,
  onPress,
  last,
}: {
  label: string;
  detail?: string;
  on: boolean;
  disabled: boolean;
  onPress: () => void;
  last?: boolean;
}) {
  const accent = useAccent();
  const styles = useStyles();
  return (
    <Row
      label={label}
      detail={detail}
      selected={on}
      disabled={disabled && !on}
      onPress={on || disabled ? undefined : onPress}
      trailing={
        on ? (
          <Icon name="checkmark" size={iconSize.body} color={accent.accent} />
        ) : (
          <View style={styles.check} />
        )
      }
      last={last}
    />
  );
}

/** Rank, lowest first, as `INDEPENDENCE_LEVELS` orders them. */
const rank = (l: AgentIndependence) => INDEPENDENCE_LEVELS.indexOf(l);

/**
 * "Same as team (Go hard)" and the four levels. Going past the team's level
 * asks first, saying what it then does without asking and what still asks.
 */
function LevelChoices({
  agent,
  team,
  disabled,
  onError,
}: {
  agent: Agent;
  team: AgentIndependence;
  disabled: boolean;
  onError: (text: string | null) => void;
}) {
  const own = agent.independence ?? null;
  const effective = effectiveIndependence(agent, team);
  const apply = (level: AgentIndependence | 'team') => {
    haptic.select();
    onError(null);
    call('agents.setAgentIndependence', { agentId: agent.id, level }).catch((e: unknown) => {
      haptic.error();
      onError(describeError(e));
    });
  };
  const pick = (level: AgentIndependence | 'team') => {
    if ((level === 'team' && !own) || level === own) return;
    if (level !== 'team' && rank(level) > rank(team) && rank(level) > rank(effective)) {
      Alert.alert(
        `Let ${agent.name} do more than the team?`,
        `${INDEPENDENCE_DETAIL[level]} ${INDEPENDENCE_STILL_ASKS[level]}`,
        [
          { text: 'Cancel', style: 'cancel' },
          { text: INDEPENDENCE_LABEL[level], onPress: () => apply(level) },
        ]
      );
      return;
    }
    apply(level);
  };
  const rows: { level: AgentIndependence | 'team'; label: string }[] = [
    { level: 'team', label: sameAsTeamLabel(team) },
    ...INDEPENDENCE_LEVELS.map((l) => ({ level: l, label: INDEPENDENCE_LABEL[l] })),
  ];
  return (
    <Section
      title={AGENT_INDEPENDENCE_TITLE}
      footer={`${INDEPENDENCE_DETAIL[effective]} From its next step, even mid-turn.`}
    >
      {rows.map((r, i) => (
        <Choice
          key={r.level}
          label={r.label}
          on={r.level === 'team' ? !own : r.level === own}
          disabled={disabled}
          onPress={() => pick(r.level)}
          last={i === rows.length - 1}
        />
      ))}
    </Section>
  );
}

/** The team's usage mode, read once while the sheet is open; null until read. */
function useUsageMode(serves: boolean): UsageMode | null {
  const [mode, setMode] = useState<UsageMode | null>(null);
  const read = useCallback(async () => {
    try {
      setMode((await call('agents.usagePlan', {})).mode);
    } catch {
      // Unanswered: no line rather than a guess.
    }
  }, []);
  useEffect(() => {
    if (serves) void read();
  }, [serves, read]);
  return mode;
}

const useStyles = makeStyles(() => ({
  page: { padding: space.lg, gap: space.xs },
  lead: { marginBottom: space.sm },
  note: { flexDirection: 'row', alignItems: 'center', gap: space.sm, marginBottom: space.sm },
  check: { width: iconSize.body },
}));
