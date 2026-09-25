import { describe, expect, it } from 'vitest'
import { AwsClient } from './client.js'
import { AbsentConfigurationError, ReadOnlyViolationError } from './errors.js'
import {
  AWS_OPERATIONS,
  actionOf,
  hasReadOnlyShape,
  resetOperationIndex,
} from './operations.js'
import { TranscriptReader } from './transcript.js'

/** Replay mode needs no credentials, so the guard is testable in isolation. */
function replayClient(reader?: TranscriptReader): AwsClient {
  return new AwsClient({
    profile: 'unused',
    mode: 'replay',
    ...(reader ? { reader } : {}),
  })
}

describe('read-only guard', () => {
  it('refuses an operation that is not in the registry', async () => {
    const client = replayClient()
    await expect(client.send('ec2', 'us-east-1', 'DescribeUnicorns', {})).rejects.toThrow(
      ReadOnlyViolationError,
    )
  })

  it('refuses a mutating operation even if someone registers it', async () => {
    const client = replayClient()
    for (const operation of [
      'TerminateInstances',
      'DeleteBucket',
      'ModifyDBInstance',
      'AuthorizeSecurityGroupIngress',
      'StartInstances',
      'PutObject',
      'CreateTags',
      'RunInstances',
    ]) {
      await expect(client.send('ec2', 'us-east-1', operation, {})).rejects.toThrow(
        ReadOnlyViolationError,
      )
    }
  })

  it('refuses an operation registered for a later milestone', async () => {
    // Every entry is active today, so a planned one is added for the duration
    // of this test. Deriving the example from the registry stopped working the
    // moment the backlog emptied, and hard-coding a name would have gone stale
    // the day that operation shipped.
    AWS_OPERATIONS.push({
      service: 'ec2',
      operation: 'DescribeSomethingFuture',
      purpose: 'Test fixture for the guard.',
      status: 'planned',
      milestone: 'M9',
      readOnlyAccess: 'unverified',
    })
    resetOperationIndex()

    try {
      const client = replayClient()
      await expect(
        client.send('ec2', 'us-east-1', 'DescribeSomethingFuture', {}),
      ).rejects.toThrow(/not active/)
    } finally {
      AWS_OPERATIONS.pop()
      resetOperationIndex()
    }
  })

  it('has nothing left registered as planned', () => {
    // Not a backlog check: an entry that is planned but uncalled is exactly
    // what `npm run check:iam` exists to catch, and this states the current
    // position so a new one is a deliberate, visible addition.
    expect(AWS_OPERATIONS.filter((spec) => spec.status === 'planned')).toEqual([])
  })

  it('names the offending operation so the failure is actionable', async () => {
    const client = replayClient()
    await expect(client.send('rds', 'us-east-1', 'DeleteDBInstance', {})).rejects.toThrow(
      /rds:DeleteDBInstance/,
    )
  })

  it('never resolves credentials in replay mode', () => {
    // Constructing must not touch ~/.aws; the guard rejects before any client
    // is built, and no credential provider is created at all.
    expect(() => replayClient()).not.toThrow()
  })
})

describe('operation name shapes', () => {
  it('accepts the documented read-only prefixes', () => {
    for (const operation of [
      'DescribeInstances',
      'ListBuckets',
      'GetWebACL',
      'SearchResources',
      'SelectResourceConfig',
      'LookupEvents',
      'BatchGetItem',
    ]) {
      expect(hasReadOnlyShape(operation)).toBe(true)
    }
  })

  it('accepts the four read operations that do not start with a read prefix', () => {
    for (const operation of ['FilterLogEvents', 'StartQuery', 'StopQuery', 'StartLiveTail']) {
      expect(hasReadOnlyShape(operation)).toBe(true)
    }
  })

  it('rejects anything that mutates', () => {
    for (const operation of [
      'CreateBucket',
      'DeleteStack',
      'UpdateService',
      'PutMetricAlarm',
      'ModifyVpcAttribute',
      'RebootDBInstance',
      'TerminateInstances',
      'AttachRolePolicy',
      'StartSession',
      'SendCommand',
    ]) {
      expect(hasReadOnlyShape(operation)).toBe(false)
    }
  })
})

describe('absent configuration', () => {
  /** A reader that always raises the given AWS error. */
  function throwingReader(error: Error): TranscriptReader {
    return { next: () => { throw error } } as unknown as TranscriptReader
  }

  it('is classified before the unclassified bucket, not after', async () => {
    // The bug this covers: NoSuchTagSet reached `isAwsError` and was recorded
    // as an unrecognised failure. A real scan produced 27 of them in one run,
    // which is how the unclassified signal stops being worth reading.
    const client = replayClient(
      throwingReader(Object.assign(new Error('The TagSet does not exist'), { name: 'NoSuchTagSet' })),
    )

    await expect(
      client.send('s3', 'us-east-1', 'GetBucketTagging', {}),
    ).rejects.toThrow(AbsentConfigurationError)
    expect(client.stats.unclassified).toEqual([])
    expect(client.stats.accessDenied).toEqual([])
  })

  it('carries the original error name, so a caller can say which config', async () => {
    const client = replayClient(
      throwingReader(
        Object.assign(new Error('no block'), { name: 'NoSuchPublicAccessBlockConfiguration' }),
      ),
    )
    await client.send('s3', 'us-east-1', 'GetPublicAccessBlock', {}).catch((error: unknown) => {
      expect((error as AbsentConfigurationError).errorName).toBe(
        'NoSuchPublicAccessBlockConfiguration',
      )
    })
  })

  it('still records a genuinely unrecognised error as unclassified', async () => {
    // The bucket must keep working for what it is actually for.
    const client = replayClient(
      throwingReader(Object.assign(new Error('what'), { name: 'WeirdServiceException' })),
    )
    await expect(client.send('s3', 'us-east-1', 'GetBucketTagging', {})).rejects.toThrow()
    expect(client.stats.unclassified).toHaveLength(1)
    expect(client.stats.unclassified[0]?.errorName).toBe('WeirdServiceException')
  })

  it('does not treat a missing bucket as a missing configuration', async () => {
    const client = replayClient(
      throwingReader(Object.assign(new Error('gone'), { name: 'NoSuchBucket' })),
    )
    await expect(
      client.send('s3', 'us-east-1', 'GetBucketTagging', {}),
    ).rejects.not.toThrow(AbsentConfigurationError)
  })
})

describe('operation registry', () => {
  it('has no duplicate service:operation pairs', () => {
    const keys = AWS_OPERATIONS.map((spec) => `${spec.service}:${spec.operation}`)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('only contains read-only shaped operations', () => {
    const offenders = AWS_OPERATIONS.filter((spec) => !hasReadOnlyShape(spec.operation))
    expect(offenders.map((s) => actionOf(s))).toEqual([])
  })

  it('gives every operation a purpose and a milestone', () => {
    for (const spec of AWS_OPERATIONS) {
      expect(spec.purpose.length, `${actionOf(spec)} purpose`).toBeGreaterThan(10)
      expect(spec.milestone, `${actionOf(spec)} milestone`).toMatch(/^M\d/)
    }
  })

  it('uses the IAM action name where it differs from the SDK command', () => {
    // s3:GetBucketEncryption is authorised by s3:GetEncryptionConfiguration.
    const encryption = AWS_OPERATIONS.find((s) => s.operation === 'GetBucketEncryption')
    expect(encryption && actionOf(encryption)).toBe('s3:GetEncryptionConfiguration')

    const listBuckets = AWS_OPERATIONS.find((s) => s.operation === 'ListBuckets')
    expect(listBuckets && actionOf(listBuckets)).toBe('s3:ListAllMyBuckets')
  })

  it('marks Cost Explorer optional so it stays out of the base policy', () => {
    const ce = AWS_OPERATIONS.filter((s) => s.service === 'ce')
    expect(ce.length).toBeGreaterThan(0)
    expect(ce.every((s) => s.optional === true)).toBe(true)
  })

  it('keeps the collector surface to the agreed services', () => {
    // Enumerated rather than counted: the point is that adding a service is a
    // deliberate act with a diff someone has to approve, not something that
    // happens because a collector quietly reached for a new API.
    const activeServices = new Set(
      AWS_OPERATIONS.filter((s) => s.status === 'active').map((s) => s.service),
    )
    expect([...activeServices].sort()).toEqual([
      'ce',
      'cloudfront',
      'cloudtrail',
      'cloudwatch',
      'ec2',
      'ecs',
      'elasticache',
      'elasticloadbalancing',
      'iam',
      'lambda',
      'logs',
      'network-firewall',
      'pi',
      'rds',
      'route53',
      's3',
      'sqs',
      'sts',
      'wafv2',
    ])
  })

  it('has a client factory for every service it can call', () => {
    // A registry entry with no factory fails at the first live call rather than
    // at build time, and only for whoever happens to have that service.
    const active = new Set(
      AWS_OPERATIONS.filter((spec) => spec.status === 'active').map((spec) => spec.service),
    )
    for (const service of active) {
      expect(() => replayClient().send(service as never, 'us-east-1', 'Describe', {})).not.toThrow(
        /not in the operation registry/,
      )
    }
  })
})
