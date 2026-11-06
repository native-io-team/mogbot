/**
 * What a change card offers when the agent worked in its own copy of the
 * project (`agents/task.rs`): Keep changes, Review, Preview, Discard, and
 * Open a pull request. Git is underneath and stays there: the words are
 * "a copy of the project", "Keep", "Discard".
 *
 * Only the newest card of the agent's open copy is live; Keep and Discard
 * name that copy, so a stale card can never act on a newer one.
 *
 * @module components/agents/AgentCopy
 */

import { useState } from 'react';
import { GlobeIcon, MoreHorizontalIcon, PullRequestIcon, TrashIcon } from '@/components/icons';
import { Button } from '../primitives/Button';
import { TextButton } from '../primitives/TextButton';
import { Tooltip } from '../primitives/Tooltip';
import { Spinner } from '../primitives/Spinner';
import { Dropdown, DropdownItem } from '../primitives/Dropdown';
import { MenuButton } from '../primitives/MenuButton';
import { useOptionalToast } from '../../contexts/ToastContext';
import { asCommandError, formatCommandError } from '../../lib/errors';
import { queueSubmitReview } from '../../lib/reviewHandoff';
import { isFocusClick } from '../../lib/firstClick';
import {
  discardCopy,
  keepCopy,
  leftOutLine,
  sendAgentMessage,
  type Agent,
  type CopyRef,
  type KeptCopy,
} from '../../lib/agents';

/** The words the card's sub-line uses, by state. Exported for tests. */
export function copyLine(agentName: string, project: string, working: boolean): string {
  return working
    ? `${agentName} is working on a copy of ${project}`
    : `On a copy of ${project} · ${project} itself is unchanged`;
}

/** What to ask the agent when its changes overlap with the project's. */
export function resolvePrompt(project: string, files: string[]): string {
  const list = files.slice(0, 5).join(', ');
  return `Some of your changes overlap with edits made in ${project} since you started (${list}). Resolve the conflicts in your copy, keeping what both sides meant, and leave no conflict markers (<<<<<<<, =======, >>>>>>>) in any file. You don't need to commit: it's saved for you when you finish. Then tell me it's ready.`;
}

/** What Keep does, for its tooltip, in the card's words. Exported for tests. */
export function keepHint(agentName: string, project: string): string {
  return `Brings ${agentName}’s changes into ${project}`;
}

/** The toast for a Keep that went through. Exported for tests. */
export function keptToast(project: string, kept: KeptCopy): string {
  const more = 'leftOut' in kept ? leftOutLine(kept.leftOut) : null;
  const line =
    kept.outcome === 'kept'
      ? `Kept the changes in ${project}`
      : `${project} already has these changes`;
  return more ? `${line} · ${more}` : line;
}

/**
 * Why Keep is asking before it keeps into the version the project is on now,
 * when that isn't the one the changes started from. No version names: the
 * card promised none. Exported for tests.
 */
export function otherBranchNote(project: string, base?: string): string {
  return base
    ? `${project} has moved on to another version since these changes were started. Keeping them there also brings along anything from the version they started from that it doesn’t have yet.`
    : `${project} has moved on to another version since these changes were started. Keeping them there brings them, and the version they started from, along.`;
}

export function CopyActions({
  agent,
  copy,
  project,
  onReview,
  onPreview,
  onAskForChanges,
}: {
  agent: Agent;
  copy: CopyRef;
  /** The project's name, as the card shows it. */
  project: string;
  onReview?: () => void;
  /** Opens the copy in the workspace; absent outside Agents mode. */
  onPreview?: (path: string) => void;
  /** The card is a result card: open the composer on it. */
  onAskForChanges?: () => void;
}) {
  const { showToast } = useOptionalToast();
  const [busy, setBusy] = useState<'keep' | 'discard' | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [answered, setConflict] = useState<string[] | null>(null);
  const [answeredMarkers, setMarkers] = useState<string[] | null>(null);
  const [answeredBranch, setOtherBranch] = useState<{ current: string; base?: string } | null>(
    null
  );
  // What stopped the last Keep is kept on the agent's copy (the Mac's
  // registry), so it's still here after a reload or a remount; "Not now" /
  // "Cancel" put it away for this view.
  const [dismissed, setDismissed] = useState(false);
  const stuck =
    !dismissed && agent.copy?.id === copy.id && agent.status.state === 'idle'
      ? agent.copy.stuck
      : undefined;
  const conflict = answered ?? (stuck?.outcome === 'conflict' ? stuck.files : null);
  const markers = answeredMarkers ?? (stuck?.outcome === 'markers' ? stuck.files : null);
  const otherBranch =
    answeredBranch ??
    (stuck?.outcome === 'otherBranch' ? { current: stuck.current, base: stuck.base } : null);
  const working = agent.status.state !== 'idle';
  // You're driving it by hand: the copy may be mid-edit in the terminal, and
  // the backend refuses Keep and Discard until it's handed back.
  const driven = Boolean(agent.takeover);
  const held = working || driven;
  const fail = (e: unknown) => showToast(formatCommandError(asCommandError(e)), 'error');

  const keep = async (into?: string) => {
    setBusy('keep');
    setDismissed(false);
    try {
      const result = await keepCopy(agent.id, copy.id, into);
      setOtherBranch(null);
      if (result.outcome === 'conflict') setConflict(result.files);
      else if (result.outcome === 'markers') setMarkers(result.files);
      else if (result.outcome === 'otherBranch')
        setOtherBranch({ current: result.current, base: result.base });
      else showToast(keptToast(project, result), result.outcome === 'kept' ? 'success' : 'info');
    } catch (e) {
      fail(e);
    } finally {
      setBusy(null);
    }
  };

  const discard = async () => {
    setBusy('discard');
    try {
      await discardCopy(agent.id, copy.id);
    } catch (e) {
      fail(e);
    } finally {
      setBusy(null);
      setConfirming(false);
    }
  };

  const askToResolve = () => {
    if (!conflict) return;
    sendAgentMessage(agent.id, resolvePrompt(project, conflict)).then(() => {
      setConflict(null);
      setDismissed(true);
    }, fail);
  };

  const openPullRequest = () => {
    if (!onPreview) return;
    queueSubmitReview(copy.path, copy.branch);
    onPreview(copy.path);
  };

  const waitHint = driven
    ? `You’re driving ${agent.name}: hand it back first`
    : working
      ? `${agent.name} is still working on it`
      : undefined;

  if (otherBranch) {
    return (
      <div className="agent-copy" data-state="other-branch">
        <p className="agent-copy__note">{otherBranchNote(project, otherBranch.base)}</p>
        <div className="agent-card__actions">
          <Button
            variant="secondary"
            onClick={() => {
              setOtherBranch(null);
              setDismissed(true);
            }}
          >
            Cancel
          </Button>
          <Tooltip content={waitHint ?? keepHint(agent.name, project)}>
            <Button
              variant="strong"
              onClick={() => void keep(otherBranch.current)}
              disabled={busy !== null || held}
              leftIcon={busy === 'keep' ? <Spinner size="sm" /> : undefined}
            >
              Keep there too
            </Button>
          </Tooltip>
        </div>
      </div>
    );
  }

  if (markers) {
    return (
      <div className="agent-copy" data-state="markers">
        <p className="agent-copy__note">
          Some files still have conflict markers in them:{' '}
          <span className="agent-copy__files">{markers.slice(0, 5).join(', ')}</span>. Nothing was
          kept. Finish choosing in the copy, or ask {agent.name} to.
        </p>
        <div className="agent-card__actions">
          <TextButton
            tabIndex={0}
            onClick={() => {
              setMarkers(null);
              setDismissed(true);
            }}
          >
            Not now
          </TextButton>
          <Button
            variant="secondary"
            onClick={() =>
              void sendAgentMessage(agent.id, resolvePrompt(project, markers)).then(() => {
                setMarkers(null);
                setDismissed(true);
              }, fail)
            }
            disabled={held}
          >
            Ask {agent.name}
          </Button>
          {onPreview && (
            <Button variant="strong" onClick={() => onPreview(copy.path)}>
              Open the copy
            </Button>
          )}
        </div>
      </div>
    );
  }

  if (conflict) {
    return (
      <div className="agent-copy" data-state="conflict">
        <p className="agent-copy__note">
          Some of these changes overlap with edits made in {project} since:{' '}
          <span className="agent-copy__files">{conflict.slice(0, 5).join(', ')}</span>. Choose which
          to keep in the copy, or ask {agent.name} to sort it out.
        </p>
        <div className="agent-card__actions">
          <TextButton
            tabIndex={0}
            onClick={() => {
              setConflict(null);
              setDismissed(true);
            }}
          >
            Not now
          </TextButton>
          <Button variant="secondary" onClick={askToResolve} disabled={held}>
            Ask {agent.name}
          </Button>
          {onPreview && (
            <Button variant="strong" onClick={() => onPreview(copy.path)}>
              Open the copy
            </Button>
          )}
        </div>
      </div>
    );
  }

  if (confirming) {
    return (
      <div className="agent-copy" data-state="confirm">
        <p className="agent-copy__note">
          Discard these changes? The copy and everything in it go; {project} stays as it is.
        </p>
        <div className="agent-card__actions">
          <Button variant="secondary" onClick={() => setConfirming(false)}>
            Cancel
          </Button>
          <Tooltip content={waitHint ?? 'Throw these changes away'}>
            <Button
              variant="danger"
              onClick={(event) => !isFocusClick(event) && void discard()}
              disabled={busy !== null || held}
              leftIcon={busy === 'discard' ? <Spinner size="sm" /> : <TrashIcon size={14} />}
            >
              Discard
            </Button>
          </Tooltip>
        </div>
      </div>
    );
  }

  // [⋯] Discard · Preview · Ask for changes · Review changes [Keep changes]: the single
  // affirmative last, neutral like Allow.
  return (
    <div className="agent-card__actions agent-copy__actions">
      {onPreview && (
        <Dropdown
          align="right"
          className="agent-copy__more"
          trigger={(p) => (
            <MenuButton
              {...p}
              tabIndex={0}
              variant="ghost"
              size="compact"
              expanded={p['aria-expanded']}
              aria-label="More"
            >
              <MoreHorizontalIcon size={14} />
            </MenuButton>
          )}
        >
          <DropdownItem
            icon={<PullRequestIcon size={14} />}
            onSelect={openPullRequest}
            disabled={held}
          >
            Open a pull request
          </DropdownItem>
        </Dropdown>
      )}
      <Tooltip content={waitHint ?? 'Throw these changes away'}>
        <TextButton
          tabIndex={0}
          onClick={() => setConfirming(true)}
          disabled={busy !== null || held}
        >
          Discard
        </TextButton>
      </Tooltip>
      {onPreview && (
        <TextButton
          tabIndex={0}
          leftIcon={<GlobeIcon size={12} />}
          onClick={() => onPreview(copy.path)}
        >
          Preview
        </TextButton>
      )}
      {onAskForChanges && (
        <TextButton tabIndex={0} onClick={onAskForChanges}>
          Ask for changes
        </TextButton>
      )}
      {/* The two answers wrap as one: split across lines, Keep changes sat
          alone under the text actions with Review changes among them. */}
      <span className="agent-copy__answers">
        {onReview && (
          <Button variant="secondary" onClick={onReview}>
            Review changes
          </Button>
        )}
        <Tooltip content={waitHint ?? keepHint(agent.name, project)}>
          <Button
            variant="strong"
            // Not the click that only brought the window forward (lib/firstClick).
            onClick={(event) => !isFocusClick(event) && void keep()}
            disabled={busy !== null || held}
            leftIcon={busy === 'keep' ? <Spinner size="sm" /> : undefined}
          >
            Keep changes
          </Button>
        </Tooltip>
      </span>
    </div>
  );
}
