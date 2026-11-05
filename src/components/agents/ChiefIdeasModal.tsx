/**
 * "More ideas…": what the team can do, as things to ask the Chief of Staff.
 * The chips under the greeting show three; this shows the whole catalogue
 * (`lib/chiefIdeas.ts`), grouped, each with one line on what actually
 * happens. Picking one opens the Chief's chat with the words typed out for
 * the user to finish; nothing is sent from here.
 *
 * Reachable any time, not only on first run: ⌘K → "Ideas for your team…".
 *
 * @module components/agents/ChiefIdeasModal
 */

import { useRef } from 'react';
import { ModalFrame } from '../primitives/ModalFrame';
import { TextButton } from '../primitives/TextButton';
import { useModal, useOpenModal } from '../../contexts/ModalContext';
import { ideaGroups, type ChiefIdea } from '../../lib/chiefIdeas';

export function ChiefIdeasModal({
  onPick,
  onReadyMade,
}: {
  onPick: (idea: ChiefIdea) => void;
  onReadyMade?: () => void;
}) {
  const modal = useModal('chiefIdeas');
  const openModal = useOpenModal();
  // Focus lands on the list, not its first row: a ring there reads as a choice made.
  const bodyRef = useRef<HTMLDivElement>(null);
  const pick = (idea: ChiefIdea) => {
    modal.close();
    onPick(idea);
  };
  return (
    <ModalFrame
      isOpen={modal.isOpen}
      onClose={modal.close}
      title="Ideas to start with"
      className="agents-ideas"
      initialFocusRef={bodyRef}
    >
      <div className="agents-ideas__body" ref={bodyRef} tabIndex={-1}>
        <p className="agents-ideas__lede">
          Pick one and it’s typed out for your Chief of Staff, for you to finish. Nothing is sent
          until you press Send.
        </p>
        {ideaGroups().map(({ group, label, ideas }) => (
          <section key={group} className="agents-ideas__group" aria-label={label}>
            <h3 className="agents-ideas__group-label">{label}</h3>
            {ideas.map((idea) => (
              // A selection surface with a title and a line under it, not an action button.
              <button
                key={idea.id}
                type="button"
                className="agents-ideas__idea"
                data-idea={idea.id}
                onClick={() => pick(idea)}
              >
                <span className="agents-ideas__title">{idea.label}</span>
                <span className="agents-ideas__what">{idea.what}</span>
              </button>
            ))}
          </section>
        ))}
        <p className="agents-ideas__foot">
          {onReadyMade && (
            <TextButton
              onClick={() => {
                modal.close();
                onReadyMade();
              }}
            >
              Ready-made agents…
            </TextButton>
          )}
          <TextButton
            onClick={() => {
              modal.close();
              openModal('phone');
            }}
          >
            Talk to your team from your phone…
          </TextButton>
        </p>
      </div>
    </ModalFrame>
  );
}
