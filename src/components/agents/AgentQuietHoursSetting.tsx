/**
 * Settings → Agents → Notifications, "Quiet hours": the team's window
 * (`agents::quiet`), the same one the Chief sets from chat with
 * `set_quiet_hours` and the phone sets from its Settings. Off, a switch;
 * on, the switch and the two times. They only hold things back, so the
 * user's change applies at once. Read again whenever chat or the phone
 * changes them.
 *
 * @module components/agents/AgentQuietHoursSetting
 */
import { useEffect, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { Row, Toggle } from './AgentSettingsRows';
import { TextField } from '../primitives/TextField';
import { useInvoke } from '../../hooks/useInvoke';
import { useOptionalToast } from '../../contexts/ToastContext';
import { takeSettingsSectionRequest } from '../../lib/settings';
import { asCommandError, formatCommandError } from '../../lib/errors';
import {
  QUIET_DETAIL,
  QUIET_EVENT,
  QUIET_TITLE,
  clockLabel,
  parseClock,
  setQuietHours,
  validQuietWindow,
  type QuietWindow,
} from '../../lib/settingsFromChat';

/** Where a first switch-on starts: a usual night. */
export const DEFAULT_QUIET: QuietWindow = { start: 22 * 60, end: 7 * 60 };

export function AgentQuietHoursSetting() {
  const { showToast } = useOptionalToast();
  const { data, execute } = useInvoke<QuietWindow | null>('agents_quiet_hours', {
    immediate: true,
  });
  // The window just chosen, shown at once until the Mac's answer replaces it.
  const [chosen, setChosen] = useState<QuietWindow | null | undefined>(undefined);
  useEffect(() => {
    let off: (() => void) | undefined;
    void listen(QUIET_EVENT, () => {
      setChosen(undefined);
      void execute().catch(() => {});
    })
      .then((u) => (off = u))
      .catch(() => {});
    return () => off?.();
  }, [execute]);

  const quiet = chosen !== undefined ? chosen : data;
  // Opened from ⌘K "Quiet hours…": scrolled to here.
  const ref = useRef<HTMLDivElement>(null);
  const loaded = quiet !== undefined;
  useEffect(() => {
    if (loaded && takeSettingsSectionRequest('agent-quiet')) {
      ref.current?.scrollIntoView?.({ block: 'center' });
    }
  }, [loaded]);
  if (quiet === undefined) return null;

  const save = (next: QuietWindow | null) => {
    const before = quiet;
    setChosen(next);
    setQuietHours(next).catch((e: unknown) => {
      setChosen(before);
      showToast(formatCommandError(asCommandError(e)), 'error');
    });
  };
  const time = (which: 'start' | 'end', value: string) => {
    if (!quiet) return;
    const minute = parseClock(value);
    if (minute === null) return;
    const next = { ...quiet, [which]: minute };
    // Same start and end is no quiet hours at all: wait for a real change.
    if (validQuietWindow(next)) save(next);
  };

  return (
    <Row label={QUIET_TITLE} description={QUIET_DETAIL}>
      <div className="agents-quiet" ref={ref}>
        {quiet && (
          <span className="agents-quiet__times">
            <TextField
              type="time"
              className="agents-quiet__time"
              aria-label="Quiet hours start"
              value={clockLabel(quiet.start)}
              onChange={(e) => time('start', e.target.value)}
            />
            <span className="agents-quiet__to">to</span>
            <TextField
              type="time"
              className="agents-quiet__time"
              aria-label="Quiet hours end"
              value={clockLabel(quiet.end)}
              onChange={(e) => time('end', e.target.value)}
            />
          </span>
        )}
        <Toggle
          on={!!quiet}
          label={QUIET_TITLE}
          onChange={(on) => save(on ? DEFAULT_QUIET : null)}
        />
      </div>
    </Row>
  );
}
