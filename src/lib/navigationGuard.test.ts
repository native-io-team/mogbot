import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { openUrl } = vi.hoisted(() => ({ openUrl: vi.fn<(url: string) => Promise<void>>() }));
vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl }));

import { installNavigationGuard, linkAction, postsElsewhere } from './navigationGuard';

const APP = 'tauri://localhost/index.html';

describe('linkAction', () => {
  it('sends web and mail links to the system', () => {
    expect(linkAction('https://evil.example/login', APP)).toBe('external');
    expect(linkAction('http://example.com', APP)).toBe('external');
    expect(linkAction('mailto:a@b.c', APP)).toBe('external');
  });
  it('never loads anything else in the window', () => {
    expect(linkAction('javascript:alert(1)', APP)).toBe('block');
    expect(linkAction('file:///etc/passwd', APP)).toBe('block');
    expect(linkAction('vscode://file/x', APP)).toBe('block');
    expect(linkAction('/Users/me/report.pdf', 'http://127.0.0.1:1420/')).toBe('block');
    expect(linkAction('http://127.0.0.1:1420/other', 'http://127.0.0.1:1420/')).toBe('block');
  });
  it('treats a cross-origin form post as leaving', () => {
    expect(postsElsewhere('https://evil.example/steal', 'http://127.0.0.1:1420/')).toBe(true);
    expect(postsElsewhere('/local', 'http://127.0.0.1:1420/')).toBe(false);
  });
});

describe('installNavigationGuard', () => {
  let uninstall: () => void;
  beforeEach(() => {
    openUrl.mockClear();
    uninstall = installNavigationGuard(window);
  });
  afterEach(() => {
    uninstall();
    document.body.innerHTML = '';
  });

  function click(html: string) {
    document.body.innerHTML = html;
    const anchor = document.querySelector('a')!;
    const event = new MouseEvent('click', { bubbles: true, cancelable: true });
    (anchor.firstChild ?? anchor).dispatchEvent(event);
    return event;
  }

  it('opens an unhandled web link externally instead of navigating', () => {
    const event = click('<a href="https://evil.example/x"><span>go</span></a>');
    expect(event.defaultPrevented).toBe(true);
    expect(openUrl).toHaveBeenCalledWith('https://evil.example/x');
  });

  it('blocks other schemes without opening anything', () => {
    const event = click('<a href="file:///etc/passwd">f</a>');
    expect(event.defaultPrevented).toBe(true);
    expect(openUrl).not.toHaveBeenCalled();
  });

  it('leaves links a component already handled, in-page anchors and downloads alone', () => {
    document.body.innerHTML = '<a href="https://a.example">a</a>';
    const anchor = document.querySelector('a')!;
    anchor.addEventListener('click', (e) => e.preventDefault());
    anchor.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(openUrl).not.toHaveBeenCalled();

    expect(click('<a href="#top">t</a>').defaultPrevented).toBe(false);
    expect(click('<a href="blob:x" download="a.txt">d</a>').defaultPrevented).toBe(false);
  });

  it('stops a form posting to another origin', () => {
    document.body.innerHTML = '<form action="https://evil.example/steal"><input name="pin"></form>';
    const event = new Event('submit', { bubbles: true, cancelable: true });
    document.querySelector('form')!.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });
});
