/**
 * Pairing from a link never happens without asking, and says what it would
 * replace. A link is untrusted: any page or message can open one.
 */

import {
  formatPairingLink,
  OTHER_APP_PAIRING_SCHEME,
  PAIRING_SCHEME,
  PREVIOUS_PAIRING_SCHEME,
  type PairingLink,
} from '@shipstudio/companion-protocol';
import { cleanName, linkHost, linkProblem, pairPlan, parseLink } from '../src/lib/pairing';

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

  it('show the host the phone would talk to, the only one it will try', () => {
    expect(linkHost(link)).toBe('julians-mbp.tail1234.ts.net:47443');
    // A second route the confirm screen wouldn't show: no link at all.
    const two = {
      ...link,
      routes: [...link.routes, { kind: 'tailscale', url: 'https://attacker.tail9.ts.net' }],
    } as PairingLink;
    expect(parseLink(formatPairingLink(two))).toBeNull();
  });

  // A new phone, an old Mac: say what to do, not "that isn't a link".
  it('say to update the Mac when its link carries no identity', () => {
    const { fingerprint: _, ...old } = link;
    expect(parseLink(formatPairingLink(old as PairingLink))).toBeNull();
    expect(linkProblem(formatPairingLink(old as PairingLink))).toMatch(
      /^Update the app on your Mac to pair/
    );
    expect(linkProblem('hello')).toMatch(/isn’t a pairing code/);
  });

  // A Mac still on the build from before the app's rename: its code says why.
  it('say to update the Mac when its code is from before the rename', () => {
    const body = formatPairingLink(link).slice(PAIRING_SCHEME.length);
    expect(linkProblem(`${PREVIOUS_PAIRING_SCHEME}${body}`)).toMatch(
      /^Update the app on your Mac to pair.*before the app was renamed/
    );
    expect(linkProblem(`${OTHER_APP_PAIRING_SCHEME}${body}`)).toMatch(/different app’s phone app/);
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

  it('pairs the same Mac again only when the key matches the pinned one', () => {
    expect(pairPlan(link, current)).toEqual({ kind: 'again' });
    // Paired before identity keys: nothing pinned, so nothing to vouch for
    // the link. It isn't called "already paired", just a replacement.
    expect(pairPlan(link, { ...current, fingerprint: undefined })).toEqual({
      kind: 'replace',
      current: 'Julian’s MacBook Pro',
    });
  });

  // The paired Mac's id with a different key: a look-alike, refused outright.
  it('stops a link that claims the paired Mac with another key', () => {
    expect(pairPlan({ ...link, fingerprint: 'AAAAAAAAAAAAAAAAAAAAAA' }, current)).toEqual({
      kind: 'impostor',
      current: 'Julian’s MacBook Pro',
    });
  });
});
