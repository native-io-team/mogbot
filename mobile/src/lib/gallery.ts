/**
 * The photo viewer is a gallery of every picture in the chat
 * (`galleryOf`, shared with the desk): a chat provides its pictures, and
 * opening one hands the viewer the whole list, starting at that picture.
 *
 * A route's params should stay small, so the list itself waits here, under
 * an id the viewer is given; only the newest few are kept.
 */

import {
  galleryOf,
  galleryStart,
  type AgentMessage,
  type GalleryImage,
} from '@shipstudio/companion-protocol';
import { createContext, useContext } from 'react';

/** The pictures of the chat being drawn; empty outside a chat. */
export const GalleryContext = createContext<readonly GalleryImage[]>([]);

export const useChatGallery = () => useContext(GalleryContext);

/** A chat's pictures, oldest first, whatever order its messages are held in. */
export function chatGallery(messages: readonly AgentMessage[]): GalleryImage[] {
  return galleryOf([...messages].sort((a, b) => a.ts - b.ts));
}

const KEEP = 4;
const kept = new Map<string, GalleryImage[]>();
let next = 0;

/** Keep a gallery for the viewer: its id. */
export function putGallery(images: readonly GalleryImage[]): string {
  const id = `g${++next}`;
  kept.set(id, [...images]);
  while (kept.size > KEEP) kept.delete(kept.keys().next().value as string);
  return id;
}

export function getGallery(id: string | undefined): GalleryImage[] | undefined {
  return id ? kept.get(id) : undefined;
}

/**
 * The viewer's route for a picture in a chat: the gallery's id when the
 * picture is in it, so the viewer opens on it and pages to the others.
 */
export function viewerParams(
  gallery: readonly GalleryImage[],
  agentId: string,
  file: { path: string; name: string; mime: string },
  /** The width the chat drew it at, so the viewer opens on that same thumbnail. */
  thumbWidth?: number
): Record<string, string> {
  const base: Record<string, string> = {
    agentId,
    path: file.path,
    name: file.name,
    mime: file.mime,
  };
  if (thumbWidth && thumbWidth > 0) base.thumb = String(Math.round(thumbWidth));
  const at = gallery.findIndex((g) => g.agentId === agentId && g.file.path === file.path);
  if (at < 0 || gallery.length < 2) return base;
  return { ...base, gallery: putGallery(gallery) };
}

/** Where the viewer starts: the picture it was opened on. */
export function viewerStart(images: readonly GalleryImage[], agentId?: string, path?: string) {
  return agentId && path ? galleryStart(images, agentId, path) : 0;
}
