import { useEffect, useRef, useState } from 'react';
import { describe, expect, it } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { useInlineImages } from './useInlineImages';
import type { DraftAttachment } from './useComposerAttachments';

const png = (id: string): DraftAttachment => ({
  id,
  name: `${id}.png`,
  mime: 'image/png',
  size: 10,
  previewUrl: `blob:${id}`,
});
const pdf: DraftAttachment = { id: 'spec', name: 'spec.pdf', mime: 'application/pdf', size: 10 };

let api: {
  add: (item: DraftAttachment) => void;
  removeItem: (id: string) => void;
  items: () => DraftAttachment[];
};

function Composer({ initial = '' }: { initial?: string }) {
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [draft, setDraft] = useState(initial);
  const [items, setItems] = useState<DraftAttachment[]>([]);
  const inline = useInlineImages({
    inputRef,
    items,
    draft,
    setDraft,
    remove: (id) => setItems((list) => list.filter((i) => i.id !== id)),
  });
  useEffect(() => {
    api = {
      add: (item) => setItems((list) => [...list, item]),
      removeItem: inline.removeItem,
      items: () => items,
    };
  });
  return (
    <textarea
      ref={inputRef}
      aria-label="Message"
      value={draft}
      onChange={(e) => inline.onChange(e.target.value, e.target.selectionStart)}
      onKeyDown={(e) => inline.onKeyDown(e)}
    />
  );
}

const field = () => screen.getByLabelText<HTMLTextAreaElement>('Message');

describe('useInlineImages', () => {
  it('before the caret is placed, a new image goes after the words', () => {
    render(<Composer initial="look" />);
    act(() => api.add(png('a')));
    expect(field().value).toBe('look [Image 1] ');
  });

  it('a new image goes in as [Image N] where the caret was', () => {
    render(<Composer initial="the hero is too tall" />);
    field().setSelectionRange('the hero'.length, 'the hero'.length);
    fireEvent.mouseUp(field());
    act(() => api.add(png('a')));
    expect(field().value).toBe('the hero [Image 1] is too tall');
    act(() => api.add(pdf));
    // A file isn't placed among the words.
    expect(field().value).toBe('the hero [Image 1] is too tall');
    field().setSelectionRange(field().value.length, field().value.length);
    fireEvent.mouseUp(field());
    act(() => api.add(png('b')));
    expect(field().value).toBe('the hero [Image 1] is too tall [Image 2] ');
  });

  it("the chip's × takes the marker out and numbers the rest down", () => {
    render(<Composer />);
    act(() => api.add(png('a')));
    act(() => api.add(png('b')));
    expect(field().value).toBe('[Image 1] [Image 2] ');
    act(() => api.removeItem('a'));
    expect(field().value).toBe('[Image 1] ');
    expect(api.items().map((i) => i.id)).toEqual(['b']);
  });

  it('Backspace against a marker takes it whole, with its image', () => {
    render(<Composer initial="see " />);
    act(() => api.add(png('a')));
    const end = 'see [Image 1]'.length;
    field().setSelectionRange(end, end);
    fireEvent.keyDown(field(), { key: 'Backspace' });
    expect(api.items()).toHaveLength(0);
    expect(field().value).toBe('see ');
  });

  it('typing over a marker drops its image', () => {
    render(<Composer />);
    act(() => api.add(png('a')));
    act(() => api.add(png('b')));
    fireEvent.change(field(), { target: { value: 'only [Image 2] ' } });
    expect(api.items().map((i) => i.id)).toEqual(['b']);
    expect(field().value).toBe('only [Image 1] ');
  });
});
