import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import {
  installNoAnimationIterationListeners,
  isReactContainer,
} from './noAnimationIterationListeners';

describe('noAnimationIterationListeners', () => {
  installNoAnimationIterationListeners();

  it("drops only a React container's animationiteration listener", () => {
    const container = document.createElement('div') as HTMLDivElement & Record<string, unknown>;
    container._reactListening123 = true;
    expect(isReactContainer(container)).toBe(true);
    const iteration = vi.fn();
    const end = vi.fn();
    container.addEventListener('animationiteration', iteration);
    container.addEventListener('animationend', end);
    container.dispatchEvent(new Event('animationiteration'));
    container.dispatchEvent(new Event('animationend'));
    expect(iteration).not.toHaveBeenCalled();
    expect(end).toHaveBeenCalledOnce();
  });

  it('leaves every other listener alone, the document included', () => {
    const el = document.createElement('div');
    const iteration = vi.fn();
    el.addEventListener('animationiteration', iteration);
    el.dispatchEvent(new Event('animationiteration'));
    expect(iteration).toHaveBeenCalledOnce();
    const onDocument = vi.fn();
    (document as unknown as Record<string, unknown>)._reactListeningX = true;
    document.addEventListener('animationiteration', onDocument);
    document.dispatchEvent(new Event('animationiteration'));
    document.removeEventListener('animationiteration', onDocument);
    expect(onDocument).toHaveBeenCalledOnce();
  });

  // The patch rests on a react-dom internal. If this fails after a React
  // upgrade, the patch has gone quiet (harmless, but the loaders cost the
  // main thread again): find the new marker, or drop the patch.
  it('still recognises a real React root, and React still asks to listen', () => {
    const spy = vi.spyOn(EventTarget.prototype, 'addEventListener');
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => root.render(createElement('span', null, 'hi')));
    const asked = spy.mock.calls.some(
      ([type], i) => type === 'animationiteration' && spy.mock.contexts[i] === container
    );
    spy.mockRestore();
    expect(isReactContainer(container)).toBe(true);
    expect(asked).toBe(true);
    act(() => root.unmount());
    container.remove();
  });

  it('nothing in src/ uses onAnimationIteration, which this would silence', () => {
    const sources = import.meta.glob<string>(['/src/**/*.{ts,tsx}', '!**/noAnimationIteration*'], {
      query: '?raw',
      import: 'default',
      eager: true,
    });
    expect(Object.keys(sources).length).toBeGreaterThan(100);
    const offenders = Object.entries(sources)
      .filter(([, text]) => text.includes('onAnimationIteration'))
      .map(([path]) => path);
    expect(offenders).toEqual([]);
  });
});
