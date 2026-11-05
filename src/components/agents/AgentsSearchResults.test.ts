import { describe, expect, it } from 'vitest';
import { nameMatches } from './AgentsSearchResults';
import type { Agent } from '../../lib/agents';

const a = (id: string, name: string) => ({ id, name }) as Agent;
const TEAM = [a('qa', 'Storefront QA'), a('dev', 'Online Storefront Dev'), a('fin', 'Finance')];

describe('nameMatches', () => {
  it('finds agents by any part of the name, in list order', () => {
    expect(nameMatches(TEAM, 'storefront').map((x) => x.id)).toEqual(['qa', 'dev']);
  });
  it('needs every word, in any case', () => {
    expect(nameMatches(TEAM, 'STOREFRONT dev').map((x) => x.id)).toEqual(['dev']);
  });
  it('matches nothing for an empty query', () => {
    expect(nameMatches(TEAM, '   ')).toEqual([]);
  });
});
