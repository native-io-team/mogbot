import { describe, expect, it } from 'vitest';
import {
  connectionStep,
  describeAudit,
  assistantName,
  describeLastRequest,
  isReadyToLeave,
  isSetupComplete,
  liveState,
  pinProblem,
  readinessItems,
  remoteProblem,
  assistantGuides,
  setupSteps,
  TAILSCALE_ACLS_URL,
  TAILSCALE_DNS_URL,
  type RemoteAccessStatus,
  type SetupChoices,
} from './remoteAccess';

const MASKED = 'https://studio-mac.tail1234.ts.net/shipstudio/mcp/3f9c••••••••';

function status(overrides: Partial<RemoteAccessStatus> = {}): RemoteAccessStatus {
  return {
    supported: true,
    enabled: true,
    serverRunning: true,
    tailscale: { state: 'connected', dnsName: 'studio-mac.tail1234.ts.net' },
    funnelOn: true,
    funnelApprovalUrl: null,
    funnelError: null,
    linkMasked: MASKED,
    reachability: { state: 'reachable' },
    publish: { sinceMs: null, autoRetried: false, gaveUp: false },
    power: { hasBattery: true, onAc: true, batteryPercent: 90, charging: true },
    keepAwake: true,
    lidClosedMode: true,
    openAtLogin: true,
    openAtLoginAvailable: true,
    pushPin: 'notSet',
    projects: ['/p'],
    everConnected: false,
    activity: { lastRequestMs: null, lastClient: null, rejectedRequests: 0 },
    ...overrides,
  };
}

const none: SetupChoices = { understood: false, projectsConfirmed: false, pushingSkipped: false };
const all: SetupChoices = { understood: true, projectsConfirmed: true, pushingSkipped: true };

describe('readinessItems', () => {
  it('is ready when a plugged-in, awake laptop survives the lid and restarts', () => {
    expect(isReadyToLeave(status())).toBe(true);
  });

  it('flags battery power with the level', () => {
    const power = readinessItems(
      status({ power: { hasBattery: true, onAc: false, batteryPercent: 41, charging: false } })
    ).find((i) => i.id === 'power');
    expect(power?.state).toBe('warn');
    expect(power?.title).toBe('On battery (41%)');
  });

  it('never claims power is fine when it could not be read', () => {
    const items = readinessItems(
      status({ power: { hasBattery: false, onAc: null, batteryPercent: null, charging: null } })
    );
    expect(items.find((i) => i.id === 'power')?.state).toBe('warn');
  });

  it('only asks about the lid on machines that have one', () => {
    const desktop = status({
      power: { hasBattery: false, onAc: true, batteryPercent: null, charging: null },
      lidClosedMode: false,
    });
    expect(readinessItems(desktop).some((i) => i.id === 'lid')).toBe(false);
    expect(isReadyToLeave(desktop)).toBe(true);
    expect(isReadyToLeave(status({ lidClosedMode: false }))).toBe(false);
  });

  it('warns when the computer may sleep or will not come back after a restart', () => {
    expect(isReadyToLeave(status({ keepAwake: false }))).toBe(false);
    expect(isReadyToLeave(status({ openAtLogin: false }))).toBe(false);
  });
});

describe('connectionStep', () => {
  it('walks the blockers in order', () => {
    expect(connectionStep(status({ supported: false })).kind).toBe('unsupported');
    expect(connectionStep(status({ tailscale: { state: 'notInstalled' } })).kind).toBe(
      'installTailscale'
    );
    expect(connectionStep(status({ tailscale: { state: 'needsLogin' } })).kind).toBe(
      'signInTailscale'
    );
    expect(connectionStep(status({ enabled: false, linkMasked: null })).kind).toBe('off');
    expect(connectionStep(status({ serverRunning: false, linkMasked: null })).kind).toBe(
      'serverStopped'
    );
  });

  it('shows the link only when the backend confirmed it', () => {
    expect(connectionStep(status())).toEqual({ kind: 'ready', linkMasked: MASKED });
    expect(connectionStep(status({ linkMasked: null })).kind).toBe('starting');
  });

  it('is not ready until the internet can actually reach it', () => {
    // The bug a real user hit: Funnel configured, public DNS not published
    // yet, and we said "live" while Grok Bot couldn't resolve the name.
    expect(connectionStep(status({ reachability: { state: 'noPublicDns' } }))).toMatchObject({
      kind: 'publishing',
      linkMasked: MASKED,
      stage: 'waiting',
    });
    expect(connectionStep(status({ reachability: null })).kind).toBe('publishing');
    expect(
      connectionStep(status({ reachability: { state: 'unreachable', detail: 'timed out' } }))
    ).toEqual({ kind: 'unreachable', linkMasked: MASKED, detail: 'timed out' });
  });

  it('surfaces the Funnel approval link and failures', () => {
    expect(
      connectionStep(
        status({ linkMasked: null, funnelApprovalUrl: 'https://login.tailscale.com/f/x' })
      )
    ).toEqual({
      kind: 'approveFunnel',
      url: 'https://login.tailscale.com/f/x',
      approves: 'funnel',
    });
    expect(connectionStep(status({ linkMasked: null, funnelError: 'boom' }))).toEqual({
      kind: 'funnelFailed',
      detail: 'boom',
      problem: 'other',
    });
  });

  it('tells switched off and not open apart from signed out', () => {
    const ts = { state: 'needsLogin' } as const;
    expect(connectionStep(status({ tailscale: ts, tailscaleBackend: 'Stopped' })).kind).toBe(
      'tailscaleOff'
    );
    expect(connectionStep(status({ tailscale: ts, tailscaleBackend: 'NotRunning' })).kind).toBe(
      'openTailscale'
    );
    expect(connectionStep(status({ tailscale: ts, tailscaleBackend: 'NeedsLogin' })).kind).toBe(
      'signInTailscale'
    );
  });
});

describe('remoteProblem', () => {
  const failed = (kind: NonNullable<RemoteAccessStatus['funnelProblem']>['kind']) =>
    remoteProblem(status({ linkMasked: null, funnelError: 'x', funnelProblem: { kind } }));

  it('gives every failure one line, one fix and one action', () => {
    const cases: [Partial<RemoteAccessStatus>, string][] = [
      [{ supported: false }, 'unsupported'],
      [{ tailscale: { state: 'notInstalled' } }, 'tailscaleMissing'],
      [
        { tailscale: { state: 'needsLogin' }, tailscaleBackend: 'NotRunning' },
        'tailscaleNotRunning',
      ],
      [{ tailscale: { state: 'needsLogin' }, tailscaleBackend: 'Stopped' }, 'tailscaleOff'],
      [{ tailscale: { state: 'needsLogin' } }, 'tailscaleSignedOut'],
      [{ tailscale: { state: 'unknown', detail: '???' } }, 'tailscaleUnreadable'],
      [{ enabled: false, linkMasked: null }, 'remoteOff'],
      [{ serverRunning: false }, 'serverStopped'],
      [
        {
          linkMasked: null,
          funnelApprovalUrl: 'https://login.tailscale.com/f/serve?node=n',
          funnelApprovalKind: 'https',
        },
        'httpsNeedsApproval',
      ],
      [
        { linkMasked: null, funnelApprovalUrl: 'https://login.tailscale.com/f/funnel?node=n' },
        'funnelNeedsApproval',
      ],
      [{ linkMasked: null }, 'publishing'],
      [{ reachability: { state: 'noPublicDns' } }, 'publishing'],
      [
        {
          reachability: { state: 'noPublicDns' },
          publish: { sinceMs: 0, autoRetried: true, gaveUp: true },
        },
        'publishStuck',
      ],
      [
        { reachability: { state: 'unreachable', detail: 'public DNS lookup failed: offline' } },
        'cantCheckFromHere',
      ],
      [
        {
          reachability: {
            state: 'unreachable',
            detail: 'Something answered at this address, but not this app.',
          },
        },
        'notThisApp',
      ],
      [{ reachability: { state: 'unreachable', detail: 'Couldn’t reach' } }, 'unreachable'],
      [{}, 'noAssistantYet'],
    ];
    for (const [over, id] of cases) {
      const p = remoteProblem(status(over));
      expect(p?.id, JSON.stringify(over)).toBe(id);
      expect(p?.line.length).toBeGreaterThan(0);
      expect(p?.fix.length).toBeGreaterThan(0);
      expect(p?.line).not.toMatch(/\n/);
    }
    expect(failed('httpsOff')?.id).toBe('httpsOff');
    expect(failed('httpsOff')?.action).toMatchObject({ kind: 'openUrl', url: TAILSCALE_DNS_URL });
    expect(failed('funnelNotAllowed')?.action).toMatchObject({ url: TAILSCALE_ACLS_URL });
    expect(failed('portNotAllowed')?.id).toBe('funnelPortNotAllowed');
    expect(failed('portsInUse')?.id).toBe('funnelPortsInUse');
    expect(failed('timedOut')?.id).toBe('funnelTimedOut');
    expect(failed('other')?.line).toContain('x');
  });

  it('is nothing once the link works and an assistant has used it', () => {
    expect(remoteProblem(status({ everConnected: true }))).toBeNull();
  });
});

describe('assistantGuides', () => {
  it('says where to paste the link in each assistant, and never into a chat', () => {
    const guides = assistantGuides('Mogbot');
    expect(guides.map((g) => g.id)).toEqual(['claude', 'chatgpt', 'grok', 'other']);
    for (const g of guides) {
      expect(g.steps.join(' ')).toContain('Mogbot');
      expect(g.steps.join(' ')).not.toMatch(/paste it into the chat/i);
    }
    expect(guides[0].steps.join(' ')).toMatch(/Add custom connector/);
    expect(guides[0].steps.join(' ')).toMatch(/No sign in/);
    expect(guides[1].steps.join(' ')).toMatch(/Developer mode/);
    expect(guides[1].steps.join(' ')).toMatch(/No authentication/);
    expect(guides[2].url).toBe('https://grok.com/connectors');
  });

  it('opens only pages the vendor documents, each button saying where it goes', () => {
    const [claude, chatgpt, grok, other] = assistantGuides('Mogbot');
    // support.claude.com names this page; ChatGPT documents no settings URL.
    expect(claude.url).toBe('https://claude.ai/customize/connectors');
    expect(claude.urlLabel).toBe('Open Claude’s connector settings');
    expect(chatgpt.url).toBe('https://chatgpt.com/');
    expect(chatgpt.urlLabel).toBe('Open ChatGPT');
    expect(grok.urlLabel).toMatch(/Grok’s connector settings/);
    expect(other.url).toBeUndefined();
  });
});

describe('setupSteps', () => {
  const current = (s: RemoteAccessStatus, c: SetupChoices) =>
    setupSteps(s, c).find((step) => step.state === 'current')?.id;

  it('starts with the stay-on warning, before anything technical', () => {
    expect(current(status({ enabled: false, linkMasked: null }), none)).toBe('stayOn');
  });

  it('moves on only when each step is actually true', () => {
    const c = { ...none, understood: true };
    expect(current(status({ linkMasked: null }), c)).toBe('connect');
    expect(current(status({ projects: [] }), c)).toBe('projects');
    expect(current(status(), c)).toBe('projects'); // ticked, but not confirmed yet
    expect(current(status(), { ...c, projectsConfirmed: true })).toBe('pushing');
    expect(current(status({ pushPin: 'set' }), { ...c, projectsConfirmed: true })).toBe(
      'assistant'
    );
  });

  it('is complete only once an assistant has connected', () => {
    expect(isSetupComplete(status(), all)).toBe(false);
    expect(isSetupComplete(status({ everConnected: true }), all)).toBe(true);
  });

  it('a past connection carries the user straight to the live view', () => {
    expect(isSetupComplete(status({ everConnected: true }), none)).toBe(true);
  });

  it('marks later steps upcoming, even if they happen to be true', () => {
    const steps = setupSteps(status({ pushPin: 'set' }), none);
    expect(steps.map((s) => s.state)).toEqual([
      'current',
      'upcoming',
      'upcoming',
      'upcoming',
      'upcoming',
    ]);
  });
});

describe('publishing', () => {
  const at = (sinceMs: number, over = {}) =>
    status({
      reachability: { state: 'noPublicDns' },
      publish: { sinceMs, autoRetried: false, gaveUp: false, ...over },
    });

  it('counts the minutes and moves from waiting to retried to stuck', () => {
    expect(connectionStep(at(0), 3 * 60_000)).toMatchObject({ stage: 'waiting', minutes: 3 });
    expect(connectionStep(at(0, { autoRetried: true }), 4 * 60_000)).toMatchObject({
      stage: 'retried',
    });
    expect(connectionStep(at(0, { autoRetried: true }), 11 * 60_000)).toMatchObject({
      stage: 'stuck',
    });
    expect(connectionStep(at(0, { gaveUp: true }), 60_000)).toMatchObject({ stage: 'stuck' });
  });
});

describe('liveState', () => {
  it('is live only with a confirmed link', () => {
    expect(liveState(status())).toBe('live');
    expect(liveState(status({ linkMasked: null, reachability: null }))).toBe('down');
    expect(liveState(status({ reachability: { state: 'noPublicDns' } }))).toBe('down');
    expect(liveState(status({ enabled: false }))).toBe('off');
  });

  it('never trusts a reachability reading without a link or a server', () => {
    // A stale "reachable" once the Funnel dropped read as Live.
    expect(liveState(status({ linkMasked: null }))).toBe('down');
    expect(liveState(status({ serverRunning: false }))).toBe('down');
  });
});

describe('describeLastRequest', () => {
  const now = 1_000_000_000;
  it('says nothing when nothing has connected', () => {
    expect(
      describeLastRequest({ lastRequestMs: null, lastClient: null, rejectedRequests: 0 }, now)
    ).toBeNull();
  });
  it('names the client the server was told about', () => {
    expect(
      describeLastRequest(
        { lastRequestMs: now - 180_000, lastClient: 'grok', rejectedRequests: 0 },
        now
      )
    ).toBe('Grok, last heard from 3 min ago');
  });
  it('names assistants as people know them, and anything else as sent', () => {
    expect(assistantName('claude-ai')).toBe('Claude');
    expect(assistantName('openai-mcp')).toBe('ChatGPT');
    expect(assistantName('cursor-vscode')).toBe('Cursor');
    expect(assistantName('my-bot')).toBe('My-bot');
  });
});

describe('describeAudit', () => {
  const base = { atMs: 0, project: '/Users/a/ShipStudio/site', detail: '', ok: true };
  it('reads like a sentence', () => {
    expect(describeAudit({ ...base, tool: 'send_to_agent', detail: 'fix the header' })).toBe(
      'Sent a message in site: “fix the header”'
    );
    expect(describeAudit({ ...base, tool: 'confirm_push' })).toBe('Pushed in site');
    expect(describeAudit({ ...base, tool: 'confirm_push', ok: false })).toBe(
      'Push refused in site'
    );
    expect(describeAudit({ ...base, tool: 'press_key', detail: 'key enter' })).toBe(
      'Pressed enter in site'
    );
    expect(describeAudit({ ...base, project: null, tool: 'connected', detail: 'grok' })).toBe(
      'Grok connected'
    );
  });
});

describe('pinProblem', () => {
  it('matches the backend rules', () => {
    expect(pinProblem('482915')).toBeNull();
    expect(pinProblem('12345')).not.toBeNull();
    expect(pinProblem('1234567890123')).not.toBeNull();
    expect(pinProblem('000000')).not.toBeNull();
    expect(pinProblem('123456')).not.toBeNull();
    expect(pinProblem('987654')).not.toBeNull();
  });
});
