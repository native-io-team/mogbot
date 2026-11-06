import { describe, expect, it } from 'vitest';
import { galleryCounter, galleryOf, galleryStart, galleryStep, messageImages } from './gallery';
import { comparePages, listedItems, type ResultCard } from './results';
import type { Attachment } from './model';

const img = (msg: string, name: string): Attachment => ({
  name,
  path: `attachments/${msg}/${name}`,
  mime: 'image/png',
  size: 10,
});
const pdf: Attachment = {
  name: 'brief.pdf',
  path: 'attachments/m1/brief.pdf',
  mime: 'application/pdf',
  size: 3,
};

const card: ResultCard = {
  id: 'r1',
  version: 1,
  title: 'New hero',
  summary: 'Done',
  items: [
    { kind: 'file', file: img('m2', 'home-before.png'), role: 'before', page: 'Home' },
    { kind: 'file', file: img('m2', 'home-after.png'), role: 'after', page: 'Home' },
    {
      kind: 'file',
      file: img('m2', 'pricing-after.png'),
      role: 'after',
      page: 'Pricing',
      label: 'New pricing table',
    },
    { kind: 'file', file: img('m2', 'pricing-before.png'), role: 'before', page: 'Pricing' },
    { kind: 'file', file: img('m2', 'logo.png'), label: 'Logo' },
    { kind: 'file', file: pdf },
  ],
};

describe('comparePages', () => {
  it('groups shots by page in the order pages first appear', () => {
    const pages = comparePages(card.items);
    expect(pages.map((p) => p.page)).toEqual(['Home', 'Pricing']);
    expect(pages[1].before?.name).toBe('pricing-before.png');
    expect(pages[1].afterLabel).toBe('New pricing table');
  });

  it('leaves compared shots out of the item list', () => {
    expect(listedItems(card.items).map((i) => (i.kind === 'file' ? i.file.name : ''))).toEqual([
      'logo.png',
      'brief.pdf',
    ]);
  });

  it('a single unnamed pair is one page, as older cards were', () => {
    const pages = comparePages([
      { kind: 'file', file: img('m', 'b.png'), role: 'before' },
      { kind: 'file', file: img('m', 'a.png'), role: 'after' },
    ]);
    expect(pages).toHaveLength(1);
    expect(pages[0].page).toBe('');
  });
});

describe('gallery', () => {
  const messages = [
    { id: 'm1', agentId: 'a', attachments: [img('m1', 'sketch.jpg'), pdf] },
    {
      id: 'm2',
      agentId: 'a',
      result: card,
      attachments: (card.items ?? []).flatMap((i) => (i.kind === 'file' ? [i.file] : [])),
    },
    { id: 'm3', agentId: 'a', attachments: [img('m3', 'later.png')] },
  ];

  it('holds every picture in the chat in the order it is shown, once each', () => {
    expect(galleryOf(messages).map((g) => g.file.name)).toEqual([
      'sketch.jpg',
      'home-before.png',
      'home-after.png',
      'pricing-before.png',
      'pricing-after.png',
      'logo.png',
      'later.png',
    ]);
  });

  it("captions compare shots with their page and role, or the agent's own words", () => {
    expect(messageImages(messages[1]).map((g) => g.caption)).toEqual([
      'Home · Before',
      'Home · After',
      'Pricing · Before',
      'New pricing table',
      'Logo',
    ]);
  });

  it('starts at the picture pressed, and at the first when it is gone', () => {
    const g = galleryOf(messages);
    expect(galleryStart(g, 'a', 'attachments/m2/pricing-before.png')).toBe(3);
    expect(galleryStart(g, 'a', 'attachments/zz/none.png')).toBe(0);
    expect(galleryStart(g, 'b', 'attachments/m1/sketch.jpg')).toBe(0);
  });

  it('counts and steps without wrapping', () => {
    expect(galleryCounter(2, 8)).toBe('3 of 8');
    expect(galleryCounter(0, 1)).toBeNull();
    expect(galleryStep(0, -1, 5)).toBe(0);
    expect(galleryStep(4, 1, 5)).toBe(4);
    expect(galleryStep(1, 1, 5)).toBe(2);
  });
});
