/**
 * An agent's avatar: a key cap in its colour (docs/internal/avatars.md). One
 * of four even shapes, raised like a key (a darker side, a lit top, a soft
 * shadow), flat below 24px, with a face on the top. Drawn from the spec the
 * phone draws from (`packages/companion-protocol/src/avatar.ts`), so the
 * geometry, the palette (equal OKLCH per theme) and the motion are one thing.
 *
 * The one SVG here is the design system's marked dynamic exception
 * (`data-dynamic-svg="agent-avatar"`): it's assembled from data at runtime,
 * not static artwork, which is what `src/assets/graphics/` holds.
 *
 * Motion says what the agent is doing, in CSS keyframes only (no per-frame
 * JS; agents-avatar.css): idle drift, looking around while it works, looking
 * out at you when it needs you, one press when it's done, a look down when
 * it failed. The eyes never close and nothing rings it. Paused off-screen and
 * while the window is hidden; nothing at all with Reduce Motion.
 *
 * @module components/agents/AgentAvatar
 */

import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type ReactNode,
} from 'react';
import {
  AVATAR_MOTION,
  DEBOSS_DEPTH,
  FACE_SPECS,
  KEY,
  LIT_MIN_PX,
  MONOGRAM,
  MOUTH_MIN_PX,
  SHAPE_PATHS,
  TOP_TRANSFORM,
  avatarPaint,
  eyeAt,
  faceWeight,
  idlePhase,
  isPressed,
  lookFor,
  monogramLetter,
  rimBlur,
  type AgentLook,
  type AvatarMood,
  type AvatarPaint,
} from '../../../packages/companion-protocol/src/avatar';
import { getAgentsSnapshot, subscribeAgents } from '../../lib/agentsStore';
import { useResolvedTheme } from '../../lib/theme';

/**
 * "Chief of Staff" → "CS", "Finance" → "FI", "Acme Site" → "AS". A number
 * keeps its digits ("Agent 3" → "A3", "Agent 12" → "12"), so a numbered run
 * of agents doesn't collapse onto one badge. (Rooms still use initials.)
 */
export function agentInitials(name: string): string {
  // Only letters and digits make initials: "Finance (from Grok)" is
  // "Finance", never "F(". A trailing aside in brackets is dropped.
  const words = name
    .replace(/\s*[([{].*$/u, '')
    .trim()
    .split(/[^\p{L}\p{N}&]+/u)
    .filter(
      (w) => /[A-Za-z0-9]/.test(w) && !['of', 'the', 'and', 'for', '&'].includes(w.toLowerCase())
    );
  const number = words.length >= 2 ? words[words.length - 1] : '';
  if (/^\d+$/.test(number)) {
    return number.length >= 2 ? number.slice(-2) : (words[0][0] + number).toUpperCase();
  }
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
  const word = words[0] ?? name.trim();
  return word.slice(0, 2).toUpperCase();
}

/** The first letter and the next consonant: "Client Sites QA" → "CL". */
function consonantInitials(name: string): string {
  const letters = name.replace(/[^A-Za-z0-9]/g, '');
  const next = letters.slice(1).match(/[b-df-hj-np-tv-z0-9]/i)?.[0] ?? letters[1] ?? '';
  return (letters[0] + next).toUpperCase();
}

/**
 * Initials that don't collide with an agent listed before this one
 * (`names`, in creation order, the Chief first): "Chief of Staff" keeps "CS"
 * and "Client Sites QA" becomes "CL". A name not in the list (one being
 * typed) gives way to all of them.
 */
export function distinctInitials(name: string, names: string[]): string {
  const own = agentInitials(name);
  const index = names.indexOf(name);
  const before = index === -1 ? names : names.slice(0, index);
  return before.some((n) => n !== name && agentInitials(n) === own) ? consonantInitials(name) : own;
}

/**
 * Every agent's saved look, as one string, so a streaming reply (which
 * updates the store every few frames) never re-renders an avatar.
 */
const teamLooks = () =>
  getAgentsSnapshot()
    .agents.map(
      (a) =>
        `${a.id}\t${a.isMain ? 1 : 0}\t${a.avatar?.shape ?? ''}\t${a.avatar?.face ?? ''}\t${
          a.avatar?.finish ?? ''
        }`
    )
    .join('\n');

function lookFromTeam(team: string, id: string): Required<AgentLook> | null {
  for (const line of team.split('\n')) {
    const [lineId, main, shape, face, finish] = line.split('\t');
    if (lineId !== id) continue;
    return lookFor({ id, isMain: main === '1', avatar: { shape, face, finish } });
  }
  return null;
}

/** Each size step's width, for the weight and whether the key is lit (the CSS owns the box). */
const SIZE_PX = { xs: 16, mini: 18, row: 24, field: 24, md: 40, hero: 46, lg: 48, xl: 96 } as const;
export type AgentAvatarSize = keyof typeof SIZE_PX;

interface AgentAvatarProps {
  /** Seeds the look of an agent that isn't in the registry (an import preview); the monogram's letter. */
  name: string;
  color: string;
  /** Its id: the look comes from the registry, or is derived from the id. */
  id?: string;
  /** An explicit look (the picker's preview, a proposed change). */
  look?: AgentLook;
  /**
   * `xs` sits in a line of text (16px), `mini` leads a menu item or a
   * mention (18px), `row` is the sidebar's
   * (a project badge's size, 24px), `field` sits beside a text field, `hero`
   * heads an empty chat (`md` is 40px), `xl` is the picker's preview (96px).
   */
  size?: AgentAvatarSize;
  /** Solid, for the agent you're looking at (like the current project's badge). */
  selected?: boolean;
  /** What it's doing (`moodOf`). Done is noticed here (working, then idle); given, it plays once. */
  mood?: AvatarMood;
  /** Shorthand for `mood="working"`. */
  working?: boolean;
  /** Holds still whatever it's doing: a choice in the look picker. */
  still?: boolean;
  className?: string;
}

export function AgentAvatar({
  name,
  color,
  id,
  look: given,
  size = 'row',
  selected = false,
  mood: givenMood,
  working = false,
  still = false,
  className,
}: AgentAvatarProps) {
  const team = useSyncExternalStore(subscribeAgents, teamLooks);
  const look = useMemo(
    () =>
      given
        ? lookFor({ id: id ?? `name:${name}`, avatar: given })
        : ((id ? lookFromTeam(team, id) : null) ?? lookFor({ id: id ?? `name:${name}` })),
    [given, id, team, name]
  );
  const theme = useResolvedTheme();
  const px = SIZE_PX[size];
  const mood = useMood(givenMood ?? (working ? 'working' : 'idle'));
  const ref = useOffscreen<HTMLSpanElement>(!still);
  const uid = useId().replace(/[^a-zA-Z0-9]/g, '');
  const paint = avatarPaint(color, theme, selected);
  const lit = px >= LIT_MIN_PX;
  const cap = lit && look.finish === 'keycap';
  const shape = SHAPE_PATHS[look.shape];
  const rim = cap ? KEY.capRim : KEY.embossRim(px);
  const ids = { grad: `${uid}g`, rim: `${uid}r`, glow: `${uid}w`, shadow: `${uid}s` };
  const top = cap ? TOP_TRANSFORM : undefined;
  // Computed per agent: where in the idle loop it starts, so twelve never drift in step.
  const phase = { '--agent-avatar-phase': `-${id ? idlePhase(id) : 0}ms` } as CSSProperties;
  return (
    <span
      ref={ref}
      className={`agent-avatar agent-avatar--${size}${selected ? ' agent-avatar--selected' : ''}${
        className ? ` ${className}` : ''
      }`}
      data-color={color}
      data-shape={look.shape}
      data-face={look.face}
      data-finish={look.finish}
      data-lit={lit || undefined}
      data-cap={cap || undefined}
      data-mood={still ? undefined : mood}
      style={phase}
      aria-hidden
    >
      {/* Layers, so each moving part is its own composited box: the key's
          shadow and side; its top, pressed as one (`__key`); the light that
          breathes; the face, which looks around. */}
      {cap && (
        <Layer>
          <defs>
            <filter id={ids.shadow} x="-20%" y="-20%" width="140%" height="150%">
              <feGaussianBlur stdDeviation={KEY.shadow.blur} />
            </filter>
          </defs>
          <path
            d={shape}
            transform={`translate(0 ${KEY.shadow.dy})`}
            fill="black"
            opacity={paint.shadow}
            filter={`url(#${ids.shadow})`}
          />
          <path d={shape} fill={paint.side} />
        </Layer>
      )}
      <span className="agent-avatar__key">
        <Layer>
          {lit ? (
            <>
              <defs>
                <linearGradient id={ids.grad} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0" stopColor={paint.topHigh} />
                  <stop offset="1" stopColor={paint.topLow} />
                </linearGradient>
                <RimFilter id={ids.rim} depth={rim} paint={paint} />
              </defs>
              <path
                d={shape}
                transform={top}
                fill={`url(#${ids.grad})`}
                filter={`url(#${ids.rim})`}
              />
            </>
          ) : (
            <path d={shape} fill={paint.fill} />
          )}
        </Layer>
        {lit && (
          <Layer className="agent-avatar__glow">
            <defs>
              <RimFilter id={ids.glow} depth={rim} paint={paint} lightOnly />
            </defs>
            <path d={shape} transform={top} fill="black" filter={`url(#${ids.glow})`} />
          </Layer>
        )}
        <span className="agent-avatar__face">
          <Layer>
            <g transform={top}>
              <Face look={look} name={name} px={px} paint={paint} selected={selected} />
            </g>
          </Layer>
        </span>
      </span>
    </span>
  );
}

/** One layer of the drawing, on the 32-unit grid. */
function Layer({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <svg
      data-dynamic-svg="agent-avatar"
      className={`agent-avatar__art${className ? ` ${className}` : ''}`}
      viewBox="0 0 32 32"
      focusable="false"
    >
      {children}
    </svg>
  );
}

/**
 * Light on the top rim and shade on the bottom one, inside the shape only:
 * the shape's own alpha, offset and cut away, blurred, flooded white or
 * black. `lightOnly` is the extra light that breathes while it works.
 */
function RimFilter({
  id,
  depth,
  paint,
  lightOnly = false,
}: {
  id: string;
  depth: number;
  paint: AvatarPaint;
  lightOnly?: boolean;
}) {
  const blur = rimBlur(depth);
  return (
    <filter id={id} x="-10%" y="-10%" width="120%" height="120%">
      <feOffset in="SourceAlpha" dy={depth} result="dn" />
      <feComposite in="SourceAlpha" in2="dn" operator="out" result="top" />
      <feGaussianBlur in="top" stdDeviation={blur.light} result="topb" />
      <feFlood floodColor="white" floodOpacity={paint.rimLight} />
      <feComposite in2="topb" operator="in" result="hl" />
      {lightOnly ? (
        <feComposite in="hl" in2="SourceAlpha" operator="in" />
      ) : (
        <>
          <feOffset in="SourceAlpha" dy={-depth} result="up" />
          <feComposite in="SourceAlpha" in2="up" operator="out" result="bot" />
          <feGaussianBlur in="bot" stdDeviation={blur.shade} result="botb" />
          <feFlood floodColor="black" floodOpacity={paint.rimShade} />
          <feComposite in2="botb" operator="in" result="sh" />
          <feMerge result="all">
            <feMergeNode in="SourceGraphic" />
            <feMergeNode in="hl" />
            <feMergeNode in="sh" />
          </feMerge>
          <feComposite in="all" in2="SourceAlpha" operator="in" />
        </>
      )}
    </filter>
  );
}

/** The face on the top: drawn on in the ink, or pressed in as wells with a light lip. */
function Face({
  look,
  name,
  px,
  paint,
  selected,
}: {
  look: Required<AgentLook>;
  name: string;
  px: number;
  paint: AvatarPaint;
  selected: boolean;
}) {
  const spec = FACE_SPECS[look.face];
  const pressed = isPressed(look.face, px, selected);
  const ink = paint.ink ?? 'var(--surface-app)';
  const fill = pressed ? paint.well : ink;
  const lip = `rgba(255, 255, 255, ${paint.lip})`;
  const d = pressed ? DEBOSS_DEPTH : 0;
  if (spec.monogram) {
    const letter = monogramLetter(name);
    const text = (color: string, dy: number) => (
      <text
        className="agent-avatar__letter"
        x={MONOGRAM.x}
        y={MONOGRAM.y + dy}
        textAnchor="middle"
        fontWeight={MONOGRAM.weight}
        fontSize={MONOGRAM.size}
        fill={color}
      >
        {letter}
      </text>
    );
    return (
      <>
        {d > 0 && text(lip, d)}
        {text(fill, 0)}
      </>
    );
  }
  const w = faceWeight(px);
  const eyes = spec.eyes.map((e) => eyeAt(e, px));
  const mouth = spec.mouth && px > MOUTH_MIN_PX ? spec.mouth : null;
  const stroke = (path: string, color: string, dy: number) => (
    <path
      d={path}
      transform={dy ? `translate(0 ${dy})` : undefined}
      fill="none"
      stroke={color}
      strokeWidth={w}
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  );
  return (
    <>
      {eyes.map((e) => (
        <g key={e.cx}>
          {d > 0 && <ellipse cx={e.cx} cy={e.cy + d} rx={e.rx} ry={e.ry} fill={lip} />}
          <ellipse cx={e.cx} cy={e.cy} rx={e.rx} ry={e.ry} fill={fill} />
        </g>
      ))}
      {mouth && d > 0 && stroke(mouth, lip, d)}
      {mouth && stroke(mouth, fill, 0)}
    </>
  );
}

/**
 * The mood to show: the one given, except that working then idle is done
 * for one press. Noticed while rendering (the previous value kept in state),
 * cleared by a timer once the press has played.
 */
function useMood(mood: AvatarMood): AvatarMood {
  const [was, setWas] = useState(mood);
  const [done, setDone] = useState(false);
  if (was !== mood) {
    setWas(mood);
    setDone(was === 'working' && mood === 'idle');
  }
  useEffect(() => {
    if (!done) return;
    const t = window.setTimeout(() => setDone(false), AVATAR_MOTION.done.ms);
    return () => window.clearTimeout(t);
  }, [done]);
  return done ? 'done' : mood;
}

/**
 * Off-screen avatars hold still: one observer for all of them marks each
 * one's element (`data-offscreen`), and the CSS pauses its animations. A
 * hidden window pauses every one (`data-avatars-hidden` on the root).
 */
let observer: IntersectionObserver | null = null;
function watch(el: Element): () => void {
  if (typeof IntersectionObserver === 'undefined') return () => {};
  observer ??= new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (e.isIntersecting) e.target.removeAttribute('data-offscreen');
      else e.target.setAttribute('data-offscreen', '');
    }
  });
  observer.observe(el);
  return () => observer?.unobserve(el);
}

if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () =>
    document.documentElement.toggleAttribute('data-avatars-hidden', document.hidden)
  );
}

function useOffscreen<T extends Element>(enabled: boolean) {
  const ref = useRef<T>(null);
  useEffect(() => {
    if (!enabled || !ref.current) return;
    return watch(ref.current);
  }, [enabled]);
  return ref;
}
