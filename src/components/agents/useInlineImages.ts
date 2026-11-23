/**
 * Keeps a composer's `[Image N]` markers and its staged images in step
 * (lib/inlineImages): a new image puts its marker in where the caret is,
 * taking the marker out of the words takes the image away, and removing the
 * image's chip takes its marker out. The numbers stay 1, 2, 3… in order.
 *
 * @module components/agents/useInlineImages
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  type KeyboardEvent,
  type RefObject,
} from 'react';
import {
  imagesIn,
  insertMarkers,
  markerAtCaret,
  markerNumbers,
  markersLost,
  withoutImages,
} from '../../lib/inlineImages';
import type { DraftAttachment } from './useComposerAttachments';

interface Options {
  inputRef: RefObject<HTMLTextAreaElement | null>;
  items: DraftAttachment[];
  draft: string;
  setDraft: (text: string) => void;
  /** Takes a staged file away (the chip's ×). */
  remove: (id: string) => void;
}

export function useInlineImages({ inputRef, items, draft, setDraft, remove }: Options) {
  // Where the caret goes once the words set from here are in the field (a
  // controlled field put the caret at the end otherwise).
  const caretAfter = useRef<number | null>(null);
  useLayoutEffect(() => {
    const at = caretAfter.current;
    const el = inputRef.current;
    if (at === null || !el || el.value !== draft) return;
    caretAfter.current = null;
    el.setSelectionRange(at, at);
  }, [draft, inputRef]);

  // Whether you've put the caret somewhere (typed, clicked, moved it). Until
  // then a field shows the caret at its start, and an image dropped or
  // picked before you touched it belongs after the words, not before them.
  const placedCaret = useRef(false);
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    const placed = () => {
      placedCaret.current = true;
    };
    const events = ['keyup', 'mouseup', 'input'] as const;
    events.forEach((name) => el.addEventListener(name, placed));
    return () => events.forEach((name) => el.removeEventListener(name, placed));
  }, [inputRef]);

  const write = useCallback(
    (text: string, caret: number) => {
      caretAfter.current = caret;
      placedCaret.current = true;
      setDraft(text);
    },
    [setDraft]
  );

  // Files already staged when this mounts (a draft kept from before) have
  // their markers, or were placed by hand: only new images get one.
  const seen = useRef(new Set(items.map((i) => i.id)));
  useLayoutEffect(() => {
    const known = seen.current;
    seen.current = new Set(items.map((i) => i.id));
    const images = imagesIn(items);
    const present = markerNumbers(draft);
    const fresh = images
      .map((image, i) => ({ image, n: i + 1 }))
      .filter(({ image, n }) => !known.has(image.id) && !present.has(n))
      .map(({ n }) => n);
    if (fresh.length === 0) return;
    const el = inputRef.current;
    // The field keeps its selection while something else has focus (the +,
    // a drop from Finder), so it goes where you left the caret.
    const usable = el && el.value === draft && placedCaret.current;
    const start = usable ? el.selectionStart : draft.length;
    const end = usable ? el.selectionEnd : draft.length;
    const next = insertMarkers(draft, start, end, fresh);
    write(next.value, next.caret);
    el?.focus({ preventScroll: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- new files only, not every key
  }, [items]);

  /** The chip's ×: the image and its marker. */
  const removeItem = useCallback(
    (id: string) => {
      const images = imagesIn(items);
      const index = images.findIndex((image) => image.id === id);
      if (index >= 0) {
        const el = inputRef.current;
        const caret = el && el.value === draft ? el.selectionStart : draft.length;
        const next = withoutImages(draft, [index + 1], images.length, caret);
        if (next.text !== draft) write(next.text, next.caret);
      }
      remove(id);
    },
    [items, draft, inputRef, remove, write]
  );

  /**
   * The words as typed: any image whose marker they no longer have goes, and
   * the markers after it are numbered down. Use in place of `setDraft` in the
   * field's `onChange`.
   */
  const onChange = useCallback(
    (text: string, caret: number) => {
      const images = imagesIn(items);
      const lost = markersLost(draft, text, images.length);
      if (lost.length === 0) {
        setDraft(text);
        return;
      }
      const next = withoutImages(text, lost, images.length, caret);
      write(next.text, next.caret);
      lost.forEach((n) => remove(images[n - 1].id));
    },
    [items, draft, setDraft, remove, write]
  );

  /** Backspace or Delete against a marker takes all of it. True when it did. */
  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      if (event.key !== 'Backspace' && event.key !== 'Delete') return false;
      if (event.metaKey || event.altKey || event.ctrlKey || event.nativeEvent.isComposing) {
        return false;
      }
      const el = event.currentTarget;
      if (el.readOnly || el.selectionStart !== el.selectionEnd) return false;
      const images = imagesIn(items);
      const n = markerAtCaret(el.value, el.selectionStart, event.key, images.length);
      if (n === null) return false;
      event.preventDefault();
      removeItem(images[n - 1].id);
      return true;
    },
    [items, removeItem]
  );

  return { removeItem, onChange, onKeyDown };
}
