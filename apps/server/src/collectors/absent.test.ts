import { describe, expect, it } from 'vitest'
import { AbsentConfigurationError, isAbsentConfiguration } from '../aws/errors.js'
import { encryptionOf, isFullyBlocked } from './s3.js'
import { tolerate, tolerateAbsent, type CollectorContext } from './types.js'

function context(): {
  ctx: CollectorContext
  warnings: string[]
  failures: string[]
} {
  const warnings: string[] = []
  const failures: string[] = []
  const ctx = {
    aws: {} as never,
    region: 'us-east-1',
    accountId: '111122223333',
    onWarning: (warning: { action: string }) => warnings.push(warning.action),
    onFailure: (failure: { operation: string }) => failures.push(failure.operation),
  } as unknown as CollectorContext
  return { ctx, warnings, failures }
}

describe('recognising an absent configuration', () => {
  it('matches the errors AWS raises for "not configured"', () => {
    // Every one of these is an ordinary state most buckets are in.
    for (const name of [
      'NoSuchTagSet',
      'NoSuchPublicAccessBlockConfiguration',
      'ServerSideEncryptionConfigurationNotFoundError',
      'WAFNonexistentItemException',
    ]) {
      expect(isAbsentConfiguration(Object.assign(new Error('x'), { name })), name).toBe(true)
    }
  })

  it('reads the code as well as the name, which several services use', () => {
    expect(isAbsentConfiguration(Object.assign(new Error('x'), { Code: 'NoSuchTagSet' }))).toBe(true)
  })

  it('does not swallow a missing resource, which is a real failure', () => {
    // "NoSuch*" as a pattern would catch NoSuchBucket, which means the bucket
    // is gone — the opposite of a benign absent sub-resource.
    for (const name of ['NoSuchBucket', 'NoSuchKey', 'AccessDenied', 'ThrottlingException']) {
      expect(isAbsentConfiguration(Object.assign(new Error('x'), { name })), name).toBe(false)
    }
    expect(isAbsentConfiguration(null)).toBe(false)
  })
})

describe('tolerating an absent configuration', () => {
  it('returns the value that means absence, reporting nothing', async () => {
    const { ctx, warnings, failures } = context()
    const result = await tolerateAbsent(ctx, 'storage', 'fallback', 'absent', () =>
      Promise.reject(new AbsentConfigurationError('s3', 'GetBucketTagging', 'NoSuchTagSet', 'no tags')),
    )
    expect(result).toBe('absent')
    // The whole point: this must not reach the unclassified bucket, which is
    // how that signal stops meaning anything.
    expect(failures).toEqual([])
    expect(warnings).toEqual([])
  })

  it('still reports a denial as a missing permission', async () => {
    const { ctx, warnings } = context()
    const denied = Object.assign(new Error('nope'), {
      name: 'AccessDeniedException',
      action: 's3:GetBucketTagging',
    })
    const result = await tolerateAbsent(ctx, 'storage', 'fallback', 'absent', () =>
      Promise.reject(denied),
    )
    expect(result).toBe('fallback')
    expect(warnings).toEqual(['s3:GetBucketTagging'])
  })

  it('leaves a real error to the normal path', async () => {
    const { ctx } = context()
    await expect(
      tolerateAbsent(ctx, 'storage', 'fallback', 'absent', () =>
        Promise.reject(new Error('a bug in our own code')),
      ),
    ).rejects.toThrow('a bug in our own code')
    // And tolerate itself is unchanged.
    await expect(
      tolerate(ctx, 'storage', 'fallback', () => Promise.reject(new Error('boom'))),
    ).rejects.toThrow('boom')
  })
})

describe('what absence means per field', () => {
  it('treats a missing access block as NOT blocked, which is the finding', () => {
    // A bucket raising NoSuchPublicAccessBlockConfiguration has no block at
    // all. Recording that as unknown discarded the most flaggable bucket.
    expect(isFullyBlocked({})).toBe(false)
  })

  it('does not claim a bucket is unencrypted just because no policy is set', () => {
    // S3 applies SSE-S3 to new objects regardless since 2023, so an absent
    // bucket-default policy is not the same as unencrypted.
    expect(encryptionOf({})).toBeNull()
  })
})
