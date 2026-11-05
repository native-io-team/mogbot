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
import { GlobeIcon, MoreHorizontalIcon, PullRequestIcon } from '@/components/icons';
import { Button } from '../primitives/Button';
import { TextButton } from '../primitives/TextButton';
import { Tooltip } from '../primitives/Tooltip';
import { Spinner } from '../primitives/Spinner';
import { Dropdown, DropdownItem } from '../primitives/Dropdown';
import { MenuButton } from '../primitives/MenuButton';
import { useOptionalToast } from '../../contexts/ToastContext';
import { asCommandError, formatCommandError } from '../../lib/errors';
import { queueSubmitReview } from '../../lib/reviewHandoff';
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

/** What Keep adds where, for its tooltip. Exported for tests. */
export function keepHint(agentName: string, project: string, branch: string | undefined): string {
  return branch
    ? `Brings these changes into ${project}: adds ${agentName}'s commits to ${branch}`
    : `Brings these changes into ${project}: adds ${agentName}'s commits to its current branch`;
}

/** The toast for a Keep that went through. Exported for tests. */
export function keptToast(project: string, kept: KeptCopy): string {
  const more = 'leftOut' in kept ? leftOutLine(kept.leftOut) : null;
  const line =
    kept.outcome === 'kept'
      ? `Kept the changes in ${project} (${kept.branch})`
      : `${project} already has these changes`;
  return more ? `${line} · ${more}` : line;
}

/** Why Keep is asking before it keeps into another branch. Exported for tests. */
export function otherBranchNote(project: string, current: string, base?: string): string {
  return base
    ? `${project} is on ${current} now, but these changes were made from ${base}. Keeping them in ${current} also brings along whatever ${base} has that ${current} doesn't.`
    : `${project} is on ${current} now, but these changes weren't made from a branch. Keeping them in ${current} brings them, and the version they started from, into ${current}.`;
}

export function CopyActions({
  agent,
  copy,
  project,
  onReview,
  onPreview,
}: {
  agent: Agent;
  copy: CopyRef;
  /** The project's name, as the card shows it. */
  project: string;
  onReview?: () => void;
  /** Opens the copy in the workspace; absent outside Agents mode. */
  onPreview?: (path: string) => void;
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
  const fail = (e: unknown) => showToast(formatCommandError(asCommandError(e)), 'error');
  const baseBranch = agent.copy?.id === copy.id ? agent.copy.baseBranch : undefined;

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

  const waitHint = working ? `${agent.name} is still working on it` : undefined;

  if (otherBranch) {
    return (
      <div className="agent-copy" data-state="other-branch">
        <p className="agent-copy__note">
          {otherBranchNote(project, otherBranch.current, otherBranch.base)}
        </p>
        <div className="agent-changes__actions">
          <Button
            size="compact"
            variant="primary"
            onClick={() => void keep(otherBranch.current)}
            disabled={busy !== null || working}
            leftIcon={busy === 'keep' ? <Spinner size="sm" /> : undefined}
          >
            Keep into {otherBranch.current}
          </Button>
          <TextButton
            tabIndex={0}
            onClick={() => {
              setOtherBranch(null);
              setDismissed(true);
            }}
          >
            Cancel
          </TextButton>
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
        <div className="agent-changes__actions">
          {onPreview && (
            <Button size="compact" variant="primary" onClick={() => onPreview(copy.path)}>
              Open the copy
            </Button>
          )}
          <TextButton
            tabIndex={0}
            onClick={() =>
              void sendAgentMessage(agent.id, resolvePrompt(project, markers)).then(() => {
                setMarkers(null);
                setDismissed(true);
              }, fail)
            }
            disabled={working}
          >
            Ask {agent.name}
          </TextButton>
          <TextButton
            tabIndex={0}
            onClick={() => {
              setMarkers(null);
              setDismissed(true);
            }}
          >
            Not now
          </TextButton>
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
        <div className="agent-changes__actions">
          {onPreview && (
            <Button size="compact" variant="primary" onClick={() => onPreview(copy.path)}>
              Open the copy
            </Button>
          )}
          <TextButton tabIndex={0} onClick={askToResolve} disabled={working}>
            Ask {agent.name}
          </TextButton>
          <TextButton
            tabIndex={0}
            onClick={() => {
              setConflict(null);
              setDismissed(true);
            }}
          >
            Not now
          </TextButton>
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
        <div className="agent-changes__actions">
          <Button
            size="compact"
            variant="danger"
            onClick={() => void discard()}
            disabled={busy !== null || working}
            leftIcon={busy === 'discard' ? <Spinner size="sm" /> : undefined}
          >
            Discard
          </Button>
          <TextButton tabIndex={0} onClick={() => setConfirming(false)}>
            Cancel
          </TextButton>
        </div>
      </div>
    );
  }

  return (
    <div className="agent-changes__actions agent-copy__actions">
      <Tooltip content={waitHint ?? keepHint(agent.name, project, baseBranch)}>
        <Button
          size="compact"
          variant="primary"
          onClick={() => void keep()}
          disabled={busy !== null || working}
          leftIcon={busy === 'keep' ? <Spinner size="sm" /> : undefined}
        >
          Keep changes
        </Button>
      </Tooltip>
      {onReview && (
        <TextButton tabIndex={0} onClick={onReview}>
          Review
        </TextButton>
      )}
      {onPreview && (
        <TextButton
          tabIndex={0}
          leftIcon={<GlobeIcon size={12} />}
          onClick={() => onPreview(copy.path)}
        >
          Preview
        </TextButton>
      )}
      <Tooltip content={waitHint ?? 'Throw these changes away'}>
        <TextButton
          tabIndex={0}
          onClick={() => setConfirming(true)}
          disabled={busy !== null || working}
        >
          Discard
        </TextButton>
      </Tooltip>
      {onPreview && (
        <Dropdown
          align="right"
          trigger={(p) => (
            <MenuButton
              {...p}
              tabIndex={0}
              variant="ghost"
              size="compact"
              className="agent-copy__more"
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
            disabled={working}
          >
            Open a pull request
          </DropdownItem>
        </Dropdown>
      )}
    </div>
  );
}
