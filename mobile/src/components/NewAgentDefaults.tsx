/**
 * Settings → New agents: the engine and, per installed engine, the model new
 * agents start on. Read from the overview (`defaults`), written with
 * `agents.setDefaults`, which the Mac checks and audits like the desk's own
 * Settings. On a Mac that doesn't serve it, the choice is shown, not offered.
 */

import type { AgentEngine, NewAgentDefaultsChange } from '@shipstudio/companion-protocol';
import { useState } from 'react';
import { Alert, View, StyleSheet } from 'react-native';
import { Icon, Row, Section, tap } from './ui';
import { useAccent } from '../lib/accent';
import { haptic } from '../lib/haptics';
import {
  chosenModel,
  engineChoices,
  modelChange,
  modelOptions,
  startsOnLine,
} from '../lib/newAgentDefaults';
import { call, describeError } from '../lib/session';
import { useApp, useServed } from '../lib/store';
import { iconSize } from '../lib/theme';

export function NewAgentDefaults() {
  const accent = useAccent();
  const defaults = useApp((s) => s.overview?.defaults ?? null);
  const engines = useApp((s) => s.overview?.engines);
  const canSet = useServed('agents.setDefaults');
  const [busy, setBusy] = useState(false);
  if (!defaults || !engines?.length) return null;

  const change = async (next: NewAgentDefaultsChange) => {
    if (busy) return;
    tap();
    setBusy(true);
    try {
      // The overview follows as an event; nothing to merge here.
      await call('agents.setDefaults', next);
    } catch (e) {
      haptic.error();
      Alert.alert('Couldn’t change it', describeError(e));
    } finally {
      setBusy(false);
    }
  };

  const check = (on: boolean) =>
    on ? (
      <Icon name="checkmark" size={iconSize.body} color={accent.accent} />
    ) : (
      <View style={styles.check} />
    );
  const choices = engineChoices(engines);
  const installed = engines.filter((e) => e.installed).map((e) => e.id as AgentEngine);

  return (
    <>
      <Section title="New agents start on" footer={startsOnLine(defaults)}>
        {choices.map((e, i) => {
          const on = e.id === defaults.startsOn;
          return (
            <Row
              key={e.id}
              label={e.label}
              detail={e.why ?? undefined}
              selected={on}
              disabled={!e.ready}
              onPress={canSet && !on && e.ready ? () => void change({ engine: e.id }) : undefined}
              trailing={check(on)}
              last={i === choices.length - 1}
            />
          );
        })}
      </Section>
      {installed.map((engine) => {
        const options = modelOptions(engine, engines);
        const value = chosenModel(defaults, engine);
        const name = choices.find((c) => c.id === engine)?.label ?? engine;
        return (
          <Section
            key={engine}
            title={`Model on ${name}`}
            footer={
              options.length < 2
                ? `${name} hasn’t listed its models, so new agents use its default.`
                : undefined
            }
          >
            {options.map((m, i) => {
              const on = m.value === value;
              return (
                <Row
                  key={m.value || 'default'}
                  label={m.label}
                  value={m.detail}
                  selected={on}
                  onPress={
                    canSet && !on ? () => void change(modelChange(engine, m.value)) : undefined
                  }
                  trailing={check(on)}
                  last={i === options.length - 1}
                />
              );
            })}
          </Section>
        );
      })}
    </>
  );
}

const styles = StyleSheet.create({
  check: { width: iconSize.body },
});
