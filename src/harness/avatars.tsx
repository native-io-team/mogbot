/**
 * Standalone harness surface for agent avatars (docs/internal/avatars.md):
 * the key caps, every shape × face in both finishes, the sizes, the colours,
 * and the motion states as frame strips, in either theme.
 *
 *   harness-avatars.html?theme=light&section=sheet
 *   harness-avatars.html?section=states&px=96&freeze=off
 *
 * `section=states` lays each mood out as a strip of frames: the capture
 * script (scripts/avatar-strips.mjs) pauses every animation and sets each
 * frame's own time, so a strip is the motion sampled, not a guess at it.
 *
 * Served only by `vite.harness.config.ts`. The real component and the real
 * stylesheet; nothing here is a mock-up.
 */

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { AgentAvatar, type AgentAvatarSize } from '../components/agents/AgentAvatar';
import {
  AVATAR_FACES,
  AVATAR_FINISHES,
  AVATAR_MOODS,
  AVATAR_MOTION,
  AVATAR_SHAPES,
  BLINK,
  FACE_NAMES,
  FINISH_NAMES,
  SHAPE_NAMES,
  type AgentLook,
  type AvatarMood,
} from '../../packages/companion-protocol/src/avatar';
import { AGENT_COLORS } from '../lib/agents';
import '../styles/index.css';
import './freeze.css';
import './avatarGallery.css';

const params = new URLSearchParams(window.location.search);
const theme = params.get('theme') === 'light' ? 'light' : 'dark';
const section = params.get('section') ?? 'all';
document.documentElement.dataset.theme = theme;
if (params.get('freeze') !== 'off') {
  document.documentElement.setAttribute('data-harness-freeze', '');
}
document.title = 'Avatars harness';

const NAMES = ['Hiring', 'Finance', 'Sales', 'Research'];
const HUES = ['green', 'amber', 'red', 'purple', 'blue', 'teal', 'pink', 'orange'];

function Sheet() {
  return (
    <section className="avatar-gallery__section" data-section="sheet">
      {AVATAR_FINISHES.map((finish) => (
        <div key={finish}>
          <h2>{FINISH_NAMES[finish]}: every shape × face at 48px</h2>
          <div className="avatar-gallery__sheet" data-cols={AVATAR_SHAPES.length + 1}>
            <span />
            {AVATAR_SHAPES.map((s) => (
              <span key={s} className="avatar-gallery__caption">
                {SHAPE_NAMES[s]}
              </span>
            ))}
            {AVATAR_FACES.map((face, fi) => (
              <Row key={face} label={FACE_NAMES[face]}>
                {AVATAR_SHAPES.map((shape, si) => (
                  <AgentAvatar
                    key={shape}
                    name={NAMES[(fi + si) % NAMES.length]}
                    color={HUES[(fi * 4 + si) % HUES.length]}
                    look={{ shape, face, finish }}
                    size="lg"
                    still
                  />
                ))}
              </Row>
            ))}
          </div>
        </div>
      ))}
    </section>
  );
}

const SIZES: [AgentAvatarSize, string][] = [
  ['xs', '16'],
  ['mini', '18'],
  ['row', '24'],
  ['md', '40'],
  ['lg', '48'],
  ['xl', '96'],
];

function Sizes() {
  const looks: AgentLook[] = [
    { shape: 'squircle', face: 'dots' },
    { shape: 'hexagon', face: 'smile' },
    { shape: 'diamond', face: 'debossed', finish: 'embossed' },
  ];
  return (
    <section className="avatar-gallery__section" data-section="sizes">
      <h2>16 · 18 · 24 · 40 · 48 · 96px (flat below 24)</h2>
      <div className="avatar-gallery__sizes">
        {looks.map((look, i) => (
          <div key={i} className="avatar-gallery__size-row">
            {SIZES.map(([size]) => (
              <AgentAvatar
                key={size}
                name="Finance"
                color={HUES[i * 2]}
                look={look}
                size={size}
                still
              />
            ))}
          </div>
        ))}
      </div>
    </section>
  );
}

function Colors() {
  return (
    <section className="avatar-gallery__section" data-section="colors">
      <h2>Every colour at 40px: at rest, selected, embossed</h2>
      <div className="avatar-gallery__colors">
        {AGENT_COLORS.map((color, i) => {
          const look: AgentLook = { shape: AVATAR_SHAPES[i % AVATAR_SHAPES.length], face: 'dots' };
          return (
            <div key={color} className="avatar-gallery__color">
              <AgentAvatar name={color} color={color} look={look} size="md" still />
              <AgentAvatar name={color} color={color} look={look} size="md" selected still />
              <AgentAvatar
                name={color}
                color={color}
                look={{ ...look, finish: 'embossed' }}
                size="md"
                still
              />
              <span className="avatar-gallery__caption">{color}</span>
            </div>
          );
        })}
      </div>
    </section>
  );
}

/** Where each strip samples its mood: a loop across one period, a one-off across its length. */
const STRIP_FRAMES = 8;
function frameTimes(mood: AvatarMood): number[] {
  const { ms, loop } = AVATAR_MOTION[mood];
  const n = STRIP_FRAMES;
  return Array.from({ length: n }, (_, i) => Math.round((ms * i) / (loop ? n : n - 1)));
}

const STATE_LABELS: Record<AvatarMood, string> = {
  idle: 'Idle: a slow drift, an occasional glance',
  working: 'Working: looks left, up, back; the top’s light breathes',
  needs: 'Needs you: one press, then it looks out at you and holds',
  done: 'Done: one press and bounce, then rest',
  failed: 'Failed: one look down to the side, held',
};

function States() {
  const size: AgentAvatarSize = params.get('px') === '96' ? 'xl' : 'lg';
  const look: AgentLook = {
    shape: (params.get('shape') as AgentLook['shape']) ?? 'squircle',
    face: (params.get('face') as AgentLook['face']) ?? 'dots',
  };
  return (
    <section className="avatar-gallery__section" data-section="states">
      {AVATAR_MOODS.map((mood) => (
        <div key={mood} className="avatar-gallery__strip" data-mood-strip={mood}>
          <h2>{STATE_LABELS[mood]}</h2>
          <div className="avatar-gallery__frames">
            {frameTimes(mood).map((t) => (
              <div key={t} className="avatar-gallery__frame" data-frame-ms={t}>
                <AgentAvatar name="Chief" color="blue" look={look} size={size} mood={mood} />
                <span className="avatar-gallery__caption">{(t / 1000).toFixed(2)}s</span>
              </div>
            ))}
          </div>
        </div>
      ))}
    </section>
  );
}

/**
 * One blink as a frame strip at three sizes (24, 48, 96px): every frame is a
 * still avatar whose `data-blinking` the capture script sets, then samples at
 * its own time across the blink's length.
 */
const BLINK_FRAMES = 8;
function Blink() {
  const total = BLINK.closeMs + BLINK.openMs;
  const times = Array.from({ length: BLINK_FRAMES }, (_, i) =>
    Math.round((total * i) / (BLINK_FRAMES - 1))
  );
  const sizes: [string, AgentAvatarSize][] = [
    ['24px', 'row'],
    ['48px', 'lg'],
    ['96px', 'xl'],
  ];
  return (
    <section className="avatar-gallery__section" data-section="blink">
      {sizes.map(([label, size]) => (
        <div key={label} className="avatar-gallery__strip" data-blink-strip={label}>
          <h2>
            Blink at {label}: {total}ms, eyes to {BLINK.closedScale * 100}% and back
          </h2>
          <div className="avatar-gallery__frames">
            {times.map((t) => (
              <div key={t} className="avatar-gallery__frame" data-frame-ms={t}>
                <AgentAvatar
                  name="Chief"
                  color="blue"
                  look={{ shape: 'squircle', face: 'dots' }}
                  size={size}
                  still
                />
                <span className="avatar-gallery__caption">{t}ms</span>
              </div>
            ))}
          </div>
        </div>
      ))}
    </section>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <span className="avatar-gallery__caption">{label}</span>
      {children}
    </>
  );
}

function Gallery() {
  return (
    <main className="avatar-gallery">
      <header className="avatar-gallery__head">Key caps · {theme}</header>
      {(section === 'all' || section === 'sheet') && <Sheet />}
      {(section === 'all' || section === 'sizes') && <Sizes />}
      {(section === 'all' || section === 'colors') && <Colors />}
      {section === 'states' && <States />}
      {section === 'blink' && <Blink />}
    </main>
  );
}

const root = createRoot(document.getElementById('root')!);
if (import.meta.hot) import.meta.hot.dispose(() => root.unmount());
root.render(
  <StrictMode>
    <Gallery />
  </StrictMode>
);
