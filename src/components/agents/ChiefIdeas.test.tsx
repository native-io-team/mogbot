import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { useEffect } from 'react';
import { ModalProvider, useModal } from '../../contexts/ModalContext';
import { ChiefIdeasModal } from './ChiefIdeasModal';
import { CHIEF_CHIPS, CHIEF_IDEAS, ideaGroups } from '../../lib/chiefIdeas';
import { BRAND } from '../../lib/brand';

describe('the Chief’s ideas: the catalogue', () => {
  it('puts a team, a routine and something real on the chips', () => {
    expect(CHIEF_CHIPS.map((i) => i.id)).toEqual(['team', 'brief', 'site']);
    expect(new Set(CHIEF_CHIPS.map((i) => i.group))).toEqual(new Set(['team', 'ongoing', 'make']));
  });

  it('every idea types, never sends, and is in exactly one group', () => {
    const ids = CHIEF_IDEAS.map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ideaGroups().flatMap((g) => g.ideas)).toHaveLength(CHIEF_IDEAS.length);
    for (const idea of CHIEF_IDEAS) {
      expect(idea.label.endsWith('…')).toBe(true);
      expect(idea.text.trim().length).toBeGreaterThan(10);
      expect(idea.what.length).toBeGreaterThan(10);
      expect(idea).not.toHaveProperty('send');
    }
  });

  it('none of them needs an account or a connected app on a fresh Mac', () => {
    const words = CHIEF_IDEAS.map((i) => `${i.text} ${i.what}`).join(' ');
    expect(words).not.toMatch(/github|gmail|calendar|slack|linear|notion/i);
  });

  it('is name-free', () => {
    const words = CHIEF_IDEAS.map((i) => `${i.label} ${i.text} ${i.what}`).join(' ');
    expect(words).not.toContain(BRAND.name);
    expect(words).not.toMatch(/ship studio/i);
  });
});

function Opened({ onPick, onReadyMade }: { onPick: () => void; onReadyMade?: () => void }) {
  const ideas = useModal('chiefIdeas');
  const phone = useModal('phone');
  useEffect(() => ideas.open(), []); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <>
      <ChiefIdeasModal onPick={onPick} onReadyMade={onReadyMade} />
      <span data-testid="phone">{phone.isOpen ? 'phone open' : 'phone closed'}</span>
      <span data-testid="ideas">{ideas.isOpen ? 'ideas open' : 'ideas closed'}</span>
    </>
  );
}

describe('ChiefIdeasModal', () => {
  it('lists every idea under its group, with what happens', () => {
    render(
      <ModalProvider>
        <Opened onPick={vi.fn()} />
      </ModalProvider>
    );
    for (const { label, ideas } of ideaGroups()) {
      expect(screen.getByRole('heading', { name: label })).toBeInTheDocument();
      for (const idea of ideas) expect(screen.getByText(idea.what)).toBeInTheDocument();
    }
  });

  it('picking one hands it over and closes', () => {
    const onPick = vi.fn();
    render(
      <ModalProvider>
        <Opened onPick={onPick} />
      </ModalProvider>
    );
    fireEvent.click(screen.getByText('When a PDF lands in Downloads…'));
    expect(onPick).toHaveBeenCalledWith(expect.objectContaining({ id: 'when-pdf' }));
    expect(screen.getByTestId('ideas')).toHaveTextContent('ideas closed');
  });

  it('offers ready-made agents and the phone at its foot', () => {
    const onReadyMade = vi.fn();
    render(
      <ModalProvider>
        <Opened onPick={vi.fn()} onReadyMade={onReadyMade} />
      </ModalProvider>
    );
    fireEvent.click(screen.getByRole('button', { name: 'Ready-made agents…' }));
    expect(onReadyMade).toHaveBeenCalled();
  });

  it('the phone link opens the Phone panel', () => {
    render(
      <ModalProvider>
        <Opened onPick={vi.fn()} />
      </ModalProvider>
    );
    fireEvent.click(screen.getByRole('button', { name: 'Talk to your team from your phone…' }));
    expect(screen.getByTestId('phone')).toHaveTextContent('phone open');
  });
});
