import { describe, expect, it } from 'vitest';
import { agentInitials, distinctInitials } from './agentInitials';
import {
  describeWatchCheck,
  routineModelChoices,
  routineModelOf,
  promptAnswer,
  type SessionPrompt,
  buildChatItems,
  describeScope,
  errorRemedy,
  roleWithoutPath,
  filterFiles,
  isCodePath,
  isQueued,
  lastUserMessage,
  failureLine,
  failurePill,
  continuesFrom,
  retrySourceFor,
  approvalSeries,
  plainActivity,
  retryNote,
  whenAt,
  snippetAround,
  localPathFromHref,
  PROSE_PATH,
  describeCheckInTime,
  describeEvery,
  watchCappedToday,
  fullyPriced,
  routineWeekLine,
  describeWatchSource,
  describeWatchStatus,
  describeWatchTitle,
  watchUsesModel,
  type CheckIn,
  type Watch,
  describeRepeat,
  describeRun,
  describeRunDetail,
  groupMemory,
  undoDelete,
  formatWhen,
  splitScheduleInput,
  scheduleWhenPhrase,
  sortCheckIns,
  formatDivider,
  formatUsage,
  groupHits,
  highlightRuns,
  modelLabel,
  modelChoices,
  engineIsReady,
  defaultEngine,
  newAgentEngine,
  newAgentModel,
  noEngineInstalled,
  engineCantAsk,
  engineProtections,
  engineUnavailable,
  type EngineInfo,
  peerGroupLabel,
  sortAgents,
  splitQuotes,
  withQuotes,
  type Agent,
  type AgentMessage,
  type SearchHit,
  type SharedFile,
  type UsageTotals,
  mentionAt,
  mentionCandidates,
  mentionedAgents,
  mentionRuns,
  replyPreview,
  summarizeTeam,
  needsAttention,
  isConnectorLine,
} from './agents';

const msg = (id: string, kind: AgentMessage['kind'], ts: number, peer?: string): AgentMessage => ({
  id,
  agentId: 'chief',
  ts,
  kind,
  text: id,
  ...(peer ? { peer: { id: peer, name: peer.toUpperCase() } } : {}),
});

describe('buildChatItems', () => {
  it('collapses consecutive lines with the same agent into one group', () => {
    const items = buildChatItems([
      msg('a', 'agent', 1000),
      msg('b', 'sent_to_agent', 1001, 'acme'),
      msg('c', 'from_agent', 1002, 'acme'),
      msg('d', 'sent_to_agent', 1003, 'finance'),
      msg('e', 'agent', 1004),
    ]);
    const kinds = items.map((i) =>
      i.type === 'peer-group' ? `group:${i.messages.length}` : i.type
    );
    expect(kinds).toEqual(['day', 'message', 'group:2', 'group:1', 'message']);
  });

  it('shows the import connector’s side in full, never folded into a hand-off group', () => {
    const items = buildChatItems([
      msg('a', 'from_agent', 1000, 'connector:Grok'),
      msg('b', 'agent', 1001),
      msg('c', 'from_agent', 1002, 'connector:Grok'),
      msg('d', 'from_agent', 1003, 'connector:Grok'),
    ]);
    expect(items.map((i) => i.type)).toEqual(['day', 'message', 'message', 'message', 'message']);
    expect(isConnectorLine(msg('x', 'from_agent', 1, 'connector:Grok'))).toBe(true);
    expect(isConnectorLine(msg('x', 'from_agent', 1, 'finance'))).toBe(false);
  });

  it('does not merge groups across a regular message', () => {
    const items = buildChatItems([
      msg('a', 'sent_to_agent', 1000, 'acme'),
      msg('b', 'agent', 1001),
      msg('c', 'from_agent', 1002, 'acme'),
    ]);
    expect(items.filter((i) => i.type === 'peer-group')).toHaveLength(2);
  });

  it('prints a time divider for a new sitting, not a pause', () => {
    const hour = 60 * 60 * 1000;
    const morning = new Date(2026, 10, 3, 8).getTime();
    const days = (messages: AgentMessage[]) =>
      buildChatItems(messages).filter((i) => i.type === 'day').length;
    // An hour's pause: still one sitting.
    expect(days([msg('a', 'user', morning), msg('b', 'agent', morning + hour)])).toBe(1);
    // Four hours of quiet: a new one.
    expect(days([msg('a', 'user', morning), msg('b', 'agent', morning + 4 * hour)])).toBe(2);
    // Across midnight, however short the gap.
    const lateNight = new Date(2026, 10, 3, 23, 50).getTime();
    expect(days([msg('a', 'user', lateNight), msg('b', 'agent', lateNight + hour / 3)])).toBe(2);
  });
});

describe('peerGroupLabel', () => {
  it('says what happened', () => {
    expect(peerGroupLabel([msg('a', 'sent_to_agent', 0, 'x')])).toBe('Messaged');
    expect(peerGroupLabel([msg('a', 'from_agent', 0, 'x')])).toBe('Message from');
    expect(
      peerGroupLabel([msg('a', 'from_agent', 0, 'x'), msg('b', 'sent_to_agent', 1, 'x')])
    ).toBe('2 messages with');
  });
});

describe('formatDivider', () => {
  it('names today and yesterday', () => {
    const now = new Date(2026, 10, 3, 15, 0).getTime();
    expect(formatDivider(new Date(2026, 10, 3, 9, 5).getTime(), now)).toMatch(/^Today /);
    expect(formatDivider(new Date(2026, 10, 2, 9, 5).getTime(), now)).toMatch(/^Yesterday /);
    expect(formatDivider(new Date(2026, 9, 20, 9, 5).getTime(), now)).not.toMatch(
      /^(Today|Yesterday)/
    );
  });
});

describe('sortAgents', () => {
  const a = (id: string, lastActivityAt: number, pinned = false) =>
    ({ id, lastActivityAt, pinned }) as Agent;
  it('puts pinned first, then most recent', () => {
    const sorted = sortAgents([a('old', 1), a('pinned-old', 0, true), a('new', 5)]);
    expect(sorted.map((x) => x.id)).toEqual(['pinned-old', 'new', 'old']);
  });
});

describe('quotes', () => {
  it('sends each quote as a blockquote ahead of the typed text', () => {
    expect(withQuotes(['one', 'two\nlines'], 'Why?')).toBe('> one\n\n> two\n> lines\n\nWhy?');
    expect(withQuotes(['only'], '')).toBe('> only');
  });

  it('reads blockquotes back out of a user message', () => {
    expect(splitQuotes('> one\n\n> two\n> lines\n\nWhy?')).toEqual([
      { kind: 'quote', text: 'one' },
      { kind: 'quote', text: 'two\nlines' },
      { kind: 'text', text: 'Why?' },
    ]);
    expect(splitQuotes('> a\n>\n> b')).toEqual([{ kind: 'quote', text: 'a\n\nb' }]);
    expect(splitQuotes('no quotes > here')).toEqual([{ kind: 'text', text: 'no quotes > here' }]);
  });
});

describe('schedule helpers', () => {
  // Times are written in the user's locale, like everything else on screen.
  const at = (hour: number, minute: number) =>
    new Date(2000, 0, 1, hour, minute).toLocaleTimeString(undefined, {
      hour: 'numeric',
      minute: '2-digit',
    });

  it("describes routines in the backend's words, with locale times", () => {
    expect(describeRepeat({ kind: 'days', days: [1, 2, 3, 4, 5], hour: 9, minute: 0 })).toBe(
      `Every weekday at ${at(9, 0)}`
    );
    expect(describeRepeat({ kind: 'days', days: [0, 1, 2, 3, 4, 5, 6], hour: 7, minute: 45 })).toBe(
      `Every day at ${at(7, 45)}`
    );
    expect(describeRepeat({ kind: 'days', days: [1, 4], hour: 8, minute: 30 })).toBe(
      `Every Monday and Thursday at ${at(8, 30)}`
    );
    expect(describeRepeat({ kind: 'days', days: [1, 3, 5], hour: 8, minute: 30 })).toBe(
      `Every Monday, Wednesday and Friday at ${at(8, 30)}`
    );
    expect(describeRepeat({ kind: 'every', minutes: 120 })).toBe('Every 2 hours');
    expect(describeRepeat({ kind: 'every', minutes: 60 })).toBe('Every hour');
    expect(describeRepeat({ kind: 'every', minutes: 90 })).toBe('Every 90 minutes');
  });

  it('splits "when: what" at the first colon that is followed by a space', () => {
    expect(splitScheduleInput('every weekday 9am: brief me on Acme')).toEqual({
      when: 'every weekday 9am',
      note: 'brief me on Acme',
    });
    expect(splitScheduleInput('tomorrow 9:30: check: the invoices')).toEqual({
      when: 'tomorrow 9:30',
      note: 'check: the invoices',
    });
    expect(splitScheduleInput('every weekday 9:30')).toEqual({
      when: 'every weekday 9:30',
      note: '',
    });
    expect(splitScheduleInput('tomorrow 9am:')).toEqual({ when: 'tomorrow 9am', note: '' });
  });

  it('words a row: next time, how it repeats, paused', () => {
    const now = new Date(2026, 10, 4, 15, 0).getTime();
    const nextAt = new Date(2026, 10, 5, 9, 0).getTime();
    const repeat = { kind: 'days' as const, days: [1, 2, 3, 4, 5], hour: 9, minute: 0 };
    const base = { id: 'x', note: 'n', nextAt, createdAt: 0, paused: false };
    expect(describeCheckInTime(base, now)).toBe(`Tomorrow ${at(9, 0)}`);
    expect(describeCheckInTime({ ...base, repeat }, now)).toBe(
      `Every weekday at ${at(9, 0)} · next tomorrow ${at(9, 0)}`
    );
    expect(describeCheckInTime({ ...base, repeat, paused: true }, now)).toBe(
      `Paused · Every weekday at ${at(9, 0)}`
    );
  });

  it('says when a failed run is tried again', () => {
    const now = new Date(2026, 10, 4, 9, 3).getTime();
    const nextAt = new Date(2026, 10, 5, 9, 0).getTime();
    const repeat = { kind: 'days' as const, days: [1, 2, 3, 4, 5], hour: 9, minute: 0 };
    const retry = {
      at: new Date(2026, 10, 4, 9, 7).getTime(),
      attempts: 1,
      firstFailedAt: now,
      dueAt: now,
    };
    const base = { id: 'x', note: 'n', nextAt, createdAt: 0, paused: false, retry };
    expect(describeCheckInTime({ ...base, repeat }, now)).toBe(
      `Every weekday at ${at(9, 0)} · retrying today ${at(9, 7)}`
    );
    expect(describeCheckInTime(base, now)).toBe(`Didn’t run · retrying today ${at(9, 7)}`);
    // Paused wins: nothing will run.
    expect(describeCheckInTime({ ...base, repeat, paused: true }, now)).toMatch(/^Paused/);
    const run = { at: now, attempt: 1 };
    expect(describeRun({ ...run, outcome: 'ran' })).toBe('Ran');
    expect(describeRun({ ...run, outcome: 'ran', attempt: 3 })).toBe('Ran on try 3');
    expect(describeRun({ ...run, outcome: 'retrying', retryAt: retry.at }, now)).toBe(
      `Didn’t run · retrying today ${at(9, 7)}`
    );
    expect(describeRun({ ...run, outcome: 'failed', attempt: 8 })).toBe('Didn’t run after 8 tries');
    expect(describeRun({ ...run, outcome: 'unknown' })).toBe('Unknown');
  });

  it('says a provider failure in plain words, and leaves the rest as it came', () => {
    expect(describeRunDetail('API Error: 529 overloaded')).toBe('The service was busy');
    expect(describeRunDetail('API Error: 500 Internal Server Error')).toBe(
      'The service had a problem'
    );
    expect(describeRunDetail('429 rate_limit_error')).toBe('Too many requests at once');
    expect(describeRunDetail('Claude Code is signed out.')).toBe('Claude Code is signed out.');
  });

  it('names today and tomorrow, and dates further out', () => {
    const now = new Date(2026, 10, 4, 15, 0).getTime();
    expect(formatWhen(new Date(2026, 10, 4, 18, 0).getTime(), now)).toMatch(/^Today /);
    expect(formatWhen(new Date(2026, 10, 5, 9, 0).getTime(), now)).toMatch(/^Tomorrow /);
    expect(formatWhen(new Date(2026, 10, 9, 9, 0).getTime(), now)).not.toMatch(/Today|Tomorrow/);
  });

  it('lists the soonest first and paused ones last', () => {
    const c = (id: string, nextAt: number, paused = false) => ({
      id,
      note: id,
      nextAt,
      createdAt: 0,
      paused,
    });
    expect(
      sortCheckIns([c('late', 3), c('paused', 1, true), c('soon', 2)]).map((x) => x.id)
    ).toEqual(['soon', 'late', 'paused']);
  });
});

describe('search results', () => {
  const hit = (agentId: string, messageId: string): SearchHit => ({
    agentId,
    agentName: agentId,
    agentColor: 'blue',
    messageId,
    ts: 0,
    kind: 'agent',
    snippet: '',
  });

  it('groups by agent in the order of each agent’s newest hit', () => {
    const groups = groupHits([hit('b', '1'), hit('a', '2'), hit('b', '3')]);
    expect(groups.map((g) => [g.agentId, g.hits.map((h) => h.messageId)])).toEqual([
      ['b', ['1', '3']],
      ['a', ['2']],
    ]);
  });

  it('highlights every word, case-insensitively, without regex surprises', () => {
    const runs = highlightRuns('Invoice for Northwind (Q3)', 'northwind invoice (q3');
    expect(runs.filter((r) => r.match).map((r) => r.text)).toEqual(['Invoice', 'Northwind', '(Q3']);
    expect(runs.map((r) => r.text).join('')).toBe('Invoice for Northwind (Q3)');
    expect(highlightRuns('plain', ' ')).toEqual([{ text: 'plain', match: false }]);
  });
});

describe('formatUsage', () => {
  const totals = (over: Partial<UsageTotals>): UsageTotals => ({
    turns: 2,
    inputTokens: 10,
    outputTokens: 500,
    cacheReadTokens: 30_000,
    cacheWriteTokens: 9_490,
    costUsd: 0.4231,
    pricedTurns: 2,
    durationMs: 185_000,
    ...over,
  });

  it('prints only what was reported', () => {
    expect(formatUsage(totals({}))).toBe('$0.42 at API prices · 40k tokens · 2 turns · 3 min');
    expect(formatUsage(totals({ turns: 0 }))).toBeNull();
  });

  it('on a Claude plan, leaves out the list price: it is not the bill', () => {
    expect(formatUsage(totals({}), true)).toBe('40k tokens · 2 turns · 3 min');
  });

  it('drops the cost when any turn reported none, rather than under-reporting it', () => {
    expect(formatUsage(totals({ pricedTurns: 1, durationMs: 0 }))).toBe('40k tokens · 2 turns');
  });

  it('labels models by alias and passes unknown ids through', () => {
    expect(modelLabel(null)).toBe('Default');
    expect(modelLabel('opus')).toBe('Smartest');
    expect(modelLabel('claude-x')).toBe('claude-x');
  });

  it('offers each engine its own models', () => {
    const engines: EngineInfo[] = [
      {
        id: 'claude',
        label: 'Claude Code',
        installed: true,
        signedIn: true,
        asks: true,
        models: [],
      },
      {
        id: 'codex',
        label: 'Codex',
        installed: true,
        signedIn: false,
        asks: true,
        models: [{ value: 'gpt-5.5', label: 'GPT-5.5' }],
      },
    ];
    expect(modelChoices('claude', engines).map((m) => m.label)).toEqual([
      'Default',
      'Smartest',
      'Balanced',
      'Fastest',
    ]);
    expect(modelChoices('codex', engines).map((m) => m.value)).toEqual(['', 'gpt-5.5']);
    expect(modelLabel('gpt-5.5', modelChoices('codex', engines))).toBe('GPT-5.5');
    expect(engineIsReady('codex', engines, true)).toBe(false);
    expect(engineIsReady('claude', engines, true)).toBe(true);
    // A signed-out Claude Code says so before a message fails on it.
    const signedOut = engines.map((e) => (e.id === 'claude' ? { ...e, signedIn: false } : e));
    expect(engineIsReady('claude', signedOut, true)).toBe(false);
    // Before the engines load, the overview's Claude flag decides.
    expect(engineIsReady('claude', [], true)).toBe(true);
    expect(engineIsReady('codex', [], true)).toBe(false);
    expect(defaultEngine(engines)).toBe('claude');
    expect(defaultEngine(signedOut)).toBe('claude'); // nothing ready: Claude, which offers setup
    const codexOnly = engines.map((e) =>
      e.id === 'claude' ? { ...e, installed: false, signedIn: false } : { ...e, signedIn: true }
    );
    expect(defaultEngine(codexOnly)).toBe('codex');
    expect(noEngineInstalled(codexOnly)).toBe(false);
    expect(noEngineInstalled(engines.map((e) => ({ ...e, installed: false })))).toBe(true);
    expect(noEngineInstalled([])).toBe(false);
    // The user's defaults for new agents, as the overview says them.
    const chosen = {
      engine: 'codex' as const,
      models: { claude: 'haiku', codex: 'gpt-5.5', opencode: null },
      startsOn: 'codex' as const,
      model: 'gpt-5.5',
    };
    expect(newAgentEngine(chosen, engines)).toBe('codex');
    expect(newAgentEngine(null, codexOnly)).toBe('codex'); // before the overview: the rule
    expect(newAgentModel(chosen, 'codex', modelChoices('codex', engines))).toBe('gpt-5.5');
    expect(newAgentModel(chosen, 'claude', modelChoices('claude', engines))).toBe('haiku');
    // A model the engine doesn't offer (any more) is its default, never invented.
    expect(newAgentModel(chosen, 'codex', modelChoices('codex', []))).toBe('');
    expect(newAgentModel(null, 'claude', modelChoices('claude', engines))).toBe('');
  });

  it('says what an engine needs, and only claims protection the engine enforces', () => {
    const codex: EngineInfo = {
      id: 'codex',
      label: 'Codex',
      installed: false,
      signedIn: false,
      asks: false,
      models: [],
    };
    expect(engineUnavailable(codex)).toBe('install');
    expect(engineUnavailable({ ...codex, installed: true })).toBe('sign-in');
    expect(engineUnavailable({ ...codex, installed: true, signedIn: true })).toBeNull();
    // What the engine enforces, under the level: never a second answer to
    // "what does it do on its own" (the independence slider's).
    expect(engineProtections('claude')).toMatch(/^Claude Code enforces:/);
    expect(engineProtections('claude')).toMatch(/decided by its independence/);
    const app = engineProtections('codex', { ...codex, installed: true, asks: true });
    expect(app).toMatch(/can't reach the internet/);
    expect(app).toMatch(/decided by its independence/);
    expect(app).toMatch(/connected to Codex aren't limited/);
    // An old Codex can't ask: the line must not say it does, and says so plainly.
    const old = engineProtections('codex', { ...codex, installed: true, asks: false });
    expect(old).toMatch(/can't stop to ask you/);
    expect(old).not.toMatch(/decided by its independence/);
    // No jargon: these are read by people who don't run terminals.
    for (const line of [engineProtections('claude'), app, old]) {
      expect(line).not.toMatch(/sandbox|app-server|exec\b|MCP/i);
      // No "on its own" / "asks you first" claim to contradict the level.
      expect(line).not.toMatch(/on its own|asks you first/);
    }
  });

  it('says an engine cannot ask only when it is installed and says so', () => {
    const codex: EngineInfo = {
      id: 'codex',
      label: 'Codex',
      installed: true,
      signedIn: true,
      asks: false,
      models: [],
    };
    expect(engineCantAsk('codex', [codex])).toMatch(/needs your OK is refused/);
    expect(engineCantAsk('codex', [{ ...codex, asks: true }])).toBeNull();
    // A computer that doesn't say, or a Codex that isn't here: nothing claimed.
    expect(engineCantAsk('codex', [{ ...codex, asks: undefined }])).toBeNull();
    expect(engineCantAsk('codex', [{ ...codex, installed: false }])).toBeNull();
    expect(engineCantAsk('claude', [codex])).toBeNull();
  });

  it('starts a new agent on the first engine that can take it', () => {
    const claude: EngineInfo = {
      id: 'claude',
      label: 'Claude Code',
      installed: true,
      signedIn: true,
      asks: true,
      models: [],
    };
    const codex: EngineInfo = { ...claude, id: 'codex', label: 'Codex' };
    expect(defaultEngine([claude, codex])).toBe('claude');
    expect(defaultEngine([{ ...claude, installed: false, signedIn: false }, codex])).toBe('codex');
    expect(
      defaultEngine([
        { ...claude, installed: false },
        { ...codex, signedIn: false },
      ])
    ).toBe('claude');
    expect(defaultEngine([])).toBe('claude');
  });
});

describe('distinctInitials', () => {
  it('lets the earlier agent keep its initials', () => {
    const names = ['Chief of Staff', 'Finance', 'Client Sites QA'];
    expect(distinctInitials('Chief of Staff', names)).toBe('CS');
    expect(distinctInitials('Client Sites QA', names)).toBe('CL');
    expect(distinctInitials('Finance', names)).toBe('FI');
    expect(distinctInitials('Cool Stuff', names)).toBe('CL');
  });
});

describe('roleWithoutPath', () => {
  it('drops a folder path from the role, keeping the sentence', () => {
    expect(
      roleWithoutPath('Owns the Acme marketing site rebuild in ~/ShipStudio/acme-marketing.')
    ).toBe('Owns the Acme marketing site rebuild.');
    expect(roleWithoutPath('Files /Users/a/Downloads/x.pdf, then reports')).toBe(
      'Files, then reports'
    );
    expect(roleWithoutPath('Keeps the books')).toBe('Keeps the books');
    // A slash that isn't a path stays.
    expect(roleWithoutPath('Sales/ops lead')).toBe('Sales/ops lead');
  });
});

describe('agentInitials', () => {
  it('takes two words, skipping filler', () => {
    expect(agentInitials('Chief of Staff')).toBe('CS');
    expect(agentInitials('Finance')).toBe('FI');
  });

  it('never takes a bracket or a symbol', () => {
    expect(agentInitials('Finance (from Grok)')).toBe('FI');
    expect(agentInitials('Sales/Ops')).toBe('SO');
    expect(distinctInitials('Finance (from Grok)', ['Finance', 'Finance (from Grok)'])).toBe('FN');
  });

  it('keeps numbers apart', () => {
    expect(agentInitials('Agent 3')).toBe('A3');
    expect(agentInitials('Agent 10')).toBe('10');
    expect(agentInitials('Agent 19')).toBe('19');
  });
});

describe('errorRemedy', () => {
  const line = (text: string) => ({ text });
  it('offers sign-in for expired logins only', () => {
    expect(
      errorRemedy(line("Claude Code isn't signed in anymore (its session expired). Open an agent"))
    ).toBe('sign-in');
    expect(errorRemedy(line('Invalid API key · Please run /login'))).toBe('sign-in');
    expect(errorRemedy(line('You should sign in again to Stripe'))).toBeNull();
    expect(errorRemedy(line('Stopped.'))).toBeNull();
  });
  it('trusts the backend’s tag over the words', () => {
    expect(
      errorRemedy({ text: 'Claude Code is signed out.', failure: { kind: 'signed_out' } })
    ).toBe('sign-in');
    expect(errorRemedy({ text: 'please run /login', failure: { kind: 'other' } })).toBeNull();
  });
});

describe('lastUserMessage', () => {
  const m = (kind: string, text: string, extra = {}) => ({
    id: text,
    agentId: 'a',
    ts: 0,
    kind,
    text,
    ...extra,
  });
  it('finds the last thing you sent before a line, files and all', () => {
    const files = [{ name: 'a.png', path: 'attachments/x/a.png', mime: 'image/png', size: 1 }];
    const list = [m('user', 'first'), m('agent', 'ok'), m('user', '', { attachments: files })];
    expect(lastUserMessage([...list, m('error', 'x')] as never, 3)?.attachments).toBe(files);
    expect(lastUserMessage(list as never, 0)).toBeNull();
    expect(lastUserMessage([m('user', ' '), m('error', 'x')] as never, 1)).toBeNull();
  });
});

describe('approvalSeries', () => {
  const card = (id: string, title: string): AgentMessage => ({
    id,
    agentId: 'lg',
    ts: Number(id.slice(1)),
    kind: 'approval',
    text: '',
    approval: { requestId: id, title, detail: '', status: 'pending' },
  });
  const said = (id: string, kind: AgentMessage['kind']): AgentMessage => ({
    id,
    agentId: 'lg',
    ts: Number(id.slice(1)),
    kind,
    text: 'x',
  });
  it('counts a run of the same request, across what the agent says between', () => {
    const items = buildChatItems([
      card('a1', 'Send an email'),
      said('a2', 'agent'),
      card('a3', 'Send an email'),
      card('a4', 'Send an email'),
      said('a5', 'user'),
      card('a6', 'Send an email'),
      card('a7', 'Run a command'),
    ]);
    const series = approvalSeries(items);
    expect(series.get('a1')).toEqual({ index: 1, total: 3 });
    expect(series.get('a4')).toEqual({ index: 3, total: 3 });
    expect(series.has('a6')).toBe(false);
    expect(series.has('a7')).toBe(false);
  });
});

describe('plainActivity', () => {
  it('says files and commands in words, and leaves plain lines alone', () => {
    expect(plainActivity('Editing PricingTable.tsx')).toBe('Working on the pricing table');
    expect(plainActivity('Reading …/src/App.tsx')).toBe('Reading the app');
    expect(plainActivity('$ npm test')).toBe('Running a command');
    expect(plainActivity('Fetching https://www.acme.com/pricing')).toBe('Reading acme.com');
    expect(plainActivity('Searching for footer')).toBe('Looking through the files');
    expect(plainActivity('Editing files')).toBe('Editing files');
    expect(plainActivity('Drafting the reminders')).toBe('Drafting the reminders');
    expect(plainActivity(null)).toBeNull();
  });
});

describe('failure lines', () => {
  it('says what kind of failure, in the row’s few words', () => {
    expect(failureLine({ kind: 'signed_out' }, 'x')).toBe('Claude Code is signed out');
    expect(failureLine({ kind: 'usage_limit' }, 'x')).toBe('Out of usage');
    expect(failureLine({ kind: 'other' }, "Couldn't start Claude Code: no such file. More")).toBe(
      "Couldn't start Claude Code · didn’t finish"
    );
    // A Codex agent is never said to be signed out of Claude Code.
    expect(failureLine({ kind: 'signed_out' }, 'x', 'codex')).toBe('Codex is signed out');
  });
  it('splits a failure into a pill and its words, out of usage neutral', () => {
    expect(failurePill({ kind: 'usage_limit' }, 'x')).toEqual({
      tone: 'out',
      label: 'Out of usage',
      rest: '',
    });
    // The pill and its words read as the one phrase: "Out of usage until …".
    expect(
      failurePill({ kind: 'usage_limit', resetsAt: Date.now() + 3_600_000 }, 'x').rest
    ).toMatch(/^until /);
    expect(failurePill({ kind: 'signed_out' }, 'x', 'codex')).toEqual({
      tone: 'failed',
      label: 'Signed out',
      rest: 'Codex',
    });
    expect(
      failurePill({ kind: 'other' }, "Couldn't start Claude Code: no such file. More")
    ).toEqual({ tone: 'failed', label: 'Didn’t finish', rest: "Couldn't start Claude Code" });
  });
  it('a retry note keeps the ask and fits a check-in', () => {
    expect(retryNote('Send the invoices')).toContain('“Send the invoices”');
    expect(retryNote('x'.repeat(2000)).length).toBeLessThanOrEqual(600);
    const files = ['/home/a/report.pdf', '/home/a/shot.png'];
    expect(retryNote('Send the invoices', files)).toContain(
      'Files I attached: /home/a/report.pdf, /home/a/shot.png'
    );
    const many = Array.from({ length: 40 }, (_, i) => `/Users/me/agents/finance/files/${i}.pdf`);
    const note = retryNote('x'.repeat(2000), many);
    expect(note.length).toBeLessThanOrEqual(600);
    expect(note).toMatch(/and \d+ more$/);
  });
  it('schedules a retry in whole minutes, never in the past', () => {
    expect(whenAt(10 * 60_000 + 1, 0)).toBe('in 11 minutes');
    expect(whenAt(0, 5)).toBe('in 1 minutes');
  });
});

describe('snippetAround', () => {
  it('starts a few words before the match', () => {
    const s = '… table fixed on mobile and the two dead footer links that pointed nowhere';
    const cut = snippetAround(s, 'footer');
    expect(cut.startsWith('…')).toBe(true);
    expect(cut.indexOf('footer')).toBeLessThan(20);
  });
  it('leaves a snippet whose match is already near the start', () => {
    expect(snippetAround('The footer links', 'footer')).toBe('The footer links');
  });
});

describe('@mentions', () => {
  const named = (id: string, name: string) => ({ id, name }) as Agent;
  const team = [
    named('chief', 'Chief of Staff'),
    named('acme', 'Acme Site'),
    named('fin', 'Finance'),
  ];

  it('finds the mention being typed at the caret', () => {
    expect(mentionAt('ask @fin', 8)).toEqual({ start: 4, query: 'fin' });
    expect(mentionAt('@', 1)).toEqual({ start: 0, query: '' });
    expect(mentionAt('ask @Acme Si', 12)).toEqual({ start: 4, query: 'Acme Si' });
    expect(mentionAt('mail me@example.com', 19)).toBeNull();
    expect(mentionAt('@fin\nmore', 9)).toBeNull();
    expect(mentionAt('@ fin', 5)).toBeNull();
  });

  it('matches names from the start, then any word', () => {
    expect(mentionCandidates(team, 'fi').map((a) => a.id)).toEqual(['fin']);
    expect(mentionCandidates(team, 's').map((a) => a.id)).toEqual(['chief', 'acme']);
    expect(mentionCandidates(team, 'acme s').map((a) => a.id)).toEqual(['acme']);
    expect(mentionCandidates(team, '').length).toBe(3);
  });

  it('reads which agents a message mentions, whole names only', () => {
    const found = mentionedAgents('@Finance and @acme site, not @Fin or a@Finance', team);
    expect(found.map((a) => a.id)).toEqual(['fin', 'acme']);
    expect(mentionedAgents('@Financed', team)).toEqual([]);
  });

  it('splits a bubble around its recorded mentions', () => {
    const runs = mentionRuns('Ask @Finance, then me', [{ id: 'fin', name: 'Finance' }]);
    expect(runs).toEqual([
      { text: 'Ask ' },
      { text: '@Finance', mention: { id: 'fin', name: 'Finance' } },
      { text: ', then me' },
    ]);
    expect(mentionRuns('plain')).toEqual([{ text: 'plain' }]);
  });
});

describe('Team overview', () => {
  const base = {
    hidden: false,
    pinned: false,
    pendingApprovals: 0,
    lastActivityAt: 0,
    status: { state: 'idle', activity: null, since: null },
  };
  const make = (id: string, over: Partial<Agent> = {}) =>
    ({ ...base, id, name: id, ...over }) as Agent;
  const line = (id: string, agentId: string, kind: AgentMessage['kind'], ts: number, text = 'x') =>
    ({ id, agentId, kind, ts, text }) as AgentMessage;

  it('reads a reply as one plain line', () => {
    expect(replyPreview('\n## **Done**: see [PR 12](https://x)\nmore')).toBe('Done: see PR 12');
    expect(replyPreview('| a | b |\n1. `npm` ran')).toBe('npm ran');
  });

  it('sorts the team into working, needs-you, next and recent', () => {
    const agents = [
      make('a', { status: { state: 'working', activity: 'Editing x', since: 1 } }),
      make('b', { pendingApprovals: 1 }),
      make('c', {
        checkIns: [
          { id: 'late', note: 'n', nextAt: 30, createdAt: 0, paused: false },
          { id: 'soon', note: 'n', nextAt: 10, createdAt: 0, paused: false },
          { id: 'off', note: 'n', nextAt: 5, createdAt: 0, paused: true },
        ],
      }),
      make('h', { hidden: true, status: { state: 'working', activity: null, since: 1 } }),
    ];
    const card = {
      ...line('card', 'b', 'approval', 5),
      approval: { requestId: 'r', title: 't', detail: '', status: 'pending' as const },
    };
    const summary = summarizeTeam(agents, {
      a: [line('a1', 'a', 'agent', 3), line('a2', 'a', 'user', 9)],
      b: [card, line('b1', 'b', 'agent', 7)],
      h: [line('h1', 'h', 'agent', 99)],
    });
    expect(summary.working.map((a) => a.id)).toEqual(['a']);
    expect(summary.needsYou.map((n) => [n.agent.id, n.approvals.map((m) => m.id)])).toEqual([
      ['b', ['card']],
    ]);
    expect(summary.scheduled.map((s) => s.checkIn.id)).toEqual(['soon', 'late']);
    expect(summary.replies.map((r) => r.message.id)).toEqual(['b1', 'a1']);
  });

  it('lists a failed turn under Needs you, with its line, and a usage limit as paused', () => {
    const failed = make('f', { failure: { kind: 'other' } });
    const limited = make('l', { failure: { kind: 'usage_limit' } });
    const retrying = make('r', {
      failure: { kind: 'other' },
      status: { state: 'working', activity: null, since: 1 },
    });
    const summary = summarizeTeam([failed, limited, retrying], {
      f: [line('f1', 'f', 'user', 1), line('f2', 'f', 'error', 2)],
    });
    expect(summary.needsYou.map((n) => [n.agent.id, n.failure?.id ?? null])).toEqual([['f', 'f2']]);
    // A usage limit resets by itself: it doesn't need you, and isn't counted as if it did.
    expect(summary.paused.map((n) => n.agent.id)).toEqual(['l']);
    expect(needsAttention(limited)).toBe(false);
    expect(needsAttention(failed)).toBe(true);
  });
});

describe('local paths in agent prose', () => {
  it('reads local hrefs and leaves web links alone', () => {
    expect(localPathFromHref('~/ShipStudio/acme/report.md')).toBe('~/ShipStudio/acme/report.md');
    expect(localPathFromHref('/Users/me/Q3%20report.pdf')).toBe('/Users/me/Q3 report.pdf');
    expect(localPathFromHref('file:///Users/me/a.csv')).toBe('/Users/me/a.csv');
    expect(localPathFromHref('report.md')).toBe('report.md');
    expect(localPathFromHref('https://example.com/a')).toBeNull();
    expect(localPathFromHref('mailto:a@b.c')).toBeNull();
    expect(localPathFromHref('javascript:alert(1)')).toBeNull();
    expect(localPathFromHref('#top')).toBeNull();
    expect(localPathFromHref('//evil.example/x')).toBeNull();
  });

  it('finds written-out paths but not routes or "and/or"', () => {
    const found = (text: string) => PROSE_PATH.exec(text)?.[0] ?? null;
    expect(found('Saved to ~/ShipStudio/acme/report.md.')).toBe('~/ShipStudio/acme/report.md');
    expect(found('see /Users/me/Desktop/notes.txt, then')).toBe('/Users/me/Desktop/notes.txt');
    expect(found('the /careers page')).toBeNull();
    expect(found('this and/or that')).toBeNull();
    expect(isCodePath('~/ShipStudio/acme/Q3 report.md')).toBe(true);
    expect(isCodePath('/careers')).toBe(false);
    expect(isCodePath('npm run build')).toBe(false);
  });

  it('filters the Files list by who shared it', () => {
    const file = (from: SharedFile['from']): SharedFile => ({
      messageId: from,
      ts: 1,
      from,
      name: 'a.pdf',
      path: 'attachments/x/a.pdf',
      mime: 'application/pdf',
      size: 1,
    });
    const files = [file('user'), file('agent')];
    expect(filterFiles(files, 'all')).toHaveLength(2);
    expect(filterFiles(files, 'agent').map((f) => f.from)).toEqual(['agent']);
    expect(filterFiles(files, 'user').map((f) => f.from)).toEqual(['user']);
  });
});

describe('isQueued', () => {
  const working = { status: { state: 'working', activity: null, since: 1000 } } as Agent;
  const user = (ts: number) => msg('u', 'user', ts);
  it('is a message you sent after the turn in progress began', () => {
    expect(isQueued(user(1500), working)).toBe(true);
    expect(isQueued(user(500), working)).toBe(false);
    expect(isQueued(msg('a', 'agent', 1500), working)).toBe(false);
  });
  it('is nothing once the agent is idle', () => {
    const idle = { status: { state: 'idle', activity: null, since: null } } as Agent;
    expect(isQueued(user(1500), idle)).toBe(false);
  });
});

describe('describeScope', () => {
  it('says exactly what stops asking, and that chains still ask', () => {
    const text = describeScope(
      { kind: 'command_prefix', value: 'npm test', label: 'npm test' },
      'Acme Site'
    );
    expect(text).toContain('Any command starting with “npm test” runs for Acme Site');
    expect(text).toContain('still ask');
    expect(describeScope({ kind: 'domain', value: 'a.com', label: 'a.com' }, 'X')).not.toContain(
      'still ask'
    );
  });
});

describe('scheduleWhenPhrase', () => {
  it('writes a schedule back in words the grammar reads as the same schedule', () => {
    const at = (repeat: Parameters<typeof scheduleWhenPhrase>[0]['repeat']) =>
      scheduleWhenPhrase({ repeat, nextAt: 0 });
    expect(at({ kind: 'days', days: [1, 2, 3, 4, 5], hour: 9, minute: 0 })).toBe(
      'every weekday at 09:00'
    );
    expect(at({ kind: 'days', days: [6, 0], hour: 10, minute: 5 })).toBe(
      'every weekend day at 10:05'
    );
    expect(at({ kind: 'days', days: [5, 1, 4], hour: 17, minute: 30 })).toBe(
      'every monday, thursday and friday at 17:30'
    );
    expect(at({ kind: 'every', minutes: 120 })).toBe('every 2 hours');
    expect(at({ kind: 'every', minutes: 45 })).toBe('every 45 minutes');
    const once = new Date(2026, 10, 20, 9, 5).getTime();
    expect(scheduleWhenPhrase({ nextAt: once })).toBe('2026-11-20 09:05');
  });
});

describe('promptAnswer', () => {
  const prompt: SessionPrompt = {
    kind: 'permission',
    project: '/p/demo-site',
    sessionId: 's1',
    tab: 1,
    question: 'Do you want to make this edit to index.html?',
    options: [
      { label: 'Yes', keys: ['1'], role: 'allow' },
      { label: 'Yes, allow all edits during this session', keys: ['2'], role: 'other' },
      { label: 'No', keys: ['3'], role: 'deny' },
    ],
    owner: { id: 'site', name: 'Site Builder' },
    chats: ['site', 'chief'],
  };
  it('resolves Allow, Deny and a specific choice the way the backend does', () => {
    expect(promptAnswer(prompt, true)).toEqual({ status: 'allowed', choice: 'Yes' });
    expect(promptAnswer(prompt, false)).toEqual({ status: 'denied', choice: 'No' });
    expect(promptAnswer(prompt, true, 1).choice).toBe('Yes, allow all edits during this session');
    expect(promptAnswer({ ...prompt, options: [] }, false)).toEqual({
      status: 'denied',
      choice: 'Cancelled',
    });
  });
});

describe('memory', () => {
  const entries = [
    { text: 'Accountant is Sam' },
    { text: 'Prefers EUR' },
    { text: 'Lives in Lisbon', group: 'Imported from Grok Bot' },
    { text: 'Mornings for focus', group: 'Imported from Grok Bot' },
  ];

  it('groups the agent’s own memory first, then each heading', () => {
    const groups = groupMemory(entries);
    expect(groups.map((g) => g.title)).toEqual([null, 'Imported from Grok Bot']);
    expect(groups[1].items.map((i) => i.index)).toEqual([2, 3]);
    // Nothing of its own yet: the group is still there to add to.
    expect(groupMemory(entries.slice(2))[0]).toEqual({ title: null, items: [] });
  });

  it('undoes a delete next to its neighbours in the same group', () => {
    expect(undoDelete(entries, 1, '- Prefers EUR\n')).toEqual({
      op: 'add',
      text: 'Prefers EUR',
      group: undefined,
      after: 'Accountant is Sam',
      before: undefined,
      raw: '- Prefers EUR\n',
    });
    expect(undoDelete(entries, 2, undefined)).toMatchObject({
      group: 'Imported from Grok Bot',
      after: undefined,
      before: 'Mornings for focus',
    });
  });
});

describe('routine models', () => {
  const codexModels = [
    { value: '', label: 'Default' },
    { value: 'gpt-a', label: 'GPT-A' },
  ];
  it('falls back to Haiku only on Claude Code', () => {
    expect(routineModelOf({ engine: 'claude', model: null })).toBe('haiku');
    expect(routineModelOf({ engine: 'codex', model: null })).toBeNull();
    expect(routineModelOf({ engine: 'codex', model: 'gpt-a' })).toBe('gpt-a');
    expect(routineModelOf({ engine: 'codex', model: 'gpt-a', routineModel: 'gpt-b' })).toBe(
      'gpt-b'
    );
  });
  it("offers a Codex agent its engine's models, never Haiku", () => {
    const values = routineModelChoices('codex', codexModels).map((m) => m.value);
    expect(values).toEqual(['', 'gpt-a']);
    expect(routineModelChoices('claude', [{ value: '', label: 'Default' }])[0].label).toBe(
      'Automatic'
    );
  });
});

describe('"When…" routines in words', () => {
  const now = new Date(2026, 10, 5, 15, 0).getTime();
  const min = 60_000;
  const watch = (over: Partial<Watch> = {}): Watch => ({
    source: { kind: 'github_mentions' },
    everyMinutes: 10,
    lastFound: 0,
    failures: 0,
    ...over,
  });
  const row = (w: Watch, extra: Partial<CheckIn> = {}): CheckIn => ({
    id: 'w1',
    note: 'Triage it',
    nextAt: now,
    createdAt: 0,
    paused: false,
    watch: w,
    ...extra,
  });

  it('says what it waits for', () => {
    expect(describeWatchTitle({ kind: 'github_mentions' })).toBe(
      'When someone mentions you on GitHub'
    );
    expect(describeWatchSource({ kind: 'new_file', folder: '/Users/j/Downloads/inv' })).toBe(
      'a new file appears in /Users/j/Downloads/inv'
    );
    expect(describeWatchSource({ kind: 'custom', check: 'a new email from Dana.' })).toBe(
      'a new email from Dana'
    );
    expect(watchUsesModel({ kind: 'linear_assigned' })).toBe(true);
    expect(watchUsesModel({ kind: 'new_file', folder: '/x' })).toBe(false);
    expect([1, 10, 60, 240].map(describeEvery)).toEqual([
      'every minute',
      'every 10 min',
      'every hour',
      'every 4 hours',
    ]);
  });

  it('words a row from what the Mac recorded only', () => {
    expect(describeWatchStatus(row(watch()), now)).toBe(
      'Checks every 10 min · first check soon, to note what’s already there'
    );
    const checked = watch({ baselineAt: now - 60 * min, lastCheckedAt: now - 3 * min });
    expect(describeWatchStatus(row(checked), now)).toBe(
      'Checks every 10 min · checked 3 min ago · nothing new yet'
    );
    const found = { ...checked, lastFound: 2, lastFoundAt: new Date(2026, 10, 5, 14, 0).getTime() };
    expect(describeWatchStatus(row(found), now)).toMatch(
      /^Checks every 10 min · checked 3 min ago · last found 2 today /
    );
    expect(
      describeWatchStatus(
        row(watch({ failures: 2, lastError: 'GitHub CLI isn’t signed in.' })),
        now
      )
    ).toBe('Last check failed: GitHub CLI isn’t signed in.');
    expect(
      describeWatchStatus(
        row(watch({ pausedNote: 'Paused after 5 checks in a row failed: x' }), { paused: true }),
        now
      )
    ).toBe('Paused after 5 checks in a row failed: x');
    expect(describeWatchStatus(row(watch(), { paused: true }), now)).toBe(
      'Paused · checks every 10 min'
    );
  });

  it('says when today’s model checks are done, and an unconfirmed empty first check', () => {
    const day = (ts: number) => {
      const d = new Date(ts);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    };
    const capped = watch({
      source: { kind: 'linear_assigned' },
      baselineAt: now - 60 * min,
      dayChecks: { day: day(now), checks: 24 },
    });
    expect(watchCappedToday(capped, now)).toBe(true);
    expect(describeWatchStatus(row(capped), now)).toBe(
      'Made today’s 24 checks · checks again tomorrow'
    );
    // Yesterday's count doesn't hold today back.
    const yesterday = { ...capped, dayChecks: { day: '2001-01-01', checks: 24 } };
    expect(watchCappedToday(yesterday, now)).toBe(false);
    expect(describeWatchStatus(row(watch({ emptyAnswers: 1 })), now)).toBe(
      'Checks every 10 min · found nothing yet; the next check confirms that before anything starts work'
    );
  });

  it('counts model checks apart from turns, priced only when every one was', () => {
    const t = {
      turns: 0,
      inputTokens: 9000,
      outputTokens: 1000,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 0.168,
      pricedTurns: 0,
      durationMs: 0,
      checks: 40,
      pricedChecks: 40,
    };
    expect(routineWeekLine(t)).toBe('40 checks · $0.17 at API prices this week');
    // On a plan the price isn't the bill.
    expect(routineWeekLine(t, true)).toBe('40 checks · 10k tokens this week');
    expect(routineWeekLine({ ...t, pricedChecks: 39 })).toBe('40 checks · 10k tokens this week');
    expect(formatUsage({ ...t, turns: 2, pricedTurns: 2 })).toBe(
      '$0.17 at API prices · 10k tokens · 2 turns · 40 checks'
    );
    expect(fullyPriced({ ...t, turns: 1, pricedTurns: 0 })).toBe(false);
  });
});

describe('a turn cut off part-way', () => {
  it('offers Continue, never Retry, and says so in a line', () => {
    const asked = { ...msg('u', 'user', 1), text: 'Migrate the blog' };
    const cut = {
      ...msg('e', 'error', 2),
      text: 'Interrupted: the app closed while this agent was working.',
      failure: { kind: 'interrupted' as const },
    };
    expect(continuesFrom([asked, cut])).toBe(true);
    // Retry would send the request again, and could do the work twice.
    expect(retrySourceFor([asked, cut])).toBeNull();
    expect(failureLine(cut.failure, cut.text)).toBe('Interrupted · Continue to pick it up');
    const failed = { ...cut, failure: { kind: 'other' as const } };
    expect(continuesFrom([asked, failed])).toBe(false);
    expect(retrySourceFor([asked, failed])?.id).toBe('u');
  });
});

describe('describeWatchCheck', () => {
  it('names the engine a model check ran on, and nothing for a free one', () => {
    expect(describeWatchCheck({ found: 0, baseline: false })).toBe('Nothing new.');
    expect(describeWatchCheck({ found: 2, baseline: false, engine: 'Codex' })).toBe(
      'Found 2 new; it’s on it. Checked on Codex.'
    );
    expect(describeWatchCheck({ found: 0, baseline: true, engine: 'Claude Code' })).toBe(
      'Noted what’s there now; anything new from here starts work. Checked on Claude Code.'
    );
    expect(describeWatchCheck({ found: 0, baseline: false, error: 'Codex is old.' })).toBe(
      'Check failed: Codex is old.'
    );
  });
});
