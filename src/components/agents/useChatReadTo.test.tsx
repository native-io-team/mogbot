import { act, fireEvent, render, screen } from '@testing-library/react';
import { useRef, useState } from 'react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  flushChatRestore,
  keepReadTo,
  readTo,
  resetChatRestoreForTests,
} from '../../lib/chatRestore';
import { resetReadToForTests, useChatReadTo } from './useChatReadTo';

// jsdom has no layout: each line is 100px tall, stacked; the view is 300px.
const LINE = 100;
const VIEW = 300;
const tops = new WeakMap<Element, number>();
const scrolled = new WeakMap<Element, number>();
let restore: (() => void)[] = [];

// Per test: the suite's setup restores every spy after each one.
beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement
  ) {
    const scroller = this.closest('[data-testid=scroller]');
    const top = this.dataset.messageIds
      ? (tops.get(this) ?? 0) - (scroller ? (scrolled.get(scroller) ?? 0) : 0)
      : 0;
    return { top, bottom: top + LINE, left: 0, right: 0, width: 0, height: LINE } as DOMRect;
  });
});

beforeAll(() => {
  const proto = HTMLElement.prototype;
  const define = (name: string, get: (el: HTMLElement) => number, set?: boolean) => {
    const before = Object.getOwnPropertyDescriptor(proto, name);
    Object.defineProperty(proto, name, {
      configurable: true,
      get(this: HTMLElement) {
        return get(this);
      },
      ...(set && {
        set(this: HTMLElement, v: number) {
          scrolled.set(this, v);
        },
      }),
    });
    restore.push(() => before && Object.defineProperty(proto, name, before));
  };
  define('scrollTop', (el) => scrolled.get(el) ?? 0, true);
  define('scrollHeight', (el) => el.querySelectorAll('[data-message-ids]').length * LINE);
  define('clientHeight', () => VIEW);
});
afterAll(() => {
  restore.forEach((r) => r());
  restore = [];
});

function Chat({
  ids,
  startIndex = 0,
  loaded = ids,
  mountFrom = () => {},
}: {
  ids: string[];
  startIndex?: number;
  loaded?: string[];
  mountFrom?: (id: string) => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const messagesRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);
  const [atBottom, setAtBottom] = useState(true);
  const { onScrolled } = useChatReadTo({
    chatKey: 'a1',
    ready: true,
    scrollRef,
    messagesRef,
    atBottomRef,
    setAtBottom,
    indexOf: (id) => loaded.indexOf(id),
    startIndex,
    mountFrom,
    lastKey: ids[ids.length - 1] ?? '',
  });
  return (
    <div
      data-testid="scroller"
      ref={scrollRef}
      onScroll={() => {
        const el = scrollRef.current!;
        atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 1;
        onScrolled();
      }}
    >
      <div ref={messagesRef}>
        {ids.map((id, i) => (
          <div
            key={id}
            data-message-ids={id}
            ref={(el) => {
              if (el) tops.set(el, i * LINE);
            }}
          >
            {id}
          </div>
        ))}
      </div>
      <span data-testid="bottom">{String(atBottom)}</span>
    </div>
  );
}

const ten = Array.from({ length: 10 }, (_, i) => `m${i}`);

/** A new launch: storage kept, everything in memory gone. */
function relaunch() {
  flushChatRestore();
  resetChatRestoreForTests();
  resetReadToForTests();
}

describe('useChatReadTo', () => {
  beforeEach(() => {
    // The last test's chat noted its place as it unmounted: start clean.
    relaunch();
    localStorage.clear();
    resetChatRestoreForTests();
  });
  afterEach(() => vi.useRealTimers());

  it('reopens after a restart with the line that was at the top back at the top', () => {
    keepReadTo('a1', { id: 'm5', offset: 20 });
    relaunch();
    render(<Chat ids={ten} />);
    expect(screen.getByTestId('scroller').scrollTop).toBe(5 * LINE - 20);
    expect(screen.getByTestId('bottom').textContent).toBe('false');
  });

  it('notes where you scrolled to, and the next launch goes back there', () => {
    vi.useFakeTimers();
    const { unmount } = render(<Chat ids={ten} />);
    const scroller = screen.getByTestId('scroller');
    scroller.scrollTop = 250;
    fireEvent.scroll(scroller);
    act(() => vi.advanceTimersByTime(200));
    expect(readTo('a1')).toEqual({ id: 'm2', offset: -50 });
    unmount();
    relaunch();
    render(<Chat ids={ten} />);
    expect(screen.getByTestId('scroller').scrollTop).toBe(250);
  });

  it('at the newest line there is no place to go back to', () => {
    vi.useFakeTimers();
    keepReadTo('a1', { id: 'm2', offset: 0 });
    relaunch();
    render(<Chat ids={ten} />);
    const scroller = screen.getByTestId('scroller');
    scroller.scrollTop = 10 * LINE - VIEW;
    fireEvent.scroll(scroller);
    act(() => vi.advanceTimersByTime(200));
    expect(readTo('a1')).toBeNull();
  });

  it('a line that is gone opens at the newest line, as always', () => {
    keepReadTo('a1', { id: 'deleted', offset: 0 });
    relaunch();
    render(<Chat ids={ten} />);
    expect(screen.getByTestId('scroller').scrollTop).toBe(0);
    expect(screen.getByTestId('bottom').textContent).toBe('true');
  });

  it('mounts from a line that is loaded but not yet drawn', () => {
    keepReadTo('a1', { id: 'm1', offset: 0 });
    relaunch();
    const mountFrom = vi.fn();
    render(<Chat ids={ten.slice(5)} loaded={ten} startIndex={5} mountFrom={mountFrom} />);
    expect(mountFrom).toHaveBeenCalledWith('m1');
  });

  it('puts the place back once per launch, not every time the chat opens', () => {
    keepReadTo('a1', { id: 'm5', offset: 0 });
    relaunch();
    const first = render(<Chat ids={ten} />);
    expect(screen.getByTestId('scroller').scrollTop).toBe(5 * LINE);
    first.unmount();
    render(<Chat ids={ten} />);
    expect(screen.getByTestId('scroller').scrollTop).toBe(0);
  });
});
