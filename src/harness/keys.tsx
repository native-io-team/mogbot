/**
 * Standalone harness surface for agent keys (docs/internal/agent-keys.md),
 * laid out like the approved reference (docs/internal/agent-keys-reference.html)
 * so the two can be put side by side: one key in every state at 112px and
 * 30px, in sidebar rows, the independence pips, the fourteen colourways as a
 * board, every legend, and the sizes. Either theme:
 *
 *   harness-keys.html?theme=light
 *   harness-keys.html?theme=dark&freeze=off   (watch the Needs-your-OK pulse)
 *
 * Served only by the harness's Vite server. The real component and the real
 * stylesheet; nothing here is a mock-up.
 */

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { AgentKey, type AgentKeySize } from '../components/agents/AgentKey';
import {
  COLORWAYS,
  INDEPENDENCE_LABEL,
  INDEPENDENCE_LEVELS,
  KEY_ICONS,
  KEY_STATE_LABEL,
  KEY_STATES,
} from '../../packages/companion-protocol/src';
import '../styles/index.css';
import './freeze.css';
import './keyGallery.css';

const params = new URLSearchParams(window.location.search);
document.documentElement.dataset.theme = params.get('theme') === 'light' ? 'light' : 'dark';
if (params.get('freeze') !== 'off') {
  document.documentElement.setAttribute('data-harness-freeze', '');
}
document.title = 'Agent keys harness';

const BOARD: [string, string, string][] = [
  ['blue', 'inbox', 'I'],
  ['orange', 'code', 'C'],
  ['putty', 'search', 'S'],
  ['teal', 'clock', 'R'],
  ['graphite', 'pen', 'W'],
  ['mustard', 'send', 'P'],
  ['pink', 'chat', 'M'],
  ['sage', 'grid', 'D'],
  ['brick', 'megaphone', 'B'],
  ['plum', 'people', 'H'],
  ['navy', 'shield', 'N'],
  ['forest', 'chart', 'F'],
  ['sky', 'globe', 'G'],
  ['lilac', 'mic', 'V'],
];

const DETAIL: Record<string, string> = {
  idle: 'at rest',
  working: 'pressed',
  live: 'legend lit',
  needsOk: 'lit, pulsing, proud',
  paused: 'cap off',
  new: 'empty socket',
};

const SIZES: [AgentKeySize, string][] = [
  ['xl', '112 · the board, the picker'],
  ['lg', '44 · a header'],
  ['md', '30 · a list row'],
  ['sm', '20 · a menu, a mention'],
  ['xs', '16 · a line of text'],
];

const inbox = { name: 'Inbox', colorway: 'blue', icon: 'inbox', boundKey: 'I' } as const;

function Gallery() {
  return (
    <main className="key-gallery">
      <h1>Agent keys</h1>
      <p className="key-gallery__sub">
        One key (Blue · Inbox · bound to I · independence Steady, 2 of 4) in every state.
      </p>

      <h2>112px</h2>
      <div className="key-gallery__row" data-section="states">
        {KEY_STATES.map((s) => (
          <div key={s} className="key-gallery__cell">
            <AgentKey {...inbox} state={s} level="judgement" size="xl" />
            <span className="key-gallery__label">
              {KEY_STATE_LABEL[s]}
              <small>{DETAIL[s]}</small>
            </span>
          </div>
        ))}
      </div>

      <h2>30px (in a list)</h2>
      <div className="key-gallery__row" data-section="small">
        {KEY_STATES.map((s) => (
          <div key={s} className="key-gallery__cell key-gallery__cell--sm">
            <AgentKey {...inbox} state={s} size="md" />
            <span className="key-gallery__label">{KEY_STATE_LABEL[s]}</span>
          </div>
        ))}
      </div>

      <h2>30px in a sidebar row</h2>
      <div className="key-gallery__row" data-section="rows">
        {(['idle', 'working', 'needsOk', 'paused'] as const).map((s) => (
          <div key={s} className="key-gallery__listrow">
            <AgentKey {...inbox} state={s} size="md" />
            <div>
              <div className="key-gallery__n">Inbox</div>
              <div className="key-gallery__s">
                {s === 'working' ? 'Working…' : KEY_STATE_LABEL[s]}
              </div>
            </div>
          </div>
        ))}
      </div>

      <h2>Independence pips (front edge, filled from the left)</h2>
      <div className="key-gallery__row" data-section="pips">
        {INDEPENDENCE_LEVELS.map((l) => (
          <div key={l} className="key-gallery__cell">
            <AgentKey {...inbox} level={l} size="xl" />
            <span className="key-gallery__label">{INDEPENDENCE_LABEL[l]}</span>
          </div>
        ))}
      </div>

      <h2>Colourways</h2>
      <div className="agents-board__plate key-gallery__board" data-section="board">
        {BOARD.map(([c, i, k]) => (
          <AgentKey
            key={c}
            name={c}
            colorway={c}
            icon={i}
            boundKey={k}
            level="judgement"
            size="xl"
          />
        ))}
        <AgentKey name="New" state="new" size="xl" />
      </div>
      <div className="key-gallery__row key-gallery__row--tight" data-section="board-small">
        {BOARD.map(([c, i]) => (
          <AgentKey key={c} name={c} colorway={c} icon={i} size="md" />
        ))}
        <AgentKey name="New" state="new" size="md" />
      </div>

      <h2>Live and Needs your OK on every colourway</h2>
      <div className="key-gallery__row key-gallery__row--tight" data-section="lit">
        {COLORWAYS.map((c) => (
          <AgentKey key={c.id} name={c.name} colorway={c.id} icon="bolt" state="live" size="lg" />
        ))}
        {COLORWAYS.map((c) => (
          <AgentKey
            key={`${c.id}-ok`}
            name={c.name}
            colorway={c.id}
            icon="bolt"
            state="needsOk"
            size="lg"
          />
        ))}
      </div>

      <h2>Every legend ({KEY_ICONS.length}): 44px and 20px</h2>
      <div className="key-gallery__icons" data-section="icons">
        {KEY_ICONS.map((icon, n) => (
          <div key={icon.id} className="key-gallery__cell key-gallery__cell--sm">
            <AgentKey
              name={icon.name}
              colorway={COLORWAYS[n % COLORWAYS.length].id}
              icon={icon.id}
              size="lg"
            />
            <AgentKey
              name={icon.name}
              colorway={COLORWAYS[n % COLORWAYS.length].id}
              icon={icon.id}
              size="sm"
            />
            <span className="key-gallery__label">{icon.name}</span>
          </div>
        ))}
      </div>

      <h2>Sizes</h2>
      <div className="key-gallery__row" data-section="sizes">
        {SIZES.map(([size, label]) => (
          <div key={size} className="key-gallery__cell key-gallery__cell--sm">
            <AgentKey {...inbox} level="go_hard" size={size} />
            <span className="key-gallery__label">{label}</span>
          </div>
        ))}
      </div>
    </main>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Gallery />
  </StrictMode>
);
