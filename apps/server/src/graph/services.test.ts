import { describe, expect, it } from 'vitest'
import type { GraphNode } from '@cloudatlas/shared'
import { encryptionOf, isFullyBlocked, normalizeBucketLocation } from '../collectors/s3.js'
import { isLinkingRecord } from '../collectors/route53.js'
import { dnsIndex, queueNameFromUrl, trustedPrincipals } from './services.js'

function node(overrides: Partial<GraphNode>): GraphNode {
  return {
    id: 'n',
    arn: null,
    type: 'alb',
    category: 'network',
    name: 'n',
    abbr: 'A',
    typeLabel: 'T',
    region: 'us-east-1',
    az: null,
    vpcId: null,
    subnetId: null,
    parentId: null,
    state: 'active',
    tags: [],
    props: [],
    raw: {},
    logGroups: [],
    health: 'unknown',
    securityGroupIds: [],
    monthlyCostUsd: null,
    consoleUrl: null,
    ...overrides,
  }
}

describe('S3 quirks', () => {
  it('reads a null location constraint as us-east-1, and EU as eu-west-1', () => {
    // Both are documented API quirks rather than errors, and both would
    // otherwise place a bucket in no region at all.
    expect(normalizeBucketLocation(null)).toBe('us-east-1')
    expect(normalizeBucketLocation(undefined)).toBe('us-east-1')
    expect(normalizeBucketLocation('EU')).toBe('eu-west-1')
    expect(normalizeBucketLocation('ap-southeast-2')).toBe('ap-southeast-2')
  })

  it('calls a bucket blocked only when all four settings are on', () => {
    const all = {
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        IgnorePublicAcls: true,
        BlockPublicPolicy: true,
        RestrictPublicBuckets: true,
      },
    }
    expect(isFullyBlocked(all)).toBe(true)

    // Three of four still leaves a way in; reporting that as "blocked" would be
    // worse than reporting nothing.
    const three = {
      PublicAccessBlockConfiguration: { ...all.PublicAccessBlockConfiguration, IgnorePublicAcls: false },
    }
    expect(isFullyBlocked(three)).toBe(false)
    expect(isFullyBlocked({})).toBe(false)
  })

  it('distinguishes no encryption from an unread encryption setting', () => {
    expect(
      encryptionOf({
        ServerSideEncryptionConfiguration: {
          Rules: [{ ApplyServerSideEncryptionByDefault: { SSEAlgorithm: 'aws:kms' } }],
        },
      }),
    ).toBe('aws:kms')
    expect(encryptionOf({})).toBeNull()
  })
})

describe('Route 53 record filtering', () => {
  it('keeps records that can point at another node, drops the rest', () => {
    expect(isLinkingRecord({ Type: 'A', AliasTarget: { DNSName: 'x.elb.amazonaws.com.' } })).toBe(true)
    expect(isLinkingRecord({ Type: 'CNAME' })).toBe(true)
    expect(isLinkingRecord({ Type: 'AAAA' })).toBe(true)
    // A TXT record for domain verification is not an edge.
    expect(isLinkingRecord({ Type: 'TXT' })).toBe(false)
    expect(isLinkingRecord({ Type: 'MX' })).toBe(false)
    expect(isLinkingRecord({ Type: 'NS' })).toBe(false)
  })
})

describe('IAM trust policies', () => {
  it('decodes the URL-encoded document before parsing it', () => {
    // The API returns this URL-encoded. JSON.parse on the raw value throws, and
    // a catch that swallows it silently drops the only fact worth drawing.
    const document = encodeURIComponent(
      JSON.stringify({
        Version: '2012-10-17',
        Statement: [
          { Effect: 'Allow', Principal: { Service: 'lambda.amazonaws.com' }, Action: 'sts:AssumeRole' },
        ],
      }),
    )
    expect(trustedPrincipals(document)).toEqual(['lambda.amazonaws.com'])
  })

  it('handles a list of principals and de-duplicates', () => {
    const document = encodeURIComponent(
      JSON.stringify({
        Statement: [
          { Principal: { Service: ['ecs-tasks.amazonaws.com', 'ec2.amazonaws.com'] } },
          { Principal: { Service: 'ec2.amazonaws.com' } },
        ],
      }),
    )
    expect(trustedPrincipals(document)).toEqual(['ecs-tasks.amazonaws.com', 'ec2.amazonaws.com'])
  })

  it('returns nothing rather than throwing on a document it cannot read', () => {
    expect(trustedPrincipals('%7Bnot-json')).toEqual([])
    expect(trustedPrincipals(undefined)).toEqual([])
  })
})

describe('SQS', () => {
  it('takes the queue name from the end of the URL', () => {
    expect(queueNameFromUrl('https://sqs.us-east-1.amazonaws.com/111122223333/resize-jobs')).toBe(
      'resize-jobs',
    )
    expect(queueNameFromUrl('https://sqs.us-east-1.amazonaws.com/111122223333/orders.fifo')).toBe(
      'orders.fifo',
    )
  })
})

describe('DNS resolution for alias and origin edges', () => {
  it('matches exactly, ignoring case and the trailing dot', () => {
    const index = dnsIndex([
      node({ id: 'alb-1', props: [{ k: 'DNS name', v: 'API-alb-123.us-east-1.elb.amazonaws.com', mono: true }] }),
    ])
    expect(index.get('api-alb-123.us-east-1.elb.amazonaws.com')).toBe('alb-1')
  })

  it('does not match a name that merely shares a suffix', () => {
    // A wrong pairing here manufactures an edge that does not exist, which is
    // worse than a missing one: it invents architecture.
    const index = dnsIndex([
      node({ id: 'alb-1', props: [{ k: 'DNS name', v: 'api-alb-123.us-east-1.elb.amazonaws.com', mono: true }] }),
    ])
    expect(index.get('other-alb-999.us-east-1.elb.amazonaws.com')).toBeUndefined()
    expect(index.get('us-east-1.elb.amazonaws.com')).toBeUndefined()
  })

  it('derives both S3 endpoint forms from the bucket name', () => {
    const index = dnsIndex([node({ id: 'arn:aws:s3:::assets', type: 's3', name: 'assets' })])
    expect(index.get('assets.s3.amazonaws.com')).toBe('arn:aws:s3:::assets')
    expect(index.get('assets.s3.us-east-1.amazonaws.com')).toBe('arn:aws:s3:::assets')
  })

  it('lets the first node claim a name, so a later one cannot steal it', () => {
    const index = dnsIndex([
      node({ id: 'first', props: [{ k: 'DNS name', v: 'shared.example.com', mono: true }] }),
      node({ id: 'second', props: [{ k: 'Domain', v: 'shared.example.com', mono: true }] }),
    ])
    expect(index.get('shared.example.com')).toBe('first')
  })
})
