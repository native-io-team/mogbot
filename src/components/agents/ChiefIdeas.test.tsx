import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { useEffect } from 'react';
import { ModalProvider, useModal } from '../../contexts/ModalContext';
import { ChiefIdeasModal } from './ChiefIdeasModal';
import { CHIEF_CHIPS, CHIEF_IDEAS, findIdea, ideaGroups } from '../../lib/chiefIdeas';
import { BRAND } from '../../lib/brand';

describe('the Chief’s ideas: the catalogue', () => {
  it('puts four different ways in on the chips', () => {
    expect(CHIEF_CHIPS.map((i) => i.id)).toEqual([
      'morning-brief',
      'make-agent',
      'research',
      'travel',
    ]);
    // Every morning, an agent of your own, work written up, something personal.
    expect(findIdea('morning-brief')?.text).toMatch(/^Every weekday at 8am/);
    expect(findIdea('make-agent')?.label).toBe('Make me an agent');
    expect(findIdea('research')?.oneOff).toBe(true);
    expect(findIdea('travel')?.label).toMatch(/trip/i);
  });

  it('a chip needs nothing set up first, so the first result comes in minutes', () => {
    for (const chip of CHIEF_CHIPS) {
      expect(chip.what).not.toMatch(/Your Chief helps you connect|folder you pick/);
      expect(chip.text).not.toMatch(/email|GitHub|folder|invoices are in/i);
    }
  });

  it('"Make me an agent" asks for a draft first, then the first run now', () => {
    const make = findIdea('make-agent')!;
    expect(make.text).toMatch(/Draft it first/);
    expect(make.text).toMatch(/only when I say yes/);
    expect(make.text).toMatch(/first run now/);
    expect(make.what).toMatch(/Nothing is made until you say yes/);
  });

  it('every idea types a whole brief with one blank at its end, and never sends', () => {
    const ids = CHIEF_IDEAS.map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ideaGroups().flatMap((g) => g.ideas)).toHaveLength(CHIEF_IDEAS.length);
    for (const idea of CHIEF_IDEAS) {
      // A plain starter chip, never a truncated-looking one.
      expect(idea.label.endsWith('…')).toBe(false);
      expect(idea.text.length).toBeGreaterThan(80);
      // The blank: the brief ends on a colon and a space, for the user's words.
      expect(idea.text.endsWith(': ')).toBe(true);
      expect(idea.what.length).toBeGreaterThan(10);
      expect(idea).not.toHaveProperty('send');
    }
  });

  it('each is a pipeline: something starts it and it runs again', () => {
    for (const idea of CHIEF_IDEAS.filter((i) => i.id !== 'debate')) {
      expect(idea.text).toMatch(/every|when|through the day/i);
    }
  });

  it('what reaches others or the repo waits for the user', () => {
    for (const id of [
      'ship-fixes',
      'client-brief',
      'inbox',
      'invoices',
      'social-posts',
      'job-search',
      'house-hunt',
      'meeting-notes',
      'travel',
    ]) {
      expect(findIdea(id)?.text).toMatch(/without (me|my Allow)/);
    }
  });

  it('says up front when it needs something set up, and that the Chief does it', () => {
    for (const id of ['ship-fixes', 'inbox', 'invoices']) {
      expect(findIdea(id)?.what).toMatch(/Your Chief helps you connect/);
    }
  });

  it('the launch team ends up in a room the Chief makes, not one you have to', () => {
    const launch = findIdea('launch')!;
    expect(launch.text).toMatch(/in a room/);
    expect(launch.what).toMatch(/in a room with your Chief/);
    expect(launch.what).not.toMatch(/Put them in a room/);
  });

  it('speaks to people who aren’t developers: no jargon on a chip, and work beyond code', () => {
    for (const chip of CHIEF_CHIPS) {
      expect(chip.label).not.toMatch(/triage|crew|repo|deploy|GitHub/i);
    }
    // A small business and a student each find their first job in the gallery.
    expect(findIdea('invoices')?.label).toMatch(/invoices/i);
    expect(findIdea('research')?.label).toMatch(/research/i);
  });

  it('puts everyday jobs first and anything about code under For builders, last', () => {
    const groups = ideaGroups();
    expect(groups.map((g) => g.label)).toEqual([
      'On a schedule',
      'When something happens',
      'Agents together',
      'For builders',
    ]);
    const everyday = groups.slice(0, -1).flatMap((g) => g.ideas);
    for (const idea of everyday) {
      expect(`${idea.label} ${idea.what}`).not.toMatch(
        /GitHub|\brepo\b|deploy|\berrors?\b|dev server|\bcode\b/i
      );
    }
    expect(groups[groups.length - 1].ideas.map((i) => i.id)).toEqual([
      'ship-fixes',
      'errors',
      'client-brief',
    ]);
    // The jobs a beginner walk-through asked for, each findable by its title.
    for (const job of [
      /inbox/i,
      /invoices/i,
      /research/i,
      /trip/i,
      /social/i,
      /meeting/i,
      /jobs/i,
      /place to live/i,
    ]) {
      expect(everyday.some((i) => job.test(i.label))).toBe(true);
    }
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
    fireEvent.click(screen.getByText('Babysit my errors'));
    expect(onPick).toHaveBeenCalledWith(expect.objectContaining({ id: 'errors' }));
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
