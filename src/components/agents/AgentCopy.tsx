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
  sendAgentMessage,
  type Agent,
  type CopyRef,
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
  return `Some of your changes overlap with edits made in ${project} since you started (${list}). Resolve the conflicts in your copy, keeping what both sides meant, and commit the result. Then tell me it's ready.`;
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
  const [conflict, setConflict] = useState<string[] | null>(null);
  const working = agent.status.state !== 'idle';
  const fail = (e: unknown) => showToast(formatCommandError(asCommandError(e)), 'error');

  const keep = async () => {
    setBusy('keep');
    try {
      const result = await keepCopy(agent.id, copy.id);
      if (result.outcome === 'conflict') setConflict(result.files);
      else if (result.outcome === 'kept') showToast(`Kept the changes in ${project}`, 'success');
      else showToast(`${project} already has these changes`, 'info');
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
    sendAgentMessage(agent.id, resolvePrompt(project, conflict)).then(
      () => setConflict(null),
      fail
    );
  };

  const openPullRequest = () => {
    if (!onPreview) return;
    queueSubmitReview(copy.path, copy.branch);
    onPreview(copy.path);
  };

  const waitHint = working ? `${agent.name} is still working on it` : undefined;

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
          <TextButton tabIndex={0} onClick={() => setConflict(null)}>
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
      <Tooltip content={waitHint ?? `Bring these changes into ${project}`}>
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
