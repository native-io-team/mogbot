/**
 * One picture in the lightbox, inspectable: ⌘+ / ⌘− / ⌘0, a trackpad pinch
 * (ctrl+wheel, or WebKit's own gesture events), a click to go between fit and
 * the picture's own pixels at the point clicked, a drag (or a two-finger
 * scroll) to move around it while zoomed, and − / 100% / + / Fit below it.
 *
 * At fit it hands every other wheel on, so a sideways swipe still turns the
 * page. The maths is `lib/imageZoom`; this only measures and draws. It shows
 * what `AttachmentImage` shows: a local attachment, nothing else.
 *
 * @module components/agents/AgentLightboxZoom
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { Button } from '../primitives/Button';
import { kbd } from '../../lib/shortcuts';
import {
  FIT_VIEW,
  actualScale,
  clampView,
  fitSize,
  isZoomed,
  maxScale,
  panView,
  stepScale,
  toggleView,
  wheelScale,
  zoomAround,
  zoomPercent,
  type Point,
  type Size,
  type ZoomView,
} from '../../lib/imageZoom';
import type { Agent, Attachment } from '../../lib/agents';
import { AttachmentImage } from './AgentAttachments';

/** A press that moves less than this is a click, not a drag. */
const CLICK_SLOP_PX = 4;
const LINE_HEIGHT_PX = 16;
/** A wheel or pinch with no event for this long has settled. */
const SETTLE_MS = 150;

/** The image's size and place for a view (state renders it; gestures write it). */
function imageStyleOf(view: ZoomView, fit: Size) {
  return {
    width: `${fit.width * view.scale}px`,
    height: `${fit.height * view.scale}px`,
    maxWidth: 'none',
    maxHeight: 'none',
    transform: `translate(calc(-50% + ${view.x}px), calc(-50% + ${view.y}px))`,
  };
}

interface GestureLikeEvent extends Event {
  scale: number;
  clientX: number;
  clientY: number;
}

export function ZoomableImage({
  agent,
  attachment,
}: {
  agent: Pick<Agent, 'home'>;
  attachment: Attachment;
}) {
  const stageRef = useRef<HTMLDivElement>(null);
  const [stage, setStage] = useState<Size>({ width: 0, height: 0 });
  const [natural, setNatural] = useState<Size | null>(null);
  const [view, setView] = useState<ZoomView>(FIT_VIEW);
  const [dragging, setDragging] = useState(false);

  useLayoutEffect(() => {
    const node = stageRef.current;
    if (!node) return;
    const measure = () => setStage({ width: node.clientWidth, height: node.clientHeight });
    measure();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure);
      return () => window.removeEventListener('resize', measure);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const ready = natural !== null && stage.width > 0 && stage.height > 0;
  const fit = ready ? fitSize(natural, stage) : stage;
  const max = ready ? maxScale(natural, fit) : 1;
  const zoomed = isZoomed(view);

  // Read by the listeners, which are registered once.
  const live = useRef({ ready, natural, stage, fit, max });
  useEffect(() => {
    live.current = { ready, natural, stage, fit, max };
  });

  // Where the picture is now. During a wheel, pinch or drag it runs ahead
  // of `view`: written straight to the image once per animation frame, and
  // committed to state (the readout, the buttons) when the gesture settles.
  const current = useRef<ZoomView>(view);
  const frame = useRef<number | null>(null);
  const settleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cancelPending = useCallback(() => {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null;
    if (settleTimer.current !== null) clearTimeout(settleTimer.current);
    settleTimer.current = null;
  }, []);

  /** A discrete change (a key, a button, a click): straight to state. */
  const setNow = useCallback(
    (next: (v: ZoomView) => ZoomView) => {
      cancelPending();
      current.current = next(current.current);
      setView(current.current);
    },
    [cancelPending]
  );

  /** Where the gesture has got to becomes the view. */
  const commit = useCallback(() => setNow((v) => v), [setNow]);

  /** A step of a gesture: drawn on the next frame, committed once it settles. */
  const moveLive = useCallback(
    (next: (v: ZoomView) => ZoomView, settle: 'later' | 'on-release') => {
      current.current = next(current.current);
      if (frame.current === null) {
        frame.current = requestAnimationFrame(() => {
          frame.current = null;
          const img = stageRef.current?.querySelector('img');
          const { fit } = live.current;
          if (img) Object.assign(img.style, imageStyleOf(current.current, fit));
        });
      }
      if (settle === 'later') {
        if (settleTimer.current !== null) clearTimeout(settleTimer.current);
        settleTimer.current = setTimeout(commit, SETTLE_MS);
      }
    },
    [commit]
  );

  useEffect(() => cancelPending, [cancelPending]);

  // A resize keeps the picture inside its new bounds.
  useEffect(() => {
    if (ready) setNow((v) => clampView(v, fit, stage));
    // fit follows from stage and natural.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, stage.width, stage.height, natural?.width, natural?.height]);

  /** A point on screen, relative to the stage's centre. */
  const focalOf = useCallback((clientX: number, clientY: number): Point => {
    const box = stageRef.current?.getBoundingClientRect();
    if (!box) return { x: 0, y: 0 };
    return { x: clientX - box.left - box.width / 2, y: clientY - box.top - box.height / 2 };
  }, []);

  /**
   * Zoom to the scale `next` picks from the current one, holding `focal`
   * still: at once, or as a step of a gesture.
   */
  const zoomWith = useCallback(
    (
      next: (scale: number, max: number) => number,
      focal: Point = { x: 0, y: 0 },
      gesture = false
    ) => {
      const { ready, fit, stage, max } = live.current;
      if (!ready) return;
      const to = (v: ZoomView) => zoomAround(v, next(v.scale, max), focal, fit, stage, max);
      if (gesture) moveLive(to, 'later');
      else setNow(to);
    },
    [moveLive, setNow]
  );

  const step = useCallback(
    (direction: 'in' | 'out') => zoomWith((scale, max) => stepScale(scale, direction, max)),
    [zoomWith]
  );

  const toActual = useCallback(() => {
    const { ready, natural, fit } = live.current;
    if (ready && natural) zoomWith(() => actualScale(natural, fit));
  }, [zoomWith]);

  // ⌘+ / ⌘− / ⌘0, ahead of anything else listening (the canvas has the same keys).
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey) return;
      let handled = true;
      if (event.key === '=' || event.key === '+') step('in');
      else if (event.key === '-' || event.key === '_') step('out');
      else if (event.key === '0') setNow(() => FIT_VIEW);
      else handled = false;
      if (handled) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [step, setNow]);

  // Wheel and pinch, non-passive so the app window never zooms or scrolls instead.
  useEffect(() => {
    const node = stageRef.current;
    if (!node) return;
    const onWheel = (event: WheelEvent) => {
      const { ready, fit, stage } = live.current;
      if (!ready) return;
      if (event.ctrlKey || event.metaKey) {
        event.preventDefault();
        event.stopPropagation();
        const { deltaY } = event;
        zoomWith(
          (scale, max) => wheelScale(scale, deltaY, max),
          focalOf(event.clientX, event.clientY),
          true
        );
        return;
      }
      // At fit a wheel is the gallery's (a sideways swipe turns the page).
      if (!isZoomed(current.current)) return;
      event.preventDefault();
      event.stopPropagation();
      const factor = event.deltaMode === 1 ? LINE_HEIGHT_PX : 1;
      const dx = -event.deltaX * factor;
      const dy = -event.deltaY * factor;
      moveLive((v) => panView(v, dx, dy, fit, stage), 'later');
    };
    let gestureScale = 1;
    const onGestureStart = (event: GestureLikeEvent) => {
      event.preventDefault();
      gestureScale = event.scale || 1;
    };
    const onGestureChange = (event: GestureLikeEvent) => {
      event.preventDefault();
      const now = event.scale || 1;
      const factor = gestureScale > 0 ? now / gestureScale : 1;
      gestureScale = now;
      zoomWith((scale) => scale * factor, focalOf(event.clientX, event.clientY), true);
    };
    const onGestureEnd = (event: GestureLikeEvent) => {
      event.preventDefault();
      gestureScale = 1;
      commit();
    };
    node.addEventListener('wheel', onWheel, { passive: false });
    node.addEventListener('gesturestart', onGestureStart as EventListener, { passive: false });
    node.addEventListener('gesturechange', onGestureChange as EventListener, { passive: false });
    node.addEventListener('gestureend', onGestureEnd as EventListener, { passive: false });
    return () => {
      node.removeEventListener('wheel', onWheel);
      node.removeEventListener('gesturestart', onGestureStart as EventListener);
      node.removeEventListener('gesturechange', onGestureChange as EventListener);
      node.removeEventListener('gestureend', onGestureEnd as EventListener);
    };
  }, [focalOf, zoomWith, commit, moveLive]);

  // A press: a drag pans (zoomed), a click toggles fit ↔ 100%.
  const press = useRef<{ x: number; y: number; view: ZoomView; moved: boolean } | null>(null);
  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || !ready) return;
    // A wheel still settling is where this press starts from.
    commit();
    press.current = { x: event.clientX, y: event.clientY, view: current.current, moved: false };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const start = press.current;
    if (!start) return;
    const dx = event.clientX - start.x;
    const dy = event.clientY - start.y;
    if (!start.moved && Math.hypot(dx, dy) < CLICK_SLOP_PX) return;
    start.moved = true;
    if (!isZoomed(start.view)) return;
    setDragging(true);
    moveLive(() => panView(start.view, dx, dy, fit, stage), 'on-release');
  };
  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    const start = press.current;
    press.current = null;
    setDragging(false);
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    if (!start || start.moved || !natural) {
      commit();
      return;
    }
    setNow((v) => toggleView(v, focalOf(event.clientX, event.clientY), natural, fit, stage));
  };

  const percent = ready ? zoomPercent(view, natural, fit) : 100;
  const imageStyle = ready ? imageStyleOf(view, fit) : undefined;

  return (
    <div className="agent-lightbox__zoom">
      <div
        ref={stageRef}
        className="agent-lightbox__viewport"
        data-zoomed={zoomed || undefined}
        data-dragging={dragging || undefined}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => {
          press.current = null;
          setDragging(false);
          commit();
        }}
        onDragStart={(event) => event.preventDefault()}
        title={zoomed ? undefined : 'Click to see it at full size'}
      >
        <AttachmentImage
          agent={agent}
          attachment={attachment}
          className="agent-lightbox__image"
          style={imageStyle}
          onLoad={setNatural}
        />
      </div>
      {ready && (
        <div className="agent-lightbox__zoom-bar" role="group" aria-label="Zoom">
          <Button
            size="compact"
            variant="ghost"
            onClick={() => step('out')}
            disabled={!zoomed}
            title={`Zoom out (${kbd('mod', '-')})`}
            aria-label="Zoom out"
          >
            &minus;
          </Button>
          <Button
            size="compact"
            variant="ghost"
            className="agent-lightbox__zoom-readout"
            onClick={toActual}
            title="Zoom to 100%"
          >
            {percent}%
          </Button>
          <Button
            size="compact"
            variant="ghost"
            onClick={() => step('in')}
            disabled={view.scale >= max}
            title={`Zoom in (${kbd('mod', '+')})`}
            aria-label="Zoom in"
          >
            +
          </Button>
          <Button
            size="compact"
            variant={zoomed ? 'ghost' : 'secondary'}
            onClick={() => setNow(() => FIT_VIEW)}
            aria-pressed={!zoomed}
            title={`Fit (${kbd('mod', '0')})`}
          >
            Fit
          </Button>
        </div>
      )}
    </div>
  );
}
