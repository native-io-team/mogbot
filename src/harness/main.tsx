/**
 * Browser harness entry point.
 *
 * Boots the real Ship Studio UI against a fixture backend so a change can be
 * looked at — and screenshotted — without a Tauri build, a real machine state,
 * or a real hosting account. `src/main.tsx` stays the production entry; this
 * file exists only so the app is *observable*.
 *
 * Usage: `pnpm harness` then `http://127.0.0.1:1425/harness.html?scenario=<id>`.
 */

// Must precede every app import: it clears storage that app modules read at
// module scope. See the module docblock.
import './resetStorage';
import './freeze.css';
// Before any React root: keeps infinite CSS animations on the compositor.
import '../lib/noAnimationIterationListeners';
// The root's data-app-hidden / data-app-background, which pause loops and polling.
import '../lib/appActivity';

import React from 'react';
import ReactDOM from 'react-dom/client';
import App from '../App';
import { QuickEntry } from '../components/agents/QuickEntry';
import { ErrorBoundary } from '../components/ErrorBoundary';
import { installFakeBackend, whenIpcQuiet } from './fakeBackend';
import { findScenario, scenarios } from './scenarios';
import type { ScenarioStep } from './types';
import { unhandledCalls } from './unhandled';
import { listCommands, runCommand, whenRegistryStable } from './commandBridge';
import { HarnessOverlay } from './HarnessOverlay';
import { initTheme } from '../lib/theme';
import { holdCopiedFlag } from '../hooks/useCopyToClipboard';

const params = new URLSearchParams(window.location.search);
const scenario = findScenario(params.get('scenario'));
const showChrome = params.get('chrome') !== 'off';
/**
 * `?command=<palette id>` runs one registered command once the app has
 * settled. This is how the harness reaches a surface it has no hand-written
 * scenario for — the palette registry is the app's own list of features.
 */
const commandId = params.get('command');
/**
 * Motion is frozen by default so two capture runs agree pixel-for-pixel.
 * `?freeze=off` restores animation for watching a transition by hand.
 */
if (params.get('freeze') !== 'off') {
  document.documentElement.setAttribute('data-harness-freeze', '');
}

// The IPC bridge must exist before any app module runs an effect.
installFakeBackend(scenario);

// `?theme=light|dark|system` (resetStorage.ts seeds it before any app module).
initTheme();

/**
 * What each scripted step did, so a capture can say a step never happened
 * rather than quietly photographing the screen before it.
 */
const stepLog: string[] = [];

/** Handle for scripted capture runs and for asking the page what it knows. */
declare global {
  interface Window {
    __harness: {
      scenario: typeof scenario;
      scenarios: typeof scenarios;
      unhandled: typeof unhandledCalls;
      /** Every command the app has registered in the Cmd+K palette. */
      commands: typeof listCommands;
      /** Wait for the registry to stop churning, then list it. */
      commandsWhenReady: typeof whenRegistryStable;
      /** Run one registered command by id. */
      run: typeof runCommand;
      /** Which command this page was asked to run, if any. */
      commandId: string | null;
      /** Set when `?command=` named an id the registry doesn't have. */
      commandMissing?: boolean;
      /** What the scenario's scripted steps did, in order. */
      steps?: string[];
    };
  }
}
window.__harness = {
  scenario,
  scenarios,
  unhandled: unhandledCalls,
  commands: listCommands,
  commandsWhenReady: whenRegistryStable,
  run: runCommand,
  commandId,
  steps: stepLog,
};

document.title = `Harness — ${scenario.id}`;

if (scenario.root === 'quick-entry') document.documentElement.dataset.window = 'quick-entry';

// Copying is never the subject of a capture; what the page shows after it is.
// The real clipboard depends on which tab of a shared browser has focus (a
// denied write retries for over a second, then fails), and "Copied" resets
// after 2s, which a loaded machine can pass before the screenshot. So a copy
// here always succeeds at once, and its flag holds for the capture.
try {
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: () => Promise.resolve(), readText: () => Promise.resolve('') },
  });
} catch {
  // A browser that refuses: copies take the real path, as before.
}
holdCopiedFlag(10 * 60_000);

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <ErrorBoundary>
      {scenario.root === 'quick-entry' ? (
        <QuickEntry />
      ) : (
        <App initialProjectPath={params.get('project') ?? scenario.project ?? null} />
      )}
    </ErrorBoundary>
  </React.StrictMode>
);

/**
 * Click the scenario's control once the app has settled, and announce
 * readiness on `window.__harnessReady`. A capture runner waits on that flag
 * rather than on a fixed sleep, so a slow machine produces the same screenshot
 * as a fast one instead of a half-painted one.
 */
/** Wait for a selector to exist, or give up after `timeoutMs`. */
/**
 * Drawn somewhere on the page: a layout box of its own, or (for a
 * `display: contents` wrapper, which has none) a drawn child.
 */
function isDrawn(el: Element): boolean {
  if (el.getClientRects().length > 0) return true;
  return getComputedStyle(el).display === 'contents' && [...el.children].some(isDrawn);
}

async function waitFor(
  selector: string,
  timeoutMs = 8000,
  text?: string
): Promise<HTMLElement | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const all = [...document.querySelectorAll<HTMLElement>(selector)].filter(
      (e) => !text || (e.textContent ?? '').includes(text)
    );
    // A drawn match first; a hidden one only once the wait is over, so the
    // step can say it was hidden rather than that it never appeared.
    const drawn = all.find(isDrawn);
    if (drawn) return drawn;
    if (Date.now() > deadline) return all[0] ?? null;
    await new Promise((r) => setTimeout(r, 100));
  }
}

/**
 * Type into a controlled input the way a user does.
 *
 * Setting `el.value` directly is invisible to React: the DOM updates, the
 * component's state does not, and the capture shows a filled field above a
 * still-disabled Save button — a screen the app cannot actually produce. Going
 * through the prototype's own setter and dispatching `input` is what React's
 * synthetic event system reads.
 */
function fillInput(el: HTMLElement, value: string): void {
  // The setter must come from the element's own prototype: the input setter
  // applied to a textarea throws "Illegal invocation".
  const prototype =
    el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const descriptor = Object.getOwnPropertyDescriptor(prototype, 'value');
  // Deliberately an unbound setter, applied to this element: that is the whole
  // technique. `unbound-method` is guarding against losing `this`, which the
  // explicit receiver here supplies.
  // eslint-disable-next-line @typescript-eslint/unbound-method
  const setValue = descriptor?.set;
  if (setValue) Reflect.apply(setValue, el, [value]);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

function selectOption(el: HTMLElement, value: string): void {
  const descriptor = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
  // eslint-disable-next-line @typescript-eslint/unbound-method
  const setValue = descriptor?.set;
  if (setValue) Reflect.apply(setValue, el, [value]);
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

/**
 * Perform the scenario's interactions in order: `openSelector` first, then any
 * `steps`. A step that never finds its selector stops the sequence — later
 * steps are written against the screen it was supposed to open, so continuing
 * would click whatever happens to match on the wrong one.
 */
async function runSteps(list?: ScenarioStep[]): Promise<void> {
  const steps = list ?? [
    // The sidebar's Projects segment (labels, stacked or compact icons).
    ...(scenario.startOn === 'projects' ? [{ click: '.mode-toggle [aria-label="Projects"]' }] : []),
    ...(scenario.openSelector ? [{ click: scenario.openSelector }] : []),
    ...(scenario.steps ?? []),
  ];

  for (const step of steps) {
    if (step.key) {
      const parts = step.key.split('+');
      const key = parts[parts.length - 1];
      // At what has focus, so a control's own onKeyDown hears it (a slider's
      // arrows); it bubbles on to the window's shortcut listeners from there.
      const target: EventTarget =
        document.activeElement && document.activeElement !== document.body
          ? document.activeElement
          : window;
      target.dispatchEvent(
        new KeyboardEvent('keydown', {
          key,
          metaKey: parts.includes('mod'),
          shiftKey: parts.includes('shift'),
          bubbles: true,
          cancelable: true,
        })
      );
      stepLog.push(`pressed ${step.key}`);
      await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 50)));
      continue;
    }
    const selector =
      step.click ?? step.rightClick ?? step.hover ?? step.fill ?? step.select ?? step.focus;
    if (!selector) continue;
    const el = await waitFor(selector, undefined, step.text);
    const named = step.text ? `${selector} “${step.text}”` : selector;
    if (!el) {
      stepLog.push(`never appeared: ${named}`);
      console.error(`[harness] step never appeared: ${named}`);
      return;
    }
    // In the page but drawn nowhere (display: none, or inside something that
    // is): a step into it "works" while the screen shows something else, as
    // New agent's form did once it opened describe-first.
    if (!isDrawn(el)) {
      stepLog.push(`never appeared: ${named} (in the page, but hidden)`);
      console.error(`[harness] step target is hidden: ${named}`);
      return;
    }
    if (step.click) {
      // A mouse click, with its click count. `el.click()` sends detail 0,
      // which is what a keyboard-activated click looks like, so anything that
      // tells the two apart (a menu that only rings its first item for the
      // keyboard) would be photographed in the keyboard state.
      el.dispatchEvent(
        new MouseEvent('click', { bubbles: true, cancelable: true, view: window, detail: 1 })
      );
      stepLog.push(`clicked ${selector}`);
    } else if (step.rightClick) {
      // At the element's middle, where a person would right-click it, so the
      // menu opens beside it rather than at the page's corner.
      const box = el.getBoundingClientRect();
      el.dispatchEvent(
        new MouseEvent('contextmenu', {
          bubbles: true,
          cancelable: true,
          view: window,
          button: 2,
          clientX: box.left + box.width / 2,
          clientY: box.top + box.height / 2,
        })
      );
      stepLog.push(`right-clicked ${selector}`);
    } else if (step.hover) {
      el.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse' }));
      stepLog.push(`hovered ${selector}`);
      // The shared tooltip waits out its one-second show delay first.
      await new Promise((r) => setTimeout(r, 1200));
    } else if (step.focus) {
      el.focus();
      stepLog.push(`focused ${selector}`);
    } else if (step.fill) {
      fillInput(el, step.value ?? '');
      stepLog.push(`filled ${selector}`);
    } else {
      selectOption(el, step.value ?? '');
      stepLog.push(`selected ${step.value ?? ''} in ${selector}`);
    }
    // One frame, so this step's render lands before the next step looks for
    // the element it produces.
    await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
  }
}

async function settle(): Promise<void> {
  await runSteps();
  if (commandId) {
    // Wait for every feature hook to have registered before looking the
    // command up, otherwise a slow bucket reads as a missing command.
    await whenRegistryStable();
    const ran = await runCommand(commandId).catch((e) => {
      console.error(`[harness] command ${commandId} threw:`, e);
      return true; // it exists; it failed. That is a finding, not a lookup miss.
    });
    if (!ran) {
      window.__harness.commandMissing = true;
      console.error(`[harness] no such palette command: ${commandId}`);
    }
  }
  if (scenario.afterCommand?.length) {
    await whenIpcQuiet();
    await runSteps(scenario.afterCommand);
  }

  // Wait for the app to stop asking the backend for things, then for one
  // paint. This is what makes two capture runs agree: a fixed delay races
  // any panel whose state arrives on a later round-trip.
  await whenIpcQuiet();
  await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 250)));
  (window as unknown as { __harnessReady?: boolean }).__harnessReady = true;
}

void settle();

if (showChrome) {
  const chrome = document.createElement('div');
  document.body.appendChild(chrome);
  ReactDOM.createRoot(chrome).render(<HarnessOverlay scenario={scenario} />);
}
