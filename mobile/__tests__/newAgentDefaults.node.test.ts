/**
 * What new agents start on, from the phone: the Mac's setting read from the
 * overview, offered only as the engines themselves allow, and changed with
 * `agents.setDefaults` through the app's real transport to the mock Mac,
 * which applies `agents::defaults`' rules.
 */

import type {
  CompanionEvent,
  Cursor,
  EngineInfo,
  NewAgentDefaults,
} from '@shipstudio/companion-protocol';
import { WebSocket } from 'ws';
import { createMockServer } from '../dev/mock-server';
import { until, provenBy } from './helpers';
import {
  ENGINE_DEFAULT,
  canChooseEngine,
  chosenModel,
  engineChoices,
  modelChange,
  modelOptions,
  notChosenBecause,
  startsOnLine,
} from '../src/lib/newAgentDefaults';
import { applyEvent, emptySync } from '../src/lib/sync';
import { DirectTransport, WireFailure } from '../src/lib/transport';

const ENGINES: EngineInfo[] = [
  {
    id: 'claude',
    label: 'Claude Code',
    installed: true,
    signedIn: true,
    models: [
      { value: 'opus', label: 'Opus' },
      { value: 'sonnet', label: 'Sonnet' },
    ],
  },
  { id: 'codex', label: 'Codex', installed: true, signedIn: false, models: [] },
];

const NONE: NewAgentDefaults = {
  engine: null,
  models: { claude: null, codex: null },
  startsOn: 'claude',
  model: null,
};

describe('new agents’ defaults, as Settings shows them', () => {
  it('offers only ready engines, and says why the others wait', () => {
    expect(engineChoices(ENGINES)).toEqual([
      { id: 'claude', label: 'Claude Code', ready: true, why: null },
      { id: 'codex', label: 'Codex', ready: false, why: 'Not signed in' },
    ]);
  });

  it('offers the engine’s default and only the models it listed', () => {
    expect(modelOptions('claude', ENGINES)).toEqual([
      { value: '', label: ENGINE_DEFAULT },
      { value: 'opus', label: 'Most capable', detail: 'Opus' },
      { value: 'sonnet', label: 'Balanced', detail: 'Sonnet' },
    ]);
    // Nothing listed: nothing invented.
    expect(modelOptions('codex', ENGINES)).toEqual([{ value: '', label: ENGINE_DEFAULT }]);
  });

  it('says when the choice isn’t where new agents start', () => {
    expect(startsOnLine(NONE)).toMatch(/keep theirs/);
    expect(startsOnLine({ ...NONE, engine: 'codex' })).toBe(
      'Codex isn’t ready, so new agents start on Claude Code for now. Tap Claude Code to keep them there. Agents you already have keep theirs.'
    );
    expect(chosenModel({ ...NONE, models: { claude: 'opus', codex: null } }, 'claude')).toBe(
      'opus'
    );
    expect(modelChange('codex', '')).toEqual({ codexModel: '' });
  });

  it('lets the engine new agents start on for now become the choice', () => {
    const [claude, codex] = engineChoices(ENGINES);
    const fallback = { ...NONE, engine: 'codex' as const };
    // Shown as where they start (startsOn), and still tappable to keep it.
    expect(canChooseEngine(fallback, claude)).toBe(true);
    expect(canChooseEngine(fallback, codex)).toBe(false);
    // Already the saved choice: nothing to do.
    expect(canChooseEngine({ ...NONE, engine: 'claude' }, claude)).toBe(false);
    // New agent says it beside the engine it names.
    expect(notChosenBecause(fallback)).toBe('Codex isn’t ready');
    expect(notChosenBecause(NONE)).toBeNull();
  });
});

describe('new agents’ defaults on the mock Mac', () => {
  const mock = createMockServer({ quiet: true, allowAfterMs: 0, draftEveryMs: 10 });
  let t: DirectTransport;
  let state = emptySync();

  beforeAll(async () => {
    const url = await mock.listen();
    t = new DirectTransport({
      routes: [{ kind: 'tailscale', url }],
      token: mock.issueToken().token,
      app: { version: '0.1.0', runtimeVersion: 'test' },
      getResume: () => state.cursor ?? undefined,
      foreground: true,
      WebSocketImpl: WebSocket as unknown as typeof globalThis.WebSocket,
      ...provenBy(mock),
    });
    t.onEvent((e: CompanionEvent, c?: Cursor) => {
      state = applyEvent(state, e, c);
    });
    await until(() => state.syncedAt != null);
  });

  afterAll(async () => {
    t.close();
    await mock.close();
  });

  it('serves agents.setDefaults and reads the setting with the overview', () => {
    expect(t.welcome?.methods).toContain('agents.setDefaults');
    expect(state.overview?.defaults).toMatchObject({ engine: null, startsOn: 'claude' });
  });

  it('changes the default, and the registry brings it', async () => {
    const claude = state.overview!.engines.find((e) => e.id === 'claude')!;
    const model = claude.models[0].value;
    const view = await t.request('agents.setDefaults', { engine: 'claude', claudeModel: model });
    expect(view).toMatchObject({ engine: 'claude', startsOn: 'claude', model });
    await until(() => state.overview?.defaults?.model === model);
    // Back to the engine's own.
    await t.request('agents.setDefaults', { claudeModel: '' });
    await until(() => state.overview?.defaults?.model === null);
  });

  it('refuses nothing, anything else, and a model the engine doesn’t list', async () => {
    for (const params of [{}, { model: 'opus' }, { claudeModel: 'gpt-imaginary' }]) {
      const refused = await t
        .request('agents.setDefaults', params as never)
        .catch((e: unknown) => e);
      expect(refused).toBeInstanceOf(WireFailure);
    }
  });
});
