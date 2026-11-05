/**
 * A phone that starts things: a new agent (its suggested name, the desk's
 * colour rule, the request handed to the Chief), the routine picker's words
 * and what the Mac reads them as, and "Send to agent…"'s payloads. The
 * create and schedule calls go through the app's real transport to the mock
 * Mac, which applies the router's rules.
 */

import {
  describeRoutineWhen,
  routineEcho,
  routineInPast,
  routineWhenOf,
  routineWhenPhrase,
  type CompanionEvent,
  type Cursor,
} from '@shipstudio/companion-protocol';
import { WebSocket } from 'ws';
import { createMockServer } from '../dev/mock-server';
import { until } from './helpers';
import { chiefRequest, freeColor, suggestAgentName } from '../src/lib/newAgent';
import { newPicker, onceDays, pickerOf, toggleDay, whenOf } from '../src/lib/routine';
import {
  describeShare,
  fromParams,
  fromShareIntent,
  isEmptyShare,
  shareText,
  toParams,
} from '../src/lib/share';
import { applyEvent, emptySync } from '../src/lib/sync';
import { DirectTransport, WireFailure } from '../src/lib/transport';

jest.setTimeout(20_000);

describe('a new agent', () => {
  it('is named from what it should do when you give no name', () => {
    expect(suggestAgentName('Keeps my inbox down to what matters', [])).toBe('Inbox');
    expect(suggestAgentName('Research competitors every Monday', [])).toBe('Research');
    expect(suggestAgentName('draft my day', [])).toBeNull();
    expect(suggestAgentName('', [])).toBeNull();
    // Made unique against the team, as the Mac refuses a second "Inbox".
    expect(suggestAgentName('watch my inbox', ['inbox'])).toBe('Inbox 2');
    expect(suggestAgentName('watch my inbox', ['Inbox', 'Inbox 2'])).toBe('Inbox 3');
  });

  it('starts on the first colour nobody wears, as the desk does', () => {
    expect(freeColor([])).toBe('brown');
    expect(freeColor(['white', 'brown', 'red'])).toBe('orange');
    expect(
      freeColor(['brown', 'red', 'orange', 'amber', 'green', 'teal', 'blue', 'purple', 'pink'])
    ).toBe('purple');
  });

  it('asks the Chief in your own words', () => {
    expect(chiefRequest('Keeps my inbox down to what matters.', '')).toBe(
      'Can you set up a new agent? What it’s for: Keeps my inbox down to what matters.'
    );
    expect(chiefRequest(' draft my day ', 'Morning')).toBe(
      'Can you set up a new agent called Morning? What it’s for: draft my day.'
    );
    expect(chiefRequest('', '')).toBe('Can you set up a new agent for me?');
  });
});

describe('the routine picker', () => {
  const at9 = { hour: 9, minute: 0 };
  // Wednesday 4 November 2026, 10:00 local.
  const now = new Date(2026, 10, 4, 10, 0).getTime();

  it('writes what it means in the grammar the Mac reads', () => {
    const base = newPicker(now);
    expect(base.cadence).toBe('weekdays');
    expect(routineWhenPhrase(whenOf(base)!)).toBe('every weekday at 09:00');
    expect(routineWhenPhrase(whenOf({ ...base, cadence: 'daily', hour: 7, minute: 30 })!)).toBe(
      'every day at 07:30'
    );
    expect(routineWhenPhrase(whenOf({ ...base, cadence: 'weekly', days: [4, 1] })!)).toBe(
      'every monday and thursday at 09:00'
    );
    expect(routineWhenPhrase(whenOf({ ...base, cadence: 'hours', minutes: 120 })!)).toBe(
      'every 2 hours'
    );
    expect(routineWhenPhrase(whenOf({ ...base, cadence: 'once', date: '2026-11-20' })!)).toBe(
      '2026-11-20 09:00'
    );
  });

  it('echoes the routine in one line before you save it', () => {
    const when = whenOf(newPicker(now))!;
    expect(routineEcho(when, '  Draft   my day ', now)).toMatch(
      /^Every weekday at 9:00\s?AM — Draft my day$/
    );
    expect(describeRoutineWhen({ kind: 'once', date: '2026-11-05', ...at9 }, now)).toMatch(
      /^Once · Tomorrow 9:00\s?AM$/
    );
    expect(describeRoutineWhen({ kind: 'every', minutes: 60 })).toBe('Every hour');
  });

  it('opens an existing check-in on the chips that made it', () => {
    const weekdays = {
      repeat: { kind: 'days' as const, days: [1, 2, 3, 4, 5], ...at9 },
      nextAt: 0,
    };
    expect(pickerOf(routineWhenOf(weekdays), now).cadence).toBe('weekdays');
    const daily = {
      repeat: { kind: 'days' as const, days: [0, 1, 2, 3, 4, 5, 6], ...at9 },
      nextAt: 0,
    };
    expect(pickerOf(routineWhenOf(daily), now).cadence).toBe('daily');
    const monThu = pickerOf(
      routineWhenOf({ repeat: { kind: 'days', days: [1, 4], hour: 8, minute: 30 }, nextAt: 0 }),
      now
    );
    expect(monThu).toMatchObject({ cadence: 'weekly', days: [1, 4], hour: 8, minute: 30 });
    const hourly = pickerOf(
      routineWhenOf({ repeat: { kind: 'every', minutes: 90 }, nextAt: 0 }),
      now
    );
    expect(hourly).toMatchObject({ cadence: 'hours', minutes: 90 });
    const once = pickerOf(routineWhenOf({ nextAt: new Date(2026, 10, 20, 17, 15).getTime() }), now);
    expect(once).toMatchObject({ cadence: 'once', date: '2026-11-20', hour: 17, minute: 15 });
    // Round trip: the same check-in comes back out.
    expect(routineWhenPhrase(whenOf(monThu)!)).toBe('every monday and thursday at 08:30');
  });

  it('keeps at least one day on, offers a week of dates and says when a once is past', () => {
    expect(toggleDay([1], 1)).toEqual([1]);
    expect(toggleDay([1, 3], 1)).toEqual([3]);
    expect(toggleDay([1], 5)).toEqual([1, 5]);
    const days = onceDays(now);
    expect(days.map((d) => d.label).slice(0, 3)).toEqual(['Today', 'Tomorrow', 'Fri 6']);
    expect(days).toHaveLength(7);
    expect(onceDays(now, '2026-12-25').at(-1)?.date).toBe('2026-12-25');
    expect(routineInPast({ kind: 'once', date: '2026-11-04', hour: 9, minute: 0 }, now)).toBe(true);
    expect(routineInPast({ kind: 'once', date: '2026-11-04', hour: 11, minute: 0 }, now)).toBe(
      false
    );
    expect(whenOf({ ...newPicker(now), cadence: 'weekly', days: [] })).toBeNull();
  });
});

describe('Send to agent…', () => {
  it('reads what the share sheet handed over, once', () => {
    const page = fromShareIntent({
      text: 'https://example.com/post',
      webUrl: 'https://example.com/post',
      meta: { title: 'A post' },
      files: null,
    });
    expect(page).toEqual({ url: 'https://example.com/post', title: 'A post' });
    const photos = fromShareIntent({
      files: [
        {
          path: '/private/var/group/a.jpg',
          fileName: 'a.jpg',
          mimeType: 'image/jpeg',
          size: 10,
          width: 1,
          height: 1,
        },
      ],
    });
    expect(photos.files?.[0]).toMatchObject({ uri: 'file:///private/var/group/a.jpg', size: 10 });
    expect(describeShare(photos)).toBe('A photo');
    expect(describeShare({ url: 'https://x.y', text: 'hi', files: photos.files })).toBe(
      'A link, some text and a photo'
    );
  });

  it('round-trips through the route, and takes only local files and web links from it', () => {
    const payload = {
      text: 'Look\u0007 at this',
      url: 'https://example.com',
      files: [{ uri: 'file:///tmp/a.pdf', name: 'a.pdf', mime: 'application/pdf' }],
    };
    expect(fromParams(toParams(payload))).toEqual({ ...payload, text: 'Look at this' });
    const hostile = fromParams({
      url: 'javascript:alert(1)',
      files: JSON.stringify([{ uri: 'https://evil.example/x', name: 'x', mime: 'text/plain' }]),
    });
    expect(isEmptyShare(hostile)).toBe(true);
    expect(isEmptyShare(fromParams({ files: 'not json' }))).toBe(true);
  });

  it('goes after what you had typed, the link first', () => {
    const s = { url: 'https://example.com', title: 'Example', text: 'Worth a read' };
    expect(shareText(s)).toBe('Example\nhttps://example.com\n\nWorth a read');
    expect(shareText(s, 'Summarise this:')).toBe(
      'Summarise this:\n\nExample\nhttps://example.com\n\nWorth a read'
    );
    expect(shareText({}, 'kept')).toBe('kept');
  });
});

describe('starting things on the mock Mac', () => {
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

  it('lists agents.create, so the phone offers it', () => {
    expect(t.welcome?.methods).toContain('agents.create');
  });

  it('creates an agent once per clientId, and the registry brings it', async () => {
    const input = { name: 'Inbox', role: 'Keeps my inbox down to what matters', color: 'teal' };
    const made = await t.request('agents.create', { input, clientId: 'new-1' });
    expect(made).toMatchObject({ name: 'Inbox', color: 'teal', isMain: false });
    const again = await t.request('agents.create', { input, clientId: 'new-1' });
    expect(again.id).toBe(made.id);
    await until(() => !!state.overview?.agents.some((a) => a.id === made.id));
    expect(state.overview!.agents.filter((a) => a.name === 'Inbox')).toHaveLength(1);
    // A second "Inbox" is the desk's own refusal.
    const dup = await t
      .request('agents.create', { input, clientId: 'new-2' })
      .catch((e: unknown) => e);
    expect(dup).toBeInstanceOf(WireFailure);
  });

  it('refuses what the phone may not set', async () => {
    const refused = await t
      .request('agents.create', {
        input: { name: 'Ops', engine: 'codex' } as never,
      })
      .catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(WireFailure);
    expect((refused as WireFailure).error).toMatchObject({ type: 'Protocol', code: 'bad_params' });
  });

  it('reads every phrase the picker writes', async () => {
    const base = newPicker();
    for (const s of [
      base,
      { ...base, cadence: 'daily' as const },
      { ...base, cadence: 'weekly' as const, days: [1, 4] },
      { ...base, cadence: 'hours' as const, minutes: 240 },
    ]) {
      const when = routineWhenPhrase(whenOf(s)!);
      const preview = await t.request('agents.schedule.preview', { when });
      expect(preview.nextAt).toBeGreaterThan(Date.now());
    }
    const made = await t.request('agents.schedule.create', {
      agentId: 'qa',
      when: routineWhenPhrase(whenOf({ ...base, cadence: 'weekly', days: [1, 4] })!),
      note: 'Draft my day',
    });
    expect(made.repeat).toEqual({ kind: 'days', days: [1, 4], hour: 9, minute: 0 });
  });
});
