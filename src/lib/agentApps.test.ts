import { describe, expect, it } from 'vitest';
import {
  appManagedWhere,
  appStatusLabel,
  appTarget,
  appTitle,
  defaultGrantees,
  grantsLine,
  ourAppFor,
} from './agentApps';

describe('agent apps wording', () => {
  it('names a claude.ai connector by the app, and a server by its own name', () => {
    expect(appTitle({ name: 'claude.ai Google Drive', source: 'claudeAi' })).toBe('Google Drive');
    expect(appTitle({ name: 'figma', source: 'user' })).toBe('Figma');
    expect(appTitle({ name: 'google-drive', source: 'other' })).toBe('Google Drive');
  });

  it('shows a URL as its host and a command as written', () => {
    expect(appTarget('https://mcp.figma.com/mcp')).toBe('mcp.figma.com');
    expect(appTarget('npx @playwright/mcp@latest')).toBe('npx @playwright/mcp@latest');
  });

  it('only words statuses Claude Code actually reported', () => {
    expect(appStatusLabel('needs_auth')).toBe('Needs sign-in');
    expect(appStatusLabel('unknown')).toBeNull();
  });

  it('says where an app it cannot remove is managed', () => {
    expect(appManagedWhere('user')).toBeNull();
    expect(appManagedWhere('claudeAi')).toBe('Managed on claude.ai');
  });
});

describe('connecting from the apps dialog', () => {
  const team = [
    { id: 'chief', isMain: true },
    { id: 'ops', isMain: false },
  ];

  it('starts with the agent it was opened for, else the Chief, never everyone', () => {
    expect(defaultGrantees(team, 'ops')).toEqual(['ops']);
    expect(defaultGrantees(team, 'gone')).toEqual(['chief']);
    expect(defaultGrantees(team)).toEqual(['chief']);
    expect(defaultGrantees([])).toEqual([]);
  });

  it('says who can use a connection, and how', () => {
    const names = new Map([
      ['chief', 'Chief'],
      ['ops', 'Ops'],
      ['rex', 'Rex'],
    ]);
    expect(grantsLine({ grants: [] }, names)).toBe('No agent can use it yet');
    expect(
      grantsLine(
        {
          grants: [
            { agentId: 'chief', access: 'read', grantedAt: 0 },
            { agentId: 'ops', access: 'read', grantedAt: 0 },
            { agentId: 'rex', access: 'full', grantedAt: 0 },
          ],
        },
        names
      )
    ).toBe('Rex can read and change (asks first); Chief and Ops can read');
  });

  it('knows a Claude Code server is one of ours by its host', () => {
    const ours = [
      { service: 'vercel', title: 'Vercel', read: '', write: '', host: 'mcp.vercel.com' },
    ];
    expect(
      ourAppFor({ name: 'my-vercel', target: 'https://mcp.vercel.com', source: 'user' }, ours)
    ).toBe(ours[0]);
    expect(
      ourAppFor(
        { name: 'claude.ai Vercel', target: 'https://mcp.vercel.com', source: 'claudeAi' },
        ours
      )
    ).toBeUndefined();
    expect(
      ourAppFor({ name: 'webflow', target: 'https://mcp.webflow.com/mcp', source: 'user' }, ours)
    ).toBeUndefined();
  });
});
