import { afterEach, describe, expect, it } from 'vitest';
import { mockIPC } from '@tauri-apps/api/mocks';
import {
  __resetChatWidthForTests,
  CHAT_WIDTH_CACHE_KEY,
  getChatWidth,
  initChatWidth,
  setChatWidth,
} from './chatWidth';

const attr = () => document.documentElement.getAttribute('data-chat-width');

describe('chat width', () => {
  afterEach(() => {
    __resetChatWidthForTests();
    localStorage.clear();
  });

  it('starts Narrow, then takes the saved width', async () => {
    mockIPC((cmd) => (cmd === 'get_chat_width' ? 'wide' : null));
    initChatWidth();
    expect(attr()).toBe('narrow');
    await new Promise((r) => setTimeout(r, 0));
    expect(getChatWidth()).toBe('wide');
    expect(attr()).toBe('wide');
    expect(localStorage.getItem(CHAT_WIDTH_CACHE_KEY)).toBe('wide');
  });

  it('applies the cached width before the saved one arrives', () => {
    localStorage.setItem(CHAT_WIDTH_CACHE_KEY, 'medium');
    mockIPC(() => new Promise(() => {}));
    initChatWidth();
    expect(attr()).toBe('medium');
  });

  it('saves a choice, and puts the old one back when saving fails', async () => {
    const calls: unknown[] = [];
    mockIPC((cmd, args) => {
      calls.push([cmd, args]);
      if (cmd === 'set_chat_width' && (args as { width: string }).width === 'medium')
        throw new Error('disk full');
      return null;
    });
    await setChatWidth('wide');
    expect(calls).toContainEqual(['set_chat_width', { width: 'wide' }]);
    expect(attr()).toBe('wide');
    await expect(setChatWidth('medium')).rejects.toThrow();
    expect(getChatWidth()).toBe('wide');
    expect(attr()).toBe('wide');
  });
});
