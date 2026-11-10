/**
 * Share an agent as a recipe: exactly what the file will hold, read from the
 * Mac (`agents_recipe_preview`), with what was removed counted and what is
 * never in one said. Save writes that same text where the user picks, and
 * only if nothing changed since (`agents_recipe_save`); Copy as text copies
 * it in a form the Chief's chat reads back. Opened from the agent's … menu,
 * ⌘K and the Chief's `share_recipe`.
 *
 * @module components/agents/AgentRecipeModal
 */

import { useCallback, useEffect } from 'react';
import { save } from '@tauri-apps/plugin-dialog';
import { ErrorIcon } from '@/components/icons';
import { ModalFrame } from '../primitives/ModalFrame';
import { Button } from '../primitives/Button';
import { Spinner } from '../primitives/Spinner';
import { AgentKey } from './AgentKey';
import { useAsyncState } from '../../hooks/useAsyncState';
import { useCopyToClipboard } from '../../hooks/useCopyToClipboard';
import { useOptionalToast } from '../../contexts/ToastContext';
import { asCommandError, formatCommandError } from '../../lib/errors';
import { useAgentsSelector } from '../../lib/agentsStore';
import { INDEPENDENCE_LABEL } from '../../lib/agentIndependence';
import {
  previewRecipe,
  recipeTitle,
  removedLine,
  saveRecipe,
  type RecipePreview,
} from '../../lib/agentRecipe';

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="agent-recipe__section" aria-label={title}>
      <h4 className="agent-recipe__heading">{title}</h4>
      {children}
    </section>
  );
}

/** The recipe as it will be written. Exported for the harness and tests. */
export function RecipeContents({ preview }: { preview: RecipePreview }) {
  const r = preview.recipe;
  const removed = removedLine(preview.removed);
  return (
    <div className="agent-recipe" data-testid="agent-recipe">
      <div className="agent-recipe__who">
        <AgentKey
          name={r.name}
          role={r.role}
          colorway={r.look.colorway}
          icon={r.look.icon}
          boundKey={r.look.key ?? null}
          level={null}
          size="md"
        />
        <span className="agent-recipe__name-block">
          <span className="agent-recipe__name">{r.name}</span>
          {r.role && <span className="agent-recipe__role">{r.role}</span>}
        </span>
      </div>
      {removed && (
        <p className="agent-recipe__removed" role="status">
          {removed}
        </p>
      )}
      <Section title="Instructions">
        {r.instructions ? (
          <pre className="agent-recipe__instructions">{r.instructions}</pre>
        ) : (
          <p className="agent-recipe__none">None: its name and role only.</p>
        )}
      </Section>
      {r.routines.length > 0 && (
        <Section title="Routines · arrive paused">
          <ul className="agent-recipe__list">
            {r.routines.map((x, i) => (
              <li key={i}>
                <strong>{x.when}</strong> · {x.what}
              </li>
            ))}
          </ul>
        </Section>
      )}
      {r.watches.length > 0 && (
        <Section title="What it watches for">
          <ul className="agent-recipe__list">
            {r.watches.map((x, i) => (
              <li key={i}>
                <strong>When {x.when}</strong> · {x.what}
              </li>
            ))}
          </ul>
        </Section>
      )}
      {!!r.skills?.length && (
        <Section title="What it knows how to do">
          <ul className="agent-recipe__list">
            {r.skills.map((x, i) => (
              <li key={i}>
                <strong>{x.name}</strong>
                {x.when ? ` · ${x.when}` : ''}
              </li>
            ))}
          </ul>
        </Section>
      )}
      {r.apps.length > 0 && (
        <Section title="Apps it needs · by name, never your sign-in">
          <p className="agent-recipe__line">{r.apps.join(', ')}</p>
        </Section>
      )}
      {r.independence && (
        <Section title="Independence">
          <p className="agent-recipe__line">
            Suggests {INDEPENDENCE_LABEL[r.independence]}. Whoever imports it keeps their own unless
            this is stricter.
          </p>
        </Section>
      )}
      <Section title="Not in it">
        <ul className="agent-recipe__list agent-recipe__list--out">
          {preview.leftOut.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      </Section>
    </div>
  );
}

export function AgentRecipeModal({
  agentId,
  onClose,
}: {
  /** The agent shared; `null` closes it. */
  agentId: string | null;
  onClose: () => void;
}) {
  const name = useAgentsSelector(
    (s) => s.agents?.find((a) => a.id === agentId)?.name ?? 'this agent'
  );
  const { showToast } = useOptionalToast();
  const load = useCallback(() => previewRecipe(agentId ?? ''), [agentId]);
  const { data, error, execute, isLoading } = useAsyncState<RecipePreview>(load);
  useEffect(() => {
    if (agentId) void execute();
  }, [agentId, execute]);
  const { copy, isCopied } = useCopyToClipboard({
    onCopy: () => showToast('Copied. Paste it to whoever you’re sharing it with.', 'success'),
  });

  const saver = useAsyncState(async () => {
    if (!agentId || !data) return;
    const path = await save({
      title: recipeTitle(name),
      defaultPath: data.fileName,
      filters: [{ name: 'Agent recipe', extensions: ['json'] }],
    });
    if (!path) return;
    try {
      await saveRecipe(agentId, path, data.json);
    } catch (e) {
      // It changed since the preview: show what it is now.
      void execute();
      throw new Error(formatCommandError(asCommandError(e)));
    }
    showToast(`Saved ${data.fileName}`, 'success');
    onClose();
  });

  return (
    <ModalFrame
      isOpen={agentId !== null}
      onClose={onClose}
      title={recipeTitle(name)}
      className="agent-recipe-modal"
    >
      <div className="agent-recipe-modal__body">
        <p className="agent-recipe__lede">
          Anyone can make their own {name} from this. It holds what {name} is, never what it knows
          about you.
        </p>
        {data ? (
          <RecipeContents preview={data} />
        ) : error ? (
          <p className="agent-recipe__error" role="alert">
            <ErrorIcon size={12} className="inline-error-icon" />
            {formatCommandError(asCommandError(error))}
          </p>
        ) : (
          <div className="agent-recipe__loading">
            <Spinner size="sm" />
          </div>
        )}
        {saver.error && (
          <p className="agent-recipe__error" role="alert">
            <ErrorIcon size={12} className="inline-error-icon" />
            {saver.error.message}
          </p>
        )}
      </div>
      <footer className="agent-recipe-modal__footer">
        <Button
          variant="secondary"
          disabled={!data || isLoading}
          onClick={() => {
            if (data) void copy(data.text);
          }}
        >
          {isCopied ? 'Copied' : 'Copy as text'}
        </Button>
        <Button
          variant="strong"
          disabled={!data || isLoading || saver.isLoading}
          onClick={() => void saver.execute()}
        >
          Save file…
        </Button>
      </footer>
    </ModalFrame>
  );
}
