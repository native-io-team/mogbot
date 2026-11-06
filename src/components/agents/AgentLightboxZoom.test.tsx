/**
 * A picture in the lightbox, inspected: keys, pinch (ctrl+wheel), click to
 * go fit ↔ 100%, a drag to pan, and a sideways swipe left to the gallery at fit.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { AgentGalleryProvider } from './AgentGallery';
import { MessageAttachments } from './AgentAttachments';
import { ZoomableImage } from './AgentLightboxZoom';
import type { Agent, AgentMessage, Attachment } from '../../lib/agents';

const agent = { id: 'des', name: 'Design', home: '/h/des' } as Agent;
const png = (name: string): Attachment => ({
  name,
  path: `attachments/m1/${name}`,
  mime: 'image/png',
  size: 9,
});

// jsdom has no PointerEvent: without one the coordinates are dropped.
class TestPointerEvent extends MouseEvent {
  readonly pointerId: number;
  constructor(type: string, init: MouseEventInit & { pointerId?: number } = {}) {
    super(type, init);
    this.pointerId = init.pointerId ?? 1;
  }
}

// The stage is 1000×600 and the picture 2000×1200: fit is 50% of its pixels.
let restore: (() => void)[] = [];
beforeEach(() => {
  vi.stubGlobal('PointerEvent', TestPointerEvent);
  restore.push(() => vi.unstubAllGlobals());
  const define = (key: 'clientWidth' | 'clientHeight', value: number) => {
    const before = Object.getOwnPropertyDescriptor(HTMLElement.prototype, key);
    Object.defineProperty(HTMLElement.prototype, key, { configurable: true, get: () => value });
    restore.push(() => before && Object.defineProperty(HTMLElement.prototype, key, before));
  };
  define('clientWidth', 1000);
  define('clientHeight', 600);
  const rect = vi
    .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
    .mockReturnValue({ left: 0, top: 0, width: 1000, height: 600 } as DOMRect);
  restore.push(() => rect.mockRestore());
});
afterEach(() => {
  restore.forEach((undo) => undo());
  restore = [];
});

function loaded() {
  const where = screen.queryByRole('dialog') ?? document.body;
  const img = within(where).getByRole('img', { name: 'shot.png' });
  Object.defineProperty(img, 'naturalWidth', { value: 2000 });
  Object.defineProperty(img, 'naturalHeight', { value: 1200 });
  fireEvent.load(img);
  return img;
}

const readout = () => screen.getByRole('button', { name: /%$/ }).textContent;
const viewport = () => document.querySelector('.agent-lightbox__viewport')!;

describe('the lightbox zoom', () => {
  it('opens at fit and reads the zoom against the picture’s own pixels', () => {
    render(<ZoomableImage agent={agent} attachment={png('shot.png')} />);
    const img = loaded();
    expect(readout()).toBe('50%');
    expect(img.style.width).toBe('1000px');
    expect(screen.getByRole('button', { name: 'Fit' }).getAttribute('aria-pressed')).toBe('true');
  });

  it('zooms with ⌘+ / ⌘− / ⌘0, and the keys reach nothing else', () => {
    const behind = vi.fn();
    window.addEventListener('keydown', behind);
    render(<ZoomableImage agent={agent} attachment={png('shot.png')} />);
    loaded();
    act(() => {
      fireEvent.keyDown(window, { key: '=', metaKey: true });
    });
    expect(readout()).toBe('63%'); // 1.25 × fit
    act(() => {
      fireEvent.keyDown(window, { key: '-', metaKey: true });
    });
    expect(readout()).toBe('50%');
    act(() => {
      fireEvent.keyDown(window, { key: '+', metaKey: true });
      fireEvent.keyDown(window, { key: '+', metaKey: true });
      fireEvent.keyDown(window, { key: '0', metaKey: true });
    });
    expect(readout()).toBe('50%');
    expect(behind).not.toHaveBeenCalled();
    window.removeEventListener('keydown', behind);
  });

  it('a click goes to 100% at the point clicked, and a drag then pans', () => {
    render(<ZoomableImage agent={agent} attachment={png('shot.png')} />);
    const img = loaded();
    const stage = viewport();
    // Clicked 100px right of and 50px below the centre.
    fireEvent.pointerDown(stage, { button: 0, clientX: 600, clientY: 350, pointerId: 1 });
    fireEvent.pointerUp(stage, { button: 0, clientX: 600, clientY: 350, pointerId: 1 });
    expect(readout()).toBe('100%');
    expect(img.style.transform).toBe('translate(calc(-50% + -100px), calc(-50% + -50px))');
    // A drag moves it, and doesn't toggle back.
    fireEvent.pointerDown(stage, { button: 0, clientX: 500, clientY: 300, pointerId: 1 });
    fireEvent.pointerMove(stage, { clientX: 540, clientY: 280, pointerId: 1 });
    fireEvent.pointerUp(stage, { button: 0, clientX: 540, clientY: 280, pointerId: 1 });
    expect(readout()).toBe('100%');
    expect(img.style.transform).toBe('translate(calc(-50% + -60px), calc(-50% + -70px))');
    // Another click comes back to fit.
    fireEvent.pointerDown(stage, { button: 0, clientX: 500, clientY: 300, pointerId: 1 });
    fireEvent.pointerUp(stage, { button: 0, clientX: 500, clientY: 300, pointerId: 1 });
    expect(readout()).toBe('50%');
  });

  it('pinches (ctrl+wheel) and holds the ceiling', () => {
    render(<ZoomableImage agent={agent} attachment={png('shot.png')} />);
    loaded();
    fireEvent.wheel(viewport(), { deltaY: -120, ctrlKey: true, clientX: 500, clientY: 300 });
    expect(readout()).toBe('63%');
    for (let i = 0; i < 40; i++) {
      fireEvent.wheel(viewport(), { deltaY: -120, ctrlKey: true, clientX: 500, clientY: 300 });
    }
    expect(readout()).toBe('400%');
    expect(screen.getByRole('button', { name: 'Zoom in' })).toHaveProperty('disabled', true);
  });

  it('turns the page on a sideways swipe at fit, and pans instead when zoomed', () => {
    const messages: AgentMessage[] = [
      {
        id: 'm1',
        agentId: 'des',
        ts: 1,
        kind: 'agent',
        text: '',
        attachments: [png('shot.png'), png('two.png')],
      },
    ];
    render(
      <AgentGalleryProvider messages={messages} agentOf={() => agent}>
        <MessageAttachments agent={agent} attachments={messages[0].attachments!} />
      </AgentGalleryProvider>
    );
    fireEvent.click(screen.getByRole('button', { name: 'View shot.png' }));
    loaded();
    act(() => {
      fireEvent.keyDown(window, { key: '=', metaKey: true });
    });
    fireEvent.wheel(viewport(), { deltaX: 80, deltaY: 0 });
    expect(screen.getByText('1 of 2')).toBeTruthy();
    act(() => {
      fireEvent.keyDown(window, { key: '0', metaKey: true });
    });
    fireEvent.wheel(viewport(), { deltaX: 80, deltaY: 0 });
    expect(screen.getByText('2 of 2')).toBeTruthy();
    // The next picture opens at fit.
    expect(screen.queryByRole('button', { name: /%$/ })).toBeNull();
  });
});
