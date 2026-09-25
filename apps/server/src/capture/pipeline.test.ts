import { describe, expect, it } from 'vitest'
import { Redactor } from '../aws/redact.js'
import { TranscriptWriter, type CaptureMeta, type TranscriptEntry } from '../aws/transcript.js'
import { automaticDenyWords, scanForDenyWords } from './deny.js'

const ACCOUNT = '482177301192'
const PROFILE = 'acmecorp-prod'

const META: CaptureMeta = {
  name: 'test',
  capturedAt: '2026-09-20T00:00:00.000Z',
  regions: ['us-east-1'],
  totalWallMs: 1000,
  totalCalls: 1,
  totalRetries: 0,
  totalThrottles: 0,
  totalResources: 1,
  unclassified: [],
  byRegion: {},
  target: { resources: 500, seconds: 60, projectedSeconds: 10, pass: true },
  redaction: { replaced: {}, keptTagKeys: [] },
  denyCheck: { wordsChecked: 0, allowedWords: [] },
}

/** The full capture pipeline: redact, serialise, then gate. */
function pipeline(
  entries: TranscriptEntry[],
  options: { deny?: string[]; allow?: string[]; keepNoTags?: boolean } = {},
) {
  const redactor = new Redactor({ keepNoTags: options.keepNoTags ?? false })
  const redacted = redactor.redactAll(entries)
  const files = TranscriptWriter.materialize(
    redacted,
    { name: 'test', capturedAt: META.capturedAt, regions: ['us-east-1'], totalCalls: entries.length },
    META,
  )
  const result = scanForDenyWords({
    files,
    deny: [...automaticDenyWords(ACCOUNT, [PROFILE]), ...(options.deny ?? [])],
    allow: options.allow ?? [],
  })
  return { files, result, redacted }
}

function entry(output: unknown): TranscriptEntry {
  return {
    service: 'ec2',
    operation: 'DescribeInstances',
    region: 'us-east-1',
    input: {},
    output,
    durationMs: 12,
  }
}

describe('capture pipeline', () => {
  it('passes a realistic payload with no denied value surviving', () => {
    const { result } = pipeline([
      entry({
        Reservations: [
          {
            OwnerId: ACCOUNT,
            Instances: [
              {
                InstanceId: 'i-0af22c9e13b7d4410',
                InstanceType: 'm6i.xlarge',
                PrivateIpAddress: '10.0.11.41',
                PublicIpAddress: '52.14.88.201',
                State: { Name: 'running' },
                VpcId: 'vpc-0a91c2ff',
                IamInstanceProfile: {
                  Arn: `arn:aws:iam::${ACCOUNT}:instance-profile/${PROFILE}-worker`,
                },
                Tags: [{ Key: 'Name', Value: 'worker-1' }],
              },
            ],
          },
        ],
      }),
    ])
    expect(result.hits).toEqual([])
  })

  it('strips the account id from every nested position', () => {
    const { files } = pipeline([
      entry({ OwnerId: ACCOUNT, arn: `arn:aws:ec2:us-east-1:${ACCOUNT}:vpc/vpc-0a91c2ff` }),
    ])
    for (const contents of files.values()) expect(contents).not.toContain(ACCOUNT)
  })

  it('catches an org name in a field class the redactor does not know about', () => {
    // This is the whole reason the deny check exists: substitution is a
    // blocklist, so an unmapped field passes through untouched.
    const { result } = pipeline(
      [entry({ SomeFutureApiField: 'acmecorp-internal-thing' })],
      { deny: ['acmecorp'] },
    )
    expect(result.hits).toHaveLength(1)
    expect(result.hits[0]?.path).toContain('SomeFutureApiField')
  })

  it('catches the profile name without it being configured', () => {
    const { result } = pipeline([entry({ UnmappedField: `${PROFILE}-cluster` })])
    expect(result.hits.length).toBeGreaterThan(0)
    expect(result.hits[0]?.word).toBe(PROFILE)
  })

  it('reports a leak in meta.json too, not just the transcript files', () => {
    const redactor = new Redactor()
    const files = TranscriptWriter.materialize(redactor.redactAll([entry({})]), {
      name: `capture-for-${PROFILE}`,
      capturedAt: META.capturedAt,
      regions: ['us-east-1'],
      totalCalls: 1,
    }, META)
    const result = scanForDenyWords({
      files,
      deny: automaticDenyWords(ACCOUNT, [PROFILE]),
      allow: [],
    })
    expect(result.hits.some((hit) => hit.file === 'manifest.json')).toBe(true)
  })

  it('keeps cross-references intact through the pipeline', () => {
    const { redacted } = pipeline([
      entry({
        LoadBalancers: [
          {
            LoadBalancerName: `${PROFILE}-api-alb`,
            LoadBalancerArn: `arn:aws:elasticloadbalancing:us-east-1:${ACCOUNT}:loadbalancer/app/${PROFILE}-api-alb/50dc`,
          },
        ],
      }),
    ])
    const lb = (
      redacted[0]?.output as { LoadBalancers: Array<{ LoadBalancerName: string; LoadBalancerArn: string }> }
    ).LoadBalancers[0]
    expect(lb?.LoadBalancerArn).toContain(lb?.LoadBalancerName)
  })

  it('materialises one file per region, service and operation, plus metadata', () => {
    const redactor = new Redactor()
    const files = TranscriptWriter.materialize(
      redactor.redactAll([
        entry({}),
        { ...entry({}), service: 'rds', operation: 'DescribeDBInstances' },
      ]),
      { name: 'test', capturedAt: META.capturedAt, regions: ['us-east-1'], totalCalls: 2 },
      META,
    )
    expect([...files.keys()].sort()).toEqual([
      'manifest.json',
      'meta.json',
      'us-east-1/ec2.DescribeInstances.json',
      'us-east-1/rds.DescribeDBInstances.json',
    ])
  })

  it('an allow-word lets a known-safe value through, and says so', () => {
    const { result } = pipeline([entry({ UnmappedField: `${PROFILE}-cluster` })], {
      allow: [PROFILE],
    })
    expect(result.hits).toEqual([])
    expect(result.suppressed).toContain(PROFILE)
  })
})
