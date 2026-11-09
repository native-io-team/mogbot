/**
 * Settings → Agents → On this Mac, "Slow down on battery": on battery the
 * app's background checks (usage, disk, Slack, the phone's projects) wait
 * longer (`power.rs`). On by default; a turn, a routine or an approval is
 * never slowed. The Chief changes it too (`change_app_setting`), so it reads
 * again on that event.
 *
 * @module components/agents/AgentLowPowerSetting
 */
import { useEffect, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { Row, Toggle } from './AgentSettingsRows';
import { useInvoke } from '../../hooks/useInvoke';
import { useOptionalToast } from '../../contexts/ToastContext';
import { asCommandError, formatCommandError } from '../../lib/errors';
import { takeSettingsSectionRequest } from '../../lib/settings';
import { APP_SETTINGS_EVENT, setLowPower } from '../../lib/settingsFromChat';

export const LOW_POWER_LABEL = 'Slow down on battery';

export function AgentLowPowerSetting() {
  const { showToast } = useOptionalToast();
  const { data, execute } = useInvoke<boolean>('get_low_power_on_battery', { immediate: true });
  const [chosen, setChosen] = useState<boolean | null>(null);
  useEffect(() => {
    let off: (() => void) | undefined;
    void listen(APP_SETTINGS_EVENT, () => {
      setChosen(null);
      void execute().catch(() => {});
    })
      .then((u) => (off = u))
      .catch(() => {});
    return () => off?.();
  }, [execute]);
  const on = chosen ?? data;
  // Opened from ⌘K "Slow down on battery…": scrolled to here.
  const ref = useRef<HTMLSpanElement>(null);
  const loaded = on !== null && on !== undefined;
  useEffect(() => {
    if (loaded && takeSettingsSectionRequest('agent-low-power')) {
      ref.current?.scrollIntoView?.({ block: 'center' });
    }
  }, [loaded]);
  if (on === null || on === undefined) return null;
  const change = (next: boolean) => {
    setChosen(next);
    setLowPower(next).catch((e: unknown) => {
      setChosen(!next);
      showToast(formatCommandError(asCommandError(e)), 'error');
    });
  };
  return (
    <Row
      label={LOW_POWER_LABEL}
      description="On battery, background checks wait longer. Agents’ work never does."
    >
      <span ref={ref}>
        <Toggle on={on} label={LOW_POWER_LABEL} onChange={change} />
      </span>
    </Row>
  );
}
