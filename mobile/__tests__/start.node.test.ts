/**
 * A phone that starts things: a new agent (its suggested name, the desk's
 * colour rule, the request handed to the Chief), the routine picker's words
 * and what the Mac reads them as, and "Send to agent…"'s payloads. The
 * create and schedule calls go through the app's real transport to the mock
 * Mac, which applies the router's rules.
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import {
  describeRoutineWhen,
  formatWhenIn,
  localDate,
  localTs,
  routineEcho,
  routineInPast,
  routineWhenOf,
  routineWhenPhrase,
  wallClock,
  zoneDiffers,
  type CompanionEvent,
  type RoutineWhen,
  type Cursor,
} from '@shipstudio/companion-protocol';
import { WebSocket } from 'ws';
import { createMockServer } from '../dev/mock-server';
import { until, provenBy } from './helpers';
import { chiefRequest, freeColor, suggestAgentName } from '../src/lib/newAgent';
import { newPicker, onceDays, pickerOf, toggleDay, whenOf } from '../src/lib/routine';
import {
  describeShare,
  fromLinkParams,
  fromShareIntent,
  isEmptyShare,
  payloadForRoute,
  releaseShare,
  sharedQuote,
  stashedShare,
  stashShare,
  toLinkParams,
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

  it('never takes files from a link, whatever it says', () => {
    const crafted = {
      text: 'Summarise the attached',
      files: JSON.stringify([
        {
          uri: 'file:///var/mobile/Documents/companion-state/chats.json',
          name: 'photo.jpg',
          mime: 'image/jpeg',
        },
      ]),
    };
    const fromLink = fromLinkParams(crafted);
    expect(fromLink.files).toBeUndefined();
    expect(fromLink).toEqual({ text: 'Summarise the attached', fromLink: true });
    // A key that the share sheet didn't stash finds nothing, so it's the link's words.
    expect(payloadForRoute({ ...crafted, k: 'guessed' }).files).toBeUndefined();
    expect(isEmptyShare(fromLinkParams({ files: crafted.files }))).toBe(true);
    // Only web links, and control characters gone.
    const hostile = fromLinkParams({ url: 'javascript:alert(1)', text: 'Look\u0007 at this' });
    expect(hostile).toEqual({ text: 'Look at this', fromLink: true });
    expect(fromLinkParams(toLinkParams({ url: 'https://example.com', title: 'Ex' }))).toEqual({
      url: 'https://example.com',
      title: 'Ex',
      fromLink: true,
    });
  });

  it('hands the share sheet’s files over in memory, under a one-time key', () => {
    const files = [
      { uri: 'file:///private/var/group/a.pdf', name: 'a.pdf', mime: 'application/pdf' },
    ];
    const k = stashShare({ text: 'Notes', files });
    expect(payloadForRoute({ k })).toEqual({ text: 'Notes', files });
    expect(payloadForRoute({ k }).fromLink).toBeUndefined();
    // A newer share replaces it; the screen releases its own when it goes.
    const k2 = stashShare({ text: 'Newer' });
    expect(stashedShare(k)).toBeUndefined();
    releaseShare(k2);
    expect(stashedShare(k2)).toBeUndefined();
    expect(k).toMatch(/^[0-9a-f]{32}$/);
  });

  it('is one quote, link first, never mixed into what you typed', () => {
    const s = { url: 'https://example.com', title: 'Example', text: 'Worth a read' };
    expect(sharedQuote(s)).toBe('Example\nhttps://example.com\n\nWorth a read');
    expect(sharedQuote({ url: 'https://example.com', title: 'https://example.com' })).toBe(
      'https://example.com'
    );
    expect(sharedQuote({})).toBe('');
  });
});

describe('routine times on the Mac’s clock', () => {
  // Wed 4 Nov 2026, 22:30 in New York is Thu 5 Nov, 03:30 UTC and 12:30 in Tokyo.
  const now = Date.UTC(2026, 10, 5, 3, 30);
  const mac = 'Asia/Tokyo';

  it('reads days and times in the Mac’s zone', () => {
    expect(wallClock(now, mac)).toMatchObject({
      year: 2026,
      month: 11,
      day: 5,
      hour: 12,
      minute: 30,
      weekday: 4,
    });
    expect(wallClock(now, 'America/New_York')).toMatchObject({ day: 4, hour: 22, weekday: 3 });
    expect(localDate(now, mac)).toBe('2026-11-05');
    expect(localTs('2026-11-05', 12, 30, mac)).toBe(now);
    // Across a DST change from now: 9:00 in New York on 2 Nov is EST (UTC-5).
    expect(localTs('2026-11-02', 9, 0, 'America/New_York')).toBe(Date.UTC(2026, 10, 2, 14, 0));
    expect(localTs('2026-10-30', 9, 0, 'America/New_York')).toBe(Date.UTC(2026, 9, 30, 13, 0));
    // A zone the phone doesn't know is the phone's own clock, not a crash.
    expect(localDate(now, 'Not/AZone')).toBe(localDate(now));
    expect(zoneDiffers('Not/AZone', now)).toBe(false);
    expect(zoneDiffers(undefined, now)).toBe(false);
  });

  it('opens a one-off on the Mac’s date and time, and its past is the Mac’s', () => {
    const ts = Date.UTC(2026, 10, 6, 0, 0); // Fri 6 Nov 09:00 in Tokyo
    expect(routineWhenOf({ nextAt: ts }, mac)).toEqual({
      kind: 'once',
      date: '2026-11-06',
      hour: 9,
      minute: 0,
    });
    // Re-sent unchanged, the phrase is the Mac's own, so the routine doesn't move.
    expect(routineWhenPhrase(routineWhenOf({ nextAt: ts }, mac))).toBe('2026-11-06 09:00');
    expect(routineInPast({ kind: 'once', date: '2026-11-05', hour: 12, minute: 0 }, now, mac)).toBe(
      true
    );
    expect(routineInPast({ kind: 'once', date: '2026-11-05', hour: 13, minute: 0 }, now, mac)).toBe(
      false
    );
    expect(formatWhenIn(ts, now, mac)).toMatch(/^Tomorrow 9:00\s?AM$/);
  });

  it('offers the Mac’s today, and says "Mac time" only when its clock differs', () => {
    const tokyo = onceDays(now, undefined, mac);
    expect(tokyo[0]).toEqual({ date: '2026-11-05', label: 'Today' });
    expect(tokyo[2]).toEqual({ date: '2026-11-07', label: 'Sat 7' });
    expect(newPicker(now, mac)).toMatchObject({ date: '2026-11-05', days: [4] });
    const phone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const weekdays: RoutineWhen = { kind: 'days', days: [1, 2, 3, 4, 5], hour: 9, minute: 0 };
    expect(describeRoutineWhen(weekdays, now, phone)).toMatch(/^Every weekday at 9:00\s?AM$/);
    const other = phone === 'Asia/Tokyo' ? 'America/New_York' : 'Asia/Tokyo';
    expect(describeRoutineWhen(weekdays, now, other)).toMatch(
      /^Every weekday at 9:00\s?AM Mac time$/
    );
    expect(describeRoutineWhen({ kind: 'every', minutes: 120 }, now, other)).toBe('Every 2 hours');
    expect(routineEcho(weekdays, 'Draft my day', now, other)).toMatch(/Mac time — Draft my day$/);
  });
});

describe('the picker’s words, as the Mac’s grammar reads them', () => {
  // The same file feeds agents::schedule::tests::reads_every_phrase_the_phone_picker_writes.
  const file = JSON.parse(
    readFileSync(
      join(__dirname, '../../packages/companion-protocol/src/routine-phrases.json'),
      'utf8'
    )
  ) as { cases: { when: RoutineWhen; phrase: string }[] };

  it('writes each phrase, and the picker opens it on the same schedule', () => {
    expect(file.cases.length).toBeGreaterThanOrEqual(10);
    for (const { when, phrase } of file.cases) {
      expect(routineWhenPhrase(when)).toBe(phrase);
      const back = whenOf(pickerOf(when, Date.UTC(2026, 10, 3, 20)));
      expect(back && routineWhenPhrase(back)).toBe(phrase);
    }
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

  it('offers the Mac’s ready-made agents and starts one from its template', async () => {
    expect(t.welcome?.methods).toContain('agents.templates');
    const list = await t.request('agents.templates', {});
    expect(list.map((x) => x.id)).toEqual(['research', 'inbox', 'weekly-review']);
    expect(list.find((x) => x.id === 'inbox')?.needs).toBe('mail');
    const research = list[0];
    const made = await t.request('agents.create', {
      input: {
        name: research.name,
        role: research.role,
        color: research.color,
        template: 'research',
      },
      clientId: 'tpl-1',
    });
    expect(made).toMatchObject({ name: 'Research', template: 'research' });
    const refused = await t
      .request('agents.create', { input: { name: 'Stars', template: 'astrologer' } })
      .catch((e: unknown) => e);
    expect((refused as WireFailure).error).toMatchObject({ code: 'bad_params' });
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

  it('says its zone, and keeps a schedule when an edit sends no when', async () => {
    expect(t.welcome?.timeZone).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
    const made = await t.request('agents.schedule.create', {
      agentId: 'qa',
      when: 'every 2 hours',
      note: 'Check',
    });
    const edited = await t.request('agents.schedule.update', {
      agentId: 'qa',
      id: made.id,
      when: '',
      note: 'Check mail',
    });
    expect(edited).toMatchObject({ note: 'Check mail', nextAt: made.nextAt, repeat: made.repeat });
  });
});
