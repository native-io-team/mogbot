/**
 * Standalone harness surface for agent avatars (docs/internal/avatars.md):
 * every shape and face at 16 / 24 / 40 / 96px, the colours, and the motion
 * states, in either theme and any of the three directions considered.
 *
 *   harness-avatars.html?theme=light&avatarDirection=solid&section=sizes
 *
 * Served only by `vite.harness.config.ts`. The real component and the real
 * stylesheet; nothing here is a mock-up.
 */

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { AgentAvatar, type AgentAvatarSize } from '../components/agents/AgentAvatar';
import {
  AVATAR_FACES,
  AVATAR_SHAPES,
  FACE_NAMES,
  SHAPE_NAMES,
  type AgentLook,
} from '../../packages/companion-protocol/src/avatar';
import { AGENT_COLORS } from '../lib/agents';
import '../styles/index.css';
import './freeze.css';
import './avatarDirections.css';
import './avatarGallery.css';

const params = new URLSearchParams(window.location.search);
const theme = params.get('theme') === 'light' ? 'light' : 'dark';
const direction = params.get('avatarDirection') ?? 'tonal';
const section = params.get('section') ?? 'all';
document.documentElement.dataset.theme = theme;
document.documentElement.dataset.avatarDirection = direction;
if (params.get('freeze') !== 'off') {
  document.documentElement.setAttribute('data-harness-freeze', '');
}
document.title = 'Avatars harness';

const SIZES: [AgentAvatarSize, string][] = [
  ['xs', '16'],
  ['row', '24'],
  ['md', '40'],
  ['xl', '96'],
];
const PALETTE = [
  'green',
  'orange',
  'teal',
  'amber',
  'pink',
  'red',
  'blue',
  'purple',
  'white',
  'brown',
];

function Sizes() {
  return (
    <section className="avatar-gallery__section" data-section="sizes">
      <h2>Every shape at 16, 24, 40 and 96px</h2>
      <div className="avatar-gallery__sizes">
        {AVATAR_SHAPES.map((shape, i) => {
          const look: AgentLook = { shape, face: AVATAR_FACES[i % AVATAR_FACES.length] };
          const color = PALETTE[i % PALETTE.length];
          return (
            <div key={shape} className="avatar-gallery__size-row">
              {SIZES.map(([size]) => (
                <AgentAvatar key={size} name={shape} color={color} look={look} size={size} />
              ))}
              <span className="avatar-gallery__caption">
                {SHAPE_NAMES[shape]} · {FACE_NAMES[look.face]}
              </span>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function Faces() {
  return (
    <section className="avatar-gallery__section" data-section="faces">
      <h2>Every face on every shape (40px), and at 24px</h2>
      <div className="avatar-gallery__grid">
        <span />
        {AVATAR_FACES.map((f) => (
          <span key={f} className="avatar-gallery__caption">
            {FACE_NAMES[f]}
          </span>
        ))}
        {AVATAR_SHAPES.map((shape, i) => (
          <Row key={shape} label={SHAPE_NAMES[shape]}>
            {AVATAR_FACES.map((face) => (
              <AgentAvatar
                key={face}
                name={face}
                color={PALETTE[i % PALETTE.length]}
                look={{ shape, face }}
                size="md"
              />
            ))}
          </Row>
        ))}
        <Row label="24px">
          {AVATAR_FACES.map((face, i) => (
            <AgentAvatar
              key={face}
              name={face}
              color={PALETTE[i % PALETTE.length]}
              look={{ shape: AVATAR_SHAPES[i % AVATAR_SHAPES.length], face }}
              size="row"
            />
          ))}
        </Row>
        <Row label="16px">
          {AVATAR_FACES.map((face, i) => (
            <AgentAvatar
              key={face}
              name={face}
              color={PALETTE[i % PALETTE.length]}
              look={{ shape: AVATAR_SHAPES[i % AVATAR_SHAPES.length], face }}
              size="xs"
            />
          ))}
        </Row>
      </div>
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

function Colors() {
  return (
    <section className="avatar-gallery__section" data-section="colors">
      <h2>Every colour, at rest and selected (40px), and working (24px, frozen)</h2>
      <div className="avatar-gallery__colors">
        {AGENT_COLORS.map((color, i) => {
          const look: AgentLook = {
            shape: AVATAR_SHAPES[i % AVATAR_SHAPES.length],
            face: AVATAR_FACES[(i * 3) % AVATAR_FACES.length],
          };
          return (
            <div key={color} className="avatar-gallery__color">
              <AgentAvatar name={color} color={color} look={look} size="md" />
              <AgentAvatar name={color} color={color} look={look} size="md" selected />
              <AgentAvatar name={color} color={color} look={look} size="row" working />
              <span className="avatar-gallery__caption">{color}</span>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function Gallery() {
  return (
    <main className="avatar-gallery" data-direction={direction}>
      <header className="avatar-gallery__head">
        Direction: <strong>{direction}</strong> · {theme}
      </header>
      {(section === 'all' || section === 'sizes') && <Sizes />}
      {(section === 'all' || section === 'faces') && <Faces />}
      {(section === 'all' || section === 'colors') && <Colors />}
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
