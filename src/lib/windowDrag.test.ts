import { describe, expect, it } from 'vitest';
import { shouldDragWindow, TITLEBAR_STRIP_PX } from './windowDrag';

const press = (over: Partial<Parameters<typeof shouldDragWindow>[1]> = {}) => ({
  button: 0,
  clientY: 200,
  defaultPrevented: false,
  altKey: false,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  ...over,
});

function el(html: string, pick: string): Element {
  const root = document.createElement('div');
  root.innerHTML = html;
  document.body.appendChild(root);
  return root.querySelector(pick)!;
}

describe('shouldDragWindow', () => {
  it('drags from a marked header, never from its controls', () => {
    const h =
      '<header data-window-drag><span id="t">Chief</span><button id="b">Model</button><input id="i"/></header>';
    expect(shouldDragWindow(el(h, '#t'), press(), false)).toBe(true);
    expect(shouldDragWindow(el(h, '#b'), press(), false)).toBe(false);
    expect(shouldDragWindow(el(h, '#i'), press(), false)).toBe(false);
  });

  it('drags from the title bar strip on macOS, anywhere that is not a control', () => {
    const t = el('<main><p id="p">Hi</p></main>', '#p');
    expect(shouldDragWindow(t, press({ clientY: 10 }), true)).toBe(true);
    expect(shouldDragWindow(t, press({ clientY: TITLEBAR_STRIP_PX + 1 }), true)).toBe(false);
    // Windows and Linux have their own title bar: only marked zones.
    expect(shouldDragWindow(t, press({ clientY: 10 }), false)).toBe(false);
  });

  it('leaves right clicks, modified clicks and handled presses alone', () => {
    const t = el('<div data-window-drag><span id="s">x</span></div>', '#s');
    expect(shouldDragWindow(t, press({ button: 2 }), true)).toBe(false);
    expect(shouldDragWindow(t, press({ metaKey: true }), true)).toBe(false);
    expect(shouldDragWindow(t, press({ defaultPrevented: true }), true)).toBe(false);
    expect(
      shouldDragWindow(
        el(
          '<div data-window-drag><div data-no-window-drag><span id="n">x</span></div></div>',
          '#n'
        ),
        press(),
        true
      )
    ).toBe(false);
  });
});
