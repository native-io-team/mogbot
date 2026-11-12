import { ModalFrame } from './primitives/ModalFrame';
import { Button } from './primitives/Button';
import { useAsyncState } from '../hooks/useAsyncState';
import { getRemoteAccessBrief } from '../lib/remoteAccess';
import { quitPrompt, type QuitCheck } from '../lib/agentsDesktop';
import { THIS_COMPUTER } from '../lib/computer';

interface QuitConfirmModalProps {
  onCancel: () => void;
  onQuit: () => void;
  /** What a quit would interrupt; null while unknown (the plain question shows). */
  check?: QuitCheck | null;
  /** macOS: windows can hide while the app keeps running. */
  backgroundAvailable?: boolean;
  onKeepRunning?: () => void;
}

/**
 * ⌘Q (and the menu bar's Quit) confirmation. Rendered by every top-level view
 * branch in App.tsx, so it lives at the component root alongside the other
 * app-global chrome.
 *
 * With agents working, or a check-in due soon, it becomes the quit guard
 * (an open approval alone doesn't: it waits for you): it names who would be stopped, and the safe choice is the default. Laid
 * out as a macOS alert with three choices is: stacked, default first, Cancel
 * last.
 */
export function QuitConfirmModal({
  onCancel,
  onQuit,
  check = null,
  backgroundAvailable = false,
  onKeepRunning,
}: QuitConfirmModalProps) {
  // Someone may be relying on this Mac from their phone. Quitting is the
  // one thing that silently cuts them off, so say so here, where it's decided.
  const remote = useAsyncState(getRemoteAccessBrief, { immediate: true });
  const remoteOn = remote.data?.enabled === true;
  const prompt = quitPrompt(check, {
    backgroundAvailable: backgroundAvailable && onKeepRunning !== undefined,
  });
  const remoteLine = remoteOn && (
    <p className="quit-confirm-remote">
      Remote access is on. Quitting stops your assistant reaching {THIS_COMPUTER} until the app is
      open again.
    </p>
  );

  if (prompt) {
    return (
      <ModalFrame
        isOpen
        onClose={onCancel}
        ariaLabel={prompt.title}
        showCloseButton={false}
        className="quit-confirm-modal quit-confirm-modal--guard"
      >
        <p className="quit-confirm-title">{prompt.title}</p>
        <p className="quit-confirm-body">{prompt.body}</p>
        {remoteLine}
        <div className="quit-confirm-actions quit-confirm-actions--stacked">
          {prompt.offerBackground && (
            <Button variant="strong" data-allow width="fill" onClick={onKeepRunning} autoFocus>
              Keep running in background
            </Button>
          )}
          <Button width="fill" onClick={onQuit}>
            Quit
          </Button>
          <Button
            variant="secondary"
            width="fill"
            onClick={onCancel}
            autoFocus={!prompt.offerBackground}
          >
            Cancel
          </Button>
        </div>
      </ModalFrame>
    );
  }

  // Nothing is running: a standard dialog, title in the header and the
  // actions right-aligned with the dismissal first.
  return (
    <ModalFrame
      isOpen
      onClose={onCancel}
      title="Quit now?"
      showCloseButton={false}
      className="quit-confirm-plain"
    >
      <div
        className="quit-confirm-plain__body"
        onKeyDown={(e) => {
          if (e.key === 'Enter') onQuit();
        }}
      >
        <div className="confirm-modal-text">
          <p className="text-style-hint">
            Agents and scheduled routines don&rsquo;t run while the app is closed.
          </p>
          {remoteLine}
        </div>
        <div className="modal-actions">
          <Button variant="secondary" onClick={onCancel}>
            Cancel
          </Button>
          {/* Nothing is running, so Return still quits (the ⌘Q-then-Return habit),
              but a neutral button: quitting isn't the thing this app wants you to do. */}
          <Button onClick={onQuit} autoFocus>
            Quit
          </Button>
        </div>
      </div>
    </ModalFrame>
  );
}
