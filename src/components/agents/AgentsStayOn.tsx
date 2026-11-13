/**
 * What keeps agents running: this Mac, awake, with Ship Studio running. Said
 * once, quietly — at the foot of What's in flight once something is running
 * or scheduled (when it matters, not on a new user's first screen), and as a
 * link in the schedule popover's footnote — with what the app can do about
 * it: hold the Mac awake (the same assertion remote access uses), keep
 * running when windows close, and open at login (remote access's login item).
 *
 * "Keep running when closed" changes what closing a window does for every
 * project, so it is only ever turned on here, by asking.
 *
 * Shows nothing until the backend has answered; each switch only where it
 * works here (keep running when closed and open at login are macOS only).
 *
 * @module components/agents/AgentsStayOn
 */

import { ToggleButton } from '../primitives/ToggleButton';
import { TextButton } from '../primitives/TextButton';
import { CheckIcon } from '../icons';
import { useStayOn } from '../../hooks/useStayOn';
import { HOST_COMPUTER, THIS_COMPUTER } from '../../lib/computer';

/** The first-run note: where agents run, and the three things that help. */
export function AgentsStayOnNote() {
  const { state, change } = useStayOn();
  if (!state?.supported) return null;
  const tick = (on: boolean) => (on ? <CheckIcon size={14} /> : undefined);
  return (
    <div className="agents-stay-on">
      <p className="agents-stay-on__line">
        {state.keepRunning
          ? `Agents run on ${THIS_COMPUTER}. Closing the window keeps them going; quitting stops them, and sleep pauses them.`
          : `Agents run on ${THIS_COMPUTER}. Quitting the app stops them, and sleep pauses them.`}
      </p>
      <div className="agents-stay-on__actions">
        {state.keepAwakeAvailable !== false && (
          <ToggleButton
            variant="ghost"
            size="compact"
            pressed={state.keepAwake}
            leftIcon={tick(state.keepAwake)}
            onClick={() => void change({ keepAwake: !state.keepAwake })}
          >
            Keep {THIS_COMPUTER} awake
          </ToggleButton>
        )}
        {state.keepRunningAvailable !== false && (
          <ToggleButton
            variant="ghost"
            size="compact"
            pressed={state.keepRunning}
            leftIcon={tick(state.keepRunning)}
            title="Closing a window hides it and the app keeps running. Click its Dock icon to bring it back; ⌘Q quits."
            onClick={() => void change({ keepRunning: !state.keepRunning })}
          >
            Keep running when closed
          </ToggleButton>
        )}
        {state.openAtLoginAvailable && (
          <ToggleButton
            variant="ghost"
            size="compact"
            pressed={state.openAtLogin}
            leftIcon={tick(state.openAtLogin)}
            title="Reopens the app after a restart, once you've logged in."
            onClick={() => void change({ openAtLogin: !state.openAtLogin })}
          >
            Open at login
          </ToggleButton>
        )}
      </div>
      <p className="agents-stay-on__line agents-stay-on__line--quiet">
        {HOST_COMPUTER === 'mac'
          ? 'Around the clock? Run it on a Mac that never sleeps, like a Mac mini or a cloud Mac.'
          : 'Around the clock? Run it on a computer that never sleeps, like a desktop that stays on or a cloud machine.'}
      </p>
    </div>
  );
}

/** The schedule footnote's trailing link; nothing once the Mac is held awake. */
export function KeepAwakeLink() {
  const { state, change } = useStayOn();
  if (!state?.supported || state.keepAwakeAvailable === false || state.keepAwake) return null;
  return (
    <>
      {' '}
      <TextButton tabIndex={0} onClick={() => void change({ keepAwake: true })}>
        Keep {THIS_COMPUTER} awake
      </TextButton>
    </>
  );
}
