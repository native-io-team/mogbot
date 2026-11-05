/**
 * Pairing from a link never happens without asking, and says what it would
 * replace. A link is untrusted: any page or message can open one.
 */

import { formatPairingLink, type PairingLink } from '@shipstudio/companion-protocol';
import { cleanName, linkHost, pairPlan, parseLink } from '../src/lib/pairing';

const link: PairingLink = {
  v: 1,
  code: 'K7Q2MZX4A9PL3WRT8NBV6YHC5D',
  serverId: 'srv_1',
  name: 'Julian’s MacBook Pro',
  routes: [{ kind: 'tailscale', url: 'https://julians-mbp.tail1234.ts.net:47443' }],
  fingerprint: 'Zmh6rfhivXdsj8GLjp-OIA',
};

describe('pairing links', () => {
  it('take a Tailscale route only on a tailnet host', () => {
    expect(parseLink(formatPairingLink(link))).toEqual(link);
    const evil = { ...link, routes: [{ kind: 'tailscale', url: 'https://evil.example' }] };
    expect(parseLink(formatPairingLink(evil as PairingLink))).toBeNull();
  });

  it('show the host the phone would talk to', () => {
    expect(linkHost(link)).toBe('julians-mbp.tail1234.ts.net:47443');
  });

  it('show names without invisible or reordering characters', () => {
    expect(cleanName('Julian’s Mac\u202Eorp kooBcaM\u200B')).toBe('Julian’s Macorp kooBcaM');
    expect(cleanName('a\n\tb')).toBe('a b');
    expect(cleanName('\u200B\u202E')).toBe('your Mac');
    expect(cleanName('x'.repeat(200))).toHaveLength(60);
  });
});

describe('pairPlan', () => {
  const current = {
    serverId: 'srv_1',
    name: 'Julian’s MacBook Pro',
    fingerprint: link.fingerprint,
  };

  it('is new with no Mac paired', () => {
    expect(pairPlan(link, null)).toEqual({ kind: 'new' });
  });

  it('warns that another Mac replaces the paired one', () => {
    expect(pairPlan({ ...link, serverId: 'srv_2', name: 'Studio' }, current)).toEqual({
      kind: 'replace',
      current: 'Julian’s MacBook Pro',
    });
  });

  it('pairs the same Mac again', () => {
    expect(pairPlan(link, current)).toEqual({ kind: 'again' });
    // Paired before identity keys: nothing pinned to contradict.
    expect(pairPlan(link, { ...current, fingerprint: undefined })).toEqual({ kind: 'again' });
  });

  // The paired Mac's id with a different key: a look-alike, refused outright.
  it('stops a link that claims the paired Mac with another key', () => {
    expect(pairPlan({ ...link, fingerprint: 'AAAAAAAAAAAAAAAAAAAAAA' }, current)).toEqual({
      kind: 'impostor',
      current: 'Julian’s MacBook Pro',
    });
  });
});
