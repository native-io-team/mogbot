/**
 * Settings → Notifications, "Morning brief" (`agents::brief`): on
 * or off and its time, whether it posts on quiet days, and the user's own
 * read-only checks (added from chat with the Chief's `set_morning_brief`,
 * removed here). The same settings the phone and the chat change; read
 * again whenever they do.
 *
 * @module components/agents/AgentMorningBriefSetting
 */
import { useEffect, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { Row, Toggle } from './AgentSettingsRows';
import { TextField } from '../primitives/TextField';
import { TextButton } from '../primitives/TextButton';
import { useInvoke } from '../../hooks/useInvoke';
import { useOptionalToast } from '../../contexts/ToastContext';
import { takeSettingsSectionRequest } from '../../lib/settings';
import { asCommandError, formatCommandError } from '../../lib/errors';
import {
  BRIEF_ALWAYS,
  BRIEF_DETAIL,
  BRIEF_EVENT,
  BRIEF_TITLE,
  clockLabel,
  parseClock,
  setMorningBrief,
  type BriefCheck,
  type MorningBrief,
} from '../../lib/settingsFromChat';

export function AgentMorningBriefSetting() {
  const { showToast } = useOptionalToast();
  const { data, execute } = useInvoke<MorningBrief>('agents_morning_brief', { immediate: true });
  // What was just chosen, shown at once until the Mac's answer replaces it.
  const [chosen, setChosen] = useState<MorningBrief | undefined>(undefined);
  useEffect(() => {
    let off: (() => void) | undefined;
    void listen(BRIEF_EVENT, () => {
      setChosen(undefined);
      void execute().catch(() => {});
    })
      .then((u) => (off = u))
      .catch(() => {});
    return () => off?.();
  }, [execute]);

  const brief = chosen ?? data;
  // Opened from ⌘K "Morning brief…": scrolled to here.
  const ref = useRef<HTMLDivElement>(null);
  const loaded = !!brief;
  useEffect(() => {
    if (loaded && takeSettingsSectionRequest('agent-brief')) {
      ref.current?.scrollIntoView?.({ block: 'center' });
    }
  }, [loaded]);
  if (!brief) return null;

  const save = (next: MorningBrief, checks?: BriefCheck[]) => {
    const before = brief;
    setChosen({ ...next, checks: checks ?? next.checks });
    setMorningBrief(next, checks)
      .then((saved) => setChosen(saved))
      .catch((e: unknown) => {
        setChosen(before);
        showToast(formatCommandError(asCommandError(e)), 'error');
      });
  };
  const time = (value: string) => {
    const at = parseClock(value);
    if (at !== null && at !== brief.at) save({ ...brief, at });
  };
  const checks = brief.checks ?? [];

  return (
    <>
      <Row label={BRIEF_TITLE} description={BRIEF_DETAIL}>
        <div className="agents-brief" ref={ref}>
          {brief.on && (
            <TextField
              type="time"
              className="agents-brief__time"
              aria-label="Morning brief time"
              value={clockLabel(brief.at)}
              onChange={(e) => time(e.target.value)}
            />
          )}
          <Toggle on={brief.on} label={BRIEF_TITLE} onChange={(on) => save({ ...brief, on })} />
        </div>
      </Row>
      {brief.on && (
        <Row label={BRIEF_ALWAYS} description="Off, a day with nothing for you posts nothing.">
          <Toggle
            on={brief.always}
            label={BRIEF_ALWAYS}
            onChange={(always) => save({ ...brief, always })}
          />
        </Row>
      )}
      {brief.on &&
        checks.map((c, i) => (
          <Row
            key={`${c.app}:${c.what}`}
            label={`Check: ${c.what}`}
            // How to add one is said once, under the last.
            description={`Read only, in ${c.app}, shortly before the brief.${i === checks.length - 1 ? ' Add more by asking your Chief of Staff.' : ''}`}
          >
            <TextButton
              onClick={() =>
                save(
                  brief,
                  checks.filter((_, j) => j !== i)
                )
              }
            >
              Remove
            </TextButton>
          </Row>
        ))}
    </>
  );
}
