import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AgentsSlackSettings } from './AgentsSlackSettings';
import { slackLine, viaLabel, whereLine, type SlackStatus } from '../../lib/slack';

const invoke = vi.hoisted(() => vi.fn());
const openUrl = vi.hoisted(() => vi.fn(() => Promise.resolve()));
vi.mock('@tauri-apps/api/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tauri-apps/api/core')>()),
  invoke,
}));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));
vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl }));

// A fictional workspace.
const status = (over: Partial<SlackStatus> = {}): SlackStatus => ({
  connected: false,
  enabled: false,
  needsSignIn: false,
  conversations: [],
  trigger: 'dashbot:',
  defaultTrigger: 'dashbot:',
  othersCanStart: false,
  waiting: 0,
  setupUrl: 'https://api.slack.com/apps?new_app=1&manifest_json=%7B%7D',
  ...over,
});

const connected = (over: Partial<SlackStatus> = {}) =>
  status({
    connected: true,
    enabled: true,
    team: 'Northwind',
    user: 'robin',
    agentId: 'chief',
    agentName: 'Chief of Staff',
    conversations: [
      { id: 'D0SELF', kind: 'self', name: 'Your own DM' },
      { id: 'C0LAUNCH', kind: 'channel', name: '#launch' },
    ],
    lastCheckAt: Date.now(),
    ...over,
  });

const calls = (cmd: string) => invoke.mock.calls.filter(([c]) => c === cmd);

describe('AgentsSlackSettings', () => {
  beforeEach(() => {
    invoke.mockReset();
    openUrl.mockClear();
  });

  it('walks through the three steps and sends the token only on Connect', async () => {
    invoke.mockImplementation((cmd: string) => {
      if (cmd === 'agents_slack_connect') return Promise.resolve(connected());
      return Promise.resolve(status());
    });
    render(<AgentsSlackSettings />);
    expect(await screen.findByText('1. Create the Slack app')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Open Slack…' }));
    expect(openUrl).toHaveBeenCalledWith(status().setupUrl);

    const field = screen.getByLabelText('User OAuth Token');
    expect(field.getAttribute('type')).toBe('password');
    const connect = screen.getByRole('button', { name: 'Connect' });
    expect(connect.hasAttribute('disabled')).toBe(true);
    fireEvent.change(field, { target: { value: '  xoxp-1-2-abc  ' } });
    fireEvent.click(connect);
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('agents_slack_connect', { token: 'xoxp-1-2-abc' })
    );
    // Connected: the steps give way to the settings.
    expect(await screen.findByRole('switch', { name: 'Listen in Slack' })).toBeTruthy();
    expect(screen.queryByLabelText('User OAuth Token')).toBeNull();
  });

  it('changes each setting with one call, and disconnects', async () => {
    invoke.mockImplementation((cmd: string, args?: { patch?: Record<string, unknown> }) => {
      if (cmd === 'agents_slack_update') return Promise.resolve(connected(args?.patch));
      if (cmd === 'agents_slack_disconnect') return Promise.resolve(status());
      return Promise.resolve(connected());
    });
    render(<AgentsSlackSettings />);
    expect(await screen.findByText('Your own DM and #launch')).toBeTruthy();

    fireEvent.click(screen.getByRole('switch', { name: 'Let others start it' }));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('agents_slack_update', {
        patch: { othersCanStart: true },
      })
    );

    const trigger = screen.getByLabelText('Trigger');
    fireEvent.change(trigger, { target: { value: 'hey team:' } });
    fireEvent.blur(trigger);
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('agents_slack_update', {
        patch: { trigger: 'hey team:' },
      })
    );
    // Unchanged: no call.
    const before = calls('agents_slack_update').length;
    fireEvent.blur(screen.getByLabelText('Trigger'));
    expect(calls('agents_slack_update').length).toBe(before);

    fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }));
    await waitFor(() => expect(calls('agents_slack_disconnect').length).toBe(1));
    expect(await screen.findByText('1. Create the Slack app')).toBeTruthy();
  });

  it('a refused sign-in asks for a new token, keeping the settings', async () => {
    invoke.mockResolvedValue(connected({ needsSignIn: true }));
    render(<AgentsSlackSettings />);
    expect(
      await screen.findByText(/Slack refused the sign-in for Northwind as robin/)
    ).toBeTruthy();
    expect(screen.getByLabelText('User OAuth Token')).toBeTruthy();
    expect(
      screen.getByRole('switch', { name: 'Listen in Slack' }).getAttribute('aria-checked')
    ).toBe('false');
  });

  it('picks conversations from what Slack lists', async () => {
    invoke.mockImplementation((cmd: string, args?: { patch?: Record<string, unknown> }) => {
      if (cmd === 'agents_slack_conversations')
        return Promise.resolve([
          { id: 'D0SELF', kind: 'self', name: 'Your own DM' },
          { id: 'C0LAUNCH', kind: 'channel', name: '#launch' },
          { id: 'D0SAM', kind: 'im', name: 'Sam' },
        ]);
      if (cmd === 'agents_slack_update') return Promise.resolve(connected(args?.patch));
      return Promise.resolve(connected());
    });
    render(<AgentsSlackSettings />);
    fireEvent.click(await screen.findByRole('button', { name: 'Choose…' }));
    const sam = await screen.findByRole('checkbox', { name: 'Sam' });
    fireEvent.click(sam);
    await waitFor(() => expect(calls('agents_slack_update').length).toBe(1));
    const patch = calls('agents_slack_update')[0][1] as {
      patch: { conversations: { id: string }[] };
    };
    expect(patch.patch.conversations.map((c) => c.id)).toEqual(['D0SELF', 'C0LAUNCH', 'D0SAM']);
  });
});

describe('the Slack words', () => {
  it('says what is known, and nothing else', () => {
    expect(slackLine(null)).toMatch(/nothing runs on a server/);
    expect(slackLine(connected({ enabled: false }))).toBe(
      'Connected to Northwind as robin. Off: nothing is read.'
    );
    expect(slackLine(connected({ lastError: 'Couldn’t reach Slack.' }))).toBe(
      'On, but the last check didn’t work: Couldn’t reach Slack.'
    );
    const now = 1_000_000;
    expect(slackLine(connected({ lastCheckAt: now - 5_000 }), now)).toBe(
      'On in Northwind as robin. Checked just now.'
    );
    expect(slackLine(connected({ lastCheckAt: null }), now)).toBe('On in Northwind as robin.');
  });

  it('names where it listens, and where a message came from', () => {
    expect(whereLine([])).toMatch(/Nowhere yet/);
    const c = (name: string) => ({ id: name, kind: 'channel', name });
    expect(whereLine([c('#a'), c('#b'), c('#c'), c('#d')])).toBe('#a, #b and 2 more');
    expect(viaLabel({ source: 'slack', place: '#launch' })).toBe('From Slack · #launch');
    expect(viaLabel(undefined)).toBeNull();
  });
});
