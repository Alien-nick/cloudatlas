import { describe, expect, it } from 'vitest'
import type { GraphNode } from '@cloudatlas/shared'
import { dominantPrefix, shortNames } from './names'

function node(id: string, name: string, vpcId: string | null = 'vpc-1'): GraphNode {
  return {
    id, arn: null, type: 'ec2', category: 'compute', name, abbr: 'E',
    typeLabel: 'EC2 instance', region: 'us-east-1', az: null, vpcId, subnetId: null,
    parentId: null, state: 'running', tags: [], props: [], raw: {}, logGroups: [],
    health: 'unknown', securityGroupIds: [], monthlyCostUsd: null, consoleUrl: null,
  }
}

describe('finding the naming convention', () => {
  it('strips the convention a whole VPC is named after', () => {
    expect(
      dominantPrefix([
        'production-moh-supply-chain-db',
        'production-moh-supply-chain-private-2',
        'production-moh-supply-chain-public-1',
      ]),
    ).toBe('production-moh-supply-chain-')
  })

  it('cuts only at a token boundary', () => {
    // "prod" is a common run but not a common token; trimming it would invent
    // a relationship between two unrelated names.
    expect(dominantPrefix(['production-a', 'prodigy-b', 'prodding-c'])).toBe('')
  })

  it('leaves enough behind to stay meaningful', () => {
    // Shortening these to "1", "2", "3" is worse than truncating them.
    expect(dominantPrefix(['app-server-1', 'app-server-2', 'app-server-3'])).toBe('')
  })

  it('ignores a prefix too few names share', () => {
    expect(dominantPrefix(['shared-alpha', 'shared-beta'])).toBe('')
  })

  it('does not require unanimity, because real VPCs are not uniform', () => {
    // The case that matters: convention-named resources alongside bare
    // instance ids. Requiring every name to match means the rule never fires
    // on the accounts that most need it.
    expect(
      dominantPrefix([
        'production-moh-supply-chain-db',
        'production-moh-supply-chain-cache',
        'production-moh-supply-chain-web',
        'i-05ccfb57a27a15d5',
        'i-008637aa68cd88ab',
      ]),
    ).toBe('production-moh-supply-chain-')
  })

  it('ignores a prefix only a minority carries', () => {
    expect(
      dominantPrefix([
        'production-moh-supply-chain-db',
        'production-moh-supply-chain-web',
        'alpha',
        'beta',
        'gamma',
        'delta',
        'epsilon',
      ]),
    ).toBe('')
  })

  it('prefers the longer of two nested conventions', () => {
    expect(
      dominantPrefix([
        'prod-supply-chain-db',
        'prod-supply-chain-web',
        'prod-supply-chain-cache',
      ]),
    ).toBe('prod-supply-chain-')
  })

  it('ignores a prefix too short to be worth removing', () => {
    expect(dominantPrefix(['a-one-thing', 'a-two-thing', 'a-three-thing'])).toBe('')
  })

  it('returns nothing when names have nothing in common', () => {
    expect(dominantPrefix(['alpha', 'beta', 'gamma'])).toBe('')
    expect(dominantPrefix([])).toBe('')
  })
})

describe('shortening across a graph', () => {
  it('shortens within a VPC, and only within it', () => {
    const nodes = [
      node('a', 'production-moh-supply-chain-db', 'vpc-1'),
      node('b', 'production-moh-supply-chain-cache', 'vpc-1'),
      node('c', 'production-moh-supply-chain-web', 'vpc-1'),
      // A different VPC with its own convention.
      node('d', 'beharry-sims-production-app-1', 'vpc-2'),
      node('e', 'beharry-sims-production-app-2', 'vpc-2'),
      node('f', 'beharry-sims-production-data', 'vpc-2'),
    ]
    const short = shortNames(nodes)
    expect(short.get('a')).toBe('db')
    expect(short.get('c')).toBe('web')
    // Scoped per VPC: the two conventions are unrelated and must not merge.
    expect(short.get('d')).toBe('app-1')
    expect(short.get('f')).toBe('data')
  })

  it('leaves names outside the convention alone', () => {
    const nodes = [
      node('a', 'production-moh-supply-chain-db'),
      node('b', 'production-moh-supply-chain-cache'),
      node('c', 'production-moh-supply-chain-web'),
      node('d', 'i-05ccfb57a27a15d5'),
    ]
    const short = shortNames(nodes)
    expect(short.get('a')).toBe('db')
    // An instance id does not carry the prefix and is left untouched rather
    // than mangled.
    expect(short.has('d')).toBe(false)
  })

  it('leaves a VPC with no convention untouched', () => {
    const nodes = [
      node('a', 'web', 'vpc-1'),
      node('b', 'database', 'vpc-1'),
      node('c', 'cache', 'vpc-1'),
    ]
    expect(shortNames(nodes).size).toBe(0)
  })

  it('never shortens a region or lane container', () => {
    const nodes = [
      { ...node('r', 'Region · us-east-1', null), type: 'region' as const },
      { ...node('l', 'Regional services', null), type: 'lane' as const },
      node('a', 'production-moh-supply-chain-db'),
      node('b', 'production-moh-supply-chain-cache'),
      node('c', 'production-moh-supply-chain-web'),
    ]
    const short = shortNames(nodes)
    expect(short.has('r')).toBe(false)
    expect(short.has('l')).toBe(false)
    expect(short.get('a')).toBe('db')
  })
})
