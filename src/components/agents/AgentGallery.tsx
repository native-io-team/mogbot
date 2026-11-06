/**
 * The full-size image viewer as a gallery: every picture in the chat
 * (`galleryOf`, shared with the phone), in the order the chat shows them.
 * Opening one starts at it; ← / → (keys, the buttons, a sideways trackpad
 * swipe at fit) step through the rest; Esc closes. Each picture zooms on its
 * own (`AgentLightboxZoom`): ⌘+ / ⌘− / ⌘0, pinch, click for 100%, drag to pan.
 *
 * The chat provides the gallery (`AgentGalleryProvider`); anything drawn
 * outside one (the preview pane, a card in isolation) falls back to the
 * pictures it was given itself, so a viewer always opens.
 *
 * @module components/agents/AgentGallery
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type WheelEvent,
} from 'react';
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  ExternalLinkIcon,
  FolderOpenIcon,
} from '@/components/icons';
import { Button } from '../primitives/Button';
import { IconButton } from '../primitives/IconButton';
import { ModalFrame } from '../primitives/ModalFrame';
import {
  galleryCounter,
  galleryOf,
  galleryStart,
  galleryStep,
  messageImages,
  type Agent,
  type AgentMessage,
  type Attachment,
  type GalleryImage,
} from '../../lib/agents';
import { useAttachmentOpener } from './AgentAttachments';
import { ZoomableImage } from './AgentLightboxZoom';

/** A sideways swipe this long (px of wheel delta) turns the page. */
const SWIPE_PX = 60;
/** After a turn, a trackpad's momentum is ignored this long. */
const SWIPE_COOLDOWN_MS = 450;

interface Opened {
  images: GalleryImage[];
  index: number;
}

interface GalleryApi {
  /** Open at `file`, from the chat's pictures. */
  open: (agentId: string, file: Attachment) => void;
}

const GalleryContext = createContext<GalleryApi | null>(null);

/** Images given in place of a chat's (outside a provider), as gallery entries. */
export function imagesOf(
  agentId: string,
  files: readonly Attachment[],
  captions?: readonly string[]
): GalleryImage[] {
  return messageImages({ id: '', agentId, attachments: [...files] }).map((g, i) =>
    captions?.[i] ? { ...g, caption: captions[i] } : g
  );
}

/** The chat's gallery: holds its messages, draws the one viewer. */
export function AgentGalleryProvider({
  messages,
  agentOf,
  children,
}: {
  messages: readonly AgentMessage[];
  /** The agent whose home a picture lives in. */
  agentOf: (agentId: string) => Pick<Agent, 'id' | 'home'> | undefined;
  children: ReactNode;
}) {
  // Read when a picture is opened, so new messages don't re-render the rows.
  const messagesRef = useRef(messages);
  useEffect(() => {
    messagesRef.current = messages;
  });
  const [opened, setOpened] = useState<Opened | null>(null);
  const open = useCallback((agentId: string, file: Attachment) => {
    const images = galleryOf(messagesRef.current);
    const index = galleryStart(images, agentId, file.path);
    // A picture the chat doesn't hold (a draft's): show it alone.
    if (images[index]?.file.path !== file.path) {
      setOpened({ images: imagesOf(agentId, [file]), index: 0 });
      return;
    }
    setOpened({ images, index });
  }, []);
  const api = useMemo(() => ({ open }), [open]);
  return (
    <GalleryContext.Provider value={api}>
      {children}
      <GalleryLightbox
        opened={opened}
        agentOf={agentOf}
        onIndex={(index) => setOpened((o) => (o ? { ...o, index } : o))}
        onClose={() => setOpened(null)}
      />
    </GalleryContext.Provider>
  );
}

/**
 * Open pictures full size: in the chat's gallery when there is one, else in
 * a viewer over `own` (what this card or message holds). Render `viewer`.
 */
export function useImageViewer(
  agent: Pick<Agent, 'id' | 'home'>,
  own: () => GalleryImage[]
): { view: (file: Attachment) => void; viewer: ReactNode } {
  const ctx = useContext(GalleryContext);
  const [opened, setOpened] = useState<Opened | null>(null);
  const ownRef = useRef(own);
  useEffect(() => {
    ownRef.current = own;
  });
  const view = useCallback(
    (file: Attachment) => {
      if (ctx) {
        ctx.open(agent.id, file);
        return;
      }
      const images = ownRef.current();
      const list = images.some((g) => g.file.path === file.path)
        ? images
        : imagesOf(agent.id, [file]);
      setOpened({ images: list, index: galleryStart(list, agent.id, file.path) });
    },
    [ctx, agent.id]
  );
  const viewer = ctx ? null : (
    <GalleryLightbox
      opened={opened}
      agentOf={() => agent}
      onIndex={(index) => setOpened((o) => (o ? { ...o, index } : o))}
      onClose={() => setOpened(null)}
    />
  );
  return { view, viewer };
}

/** The viewer itself: one picture, its caption, the counter, and the steps. */
export function GalleryLightbox({
  opened,
  agentOf,
  onIndex,
  onClose,
}: {
  opened: Opened | null;
  agentOf: (agentId: string) => Pick<Agent, 'id' | 'home'> | undefined;
  onIndex: (index: number) => void;
  onClose: () => void;
}) {
  const total = opened?.images.length ?? 0;
  const index = opened ? Math.min(opened.index, total - 1) : 0;
  const current = opened?.images[index];
  const owner = current ? agentOf(current.agentId) : undefined;
  const open = useAttachmentOpener(current?.agentId ?? '');

  const go = useCallback(
    (delta: number) => {
      if (!opened) return;
      const next = galleryStep(index, delta, total);
      if (next !== index) onIndex(next);
    },
    [opened, index, total, onIndex]
  );

  useEffect(() => {
    if (!opened || total < 2) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key === 'ArrowLeft') {
        event.preventDefault();
        go(-1);
      } else if (event.key === 'ArrowRight') {
        event.preventDefault();
        go(1);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [opened, total, go]);

  // A sideways two-finger swipe: one page per gesture, momentum ignored.
  const swipe = useRef({ dx: 0, until: 0 });
  const onWheel = (event: WheelEvent<HTMLDivElement>) => {
    if (total < 2 || Math.abs(event.deltaX) <= Math.abs(event.deltaY)) return;
    const now = Date.now();
    if (now < swipe.current.until) return;
    swipe.current.dx += event.deltaX;
    if (Math.abs(swipe.current.dx) >= SWIPE_PX) {
      go(swipe.current.dx > 0 ? 1 : -1);
      swipe.current = { dx: 0, until: now + SWIPE_COOLDOWN_MS };
    }
  };

  const counter = galleryCounter(index, total);
  return (
    <ModalFrame
      isOpen={Boolean(current)}
      onClose={onClose}
      title={current?.caption ?? ''}
      className="agent-lightbox"
      headerActions={
        current && (
          <>
            {counter && (
              <span className="agent-lightbox__counter" aria-live="polite">
                {counter}
              </span>
            )}
            <Button
              variant="ghost"
              size="compact"
              leftIcon={<ExternalLinkIcon size={14} />}
              onClick={() => void open(current.file)}
            >
              Open
            </Button>
            <Button
              variant="ghost"
              size="compact"
              leftIcon={<FolderOpenIcon size={14} />}
              onClick={() => void open(current.file, true)}
            >
              Show in Finder
            </Button>
          </>
        )
      }
    >
      {current && owner && (
        <div className="agent-lightbox__stage" onWheel={onWheel} data-count={total}>
          {total > 1 && (
            <IconButton
              variant="secondary"
              className="agent-lightbox__step agent-lightbox__step--prev"
              icon={<ArrowLeftIcon size={16} />}
              onClick={() => go(-1)}
              disabled={index === 0}
              aria-label="Previous picture"
              title="Previous (←)"
            />
          )}
          <figure className="agent-lightbox__figure">
            {/* Keyed: each picture opens at fit. */}
            <ZoomableImage key={current.key} agent={owner} attachment={current.file} />
            {current.caption !== current.file.name && (
              <figcaption className="agent-lightbox__caption">{current.file.name}</figcaption>
            )}
          </figure>
          {total > 1 && (
            <IconButton
              variant="secondary"
              className="agent-lightbox__step agent-lightbox__step--next"
              icon={<ArrowRightIcon size={16} />}
              onClick={() => go(1)}
              disabled={index === total - 1}
              aria-label="Next picture"
              title="Next (→)"
            />
          )}
        </div>
      )}
    </ModalFrame>
  );
}
