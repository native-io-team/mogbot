/**
 * The app window never navigates away from the app.
 *
 * The Rust navigation guard (`src-tauri/src/navigation_guard.rs`) cannot tell
 * the app's own frame from the preview's iframes on macOS, so it has to let
 * web URLs through for the preview's sake. This closes the top-level half:
 *
 * - a click on any link that no component handled itself goes to the system
 *   browser (web, mail) or nowhere (anything else, including a path on the
 *   app's own origin, which would unload the app) — never into this window;
 * - a form that would post to another origin is stopped.
 *
 * Clicks inside the preview iframe never reach this document, so the preview
 * behaves exactly as before.
 */
import { openUrl } from '@tauri-apps/plugin-opener';

const EXTERNAL = new Set(['http:', 'https:', 'mailto:', 'tel:']);

/** What a click on this href should do: open it in the system, or nothing.
 *  The app is one page; no link is ever meant to load in its window. */
export function linkAction(href: string, appHref: string): 'external' | 'block' {
  try {
    const url = new URL(href, appHref);
    if (!EXTERNAL.has(url.protocol)) return 'block';
    // The dev server (and Windows' https://tauri.localhost) is itself http(s).
    // Opaque origins compare as "null", so only compare real ones.
    const app = new URL(appHref).origin;
    return app !== 'null' && url.origin === app ? 'block' : 'external';
  } catch {
    return 'block';
  }
}

/** Whether a form post leaves the app's origin. */
export function postsElsewhere(action: string, appHref: string): boolean {
  try {
    return new URL(action, appHref).origin !== new URL(appHref).origin;
  } catch {
    return true;
  }
}

export function installNavigationGuard(win: Window = window): () => void {
  const onClick = (event: MouseEvent) => {
    // Components that route their own links (agent prose, Inbox) already
    // called preventDefault; so did the opener plugin for target=_blank.
    if (event.defaultPrevented) return;
    const anchor = event
      .composedPath()
      .find((node): node is HTMLAnchorElement => node instanceof HTMLAnchorElement);
    const href = anchor?.getAttribute('href');
    // In-page anchors and saved downloads are not navigations.
    if (!anchor || !href || href.startsWith('#') || anchor.hasAttribute('download')) return;
    const action = linkAction(anchor.href || href, win.location.href);
    event.preventDefault();
    if (action === 'external')
      void openUrl(new URL(anchor.href || href, win.location.href).toString());
  };
  const onSubmit = (event: SubmitEvent) => {
    const form = event.target;
    if (!(form instanceof HTMLFormElement)) return;
    const action = form.getAttribute('action');
    if (action && postsElsewhere(form.action || action, win.location.href)) {
      event.preventDefault();
    }
  };
  win.addEventListener('click', onClick);
  win.addEventListener('auxclick', onClick);
  win.addEventListener('submit', onSubmit, true);
  return () => {
    win.removeEventListener('click', onClick);
    win.removeEventListener('auxclick', onClick);
    win.removeEventListener('submit', onSubmit, true);
  };
}
