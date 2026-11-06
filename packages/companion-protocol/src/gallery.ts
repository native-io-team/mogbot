/**
 * The full-size image viewer is a gallery of every picture in the chat, in
 * the order the chat shows them: swipe (phone) or arrow (desk) from one to
 * the next. Opening a picture starts the gallery at that picture.
 *
 * Shared by the desk and the phone so both step through the same pictures
 * in the same order, with the same captions.
 */

import type { AgentMessage, Attachment } from './model';
import { comparePageName, comparePages, itemName, listedItems, testShots } from './results';

export interface GalleryImage {
  /** Stable across renders: the agent's id and the picture's path in its home. */
  key: string;
  agentId: string;
  messageId: string;
  file: Attachment;
  /** What the viewer prints under it: the agent's caption, else the file's name. */
  caption: string;
}

export function isImageAttachment(file: Pick<Attachment, 'mime'>): boolean {
  return /^image\//i.test(file.mime);
}

export function galleryKey(agentId: string, path: string): string {
  return `${agentId}\u0000${path}`;
}

type Message = Pick<AgentMessage, 'id' | 'agentId' | 'attachments' | 'result'>;

/** The pictures one message shows, in the order it shows them. */
export function messageImages(message: Message): GalleryImage[] {
  const out: GalleryImage[] = [];
  const seen = new Set<string>();
  const add = (file: Attachment, caption: string) => {
    if (!isImageAttachment(file) || seen.has(file.path)) return;
    seen.add(file.path);
    out.push({
      key: galleryKey(message.agentId, file.path),
      agentId: message.agentId,
      messageId: message.id,
      file,
      caption: caption.trim() || file.name,
    });
  };
  const card = message.result;
  if (card) {
    const pages = comparePages(card.items);
    pages.forEach((page, i) => {
      const name = pages.length > 1 || page.page ? `${comparePageName(page, i)} · ` : '';
      if (page.before) add(page.before, page.beforeLabel ?? `${name}Before`);
      if (page.after) add(page.after, page.afterLabel ?? `${name}After`);
    });
    for (const item of listedItems(card.items)) {
      if (item.kind === 'file') add(item.file, itemName(item));
    }
    for (const { shot, label } of testShots(card.test)) add(shot, label);
  }
  for (const file of message.attachments ?? []) add(file, file.name);
  return out;
}

/** Every picture in the chat, oldest first, each once. */
export function galleryOf(messages: readonly Message[]): GalleryImage[] {
  const out: GalleryImage[] = [];
  const seen = new Set<string>();
  for (const message of messages) {
    for (const image of messageImages(message)) {
      if (seen.has(image.key)) continue;
      seen.add(image.key);
      out.push(image);
    }
  }
  return out;
}

/** Where the gallery opens for the picture the user pressed: 0 when it isn't there. */
export function galleryStart(
  gallery: readonly GalleryImage[],
  agentId: string,
  path: string
): number {
  const at = gallery.findIndex((g) => g.key === galleryKey(agentId, path));
  return at < 0 ? 0 : at;
}

/** "3 of 8"; nothing for a gallery of one. */
export function galleryCounter(index: number, total: number): string | null {
  if (total < 2) return null;
  return `${Math.min(Math.max(index, 0), total - 1) + 1} of ${total}`;
}

/** The index after a step of `delta`, held to the ends (no wrap). */
export function galleryStep(index: number, delta: number, total: number): number {
  if (total < 1) return 0;
  return Math.min(Math.max(index + delta, 0), total - 1);
}
