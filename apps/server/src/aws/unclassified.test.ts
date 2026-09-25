import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AwsClient } from './client.js'
import { TranscriptReader, type TranscriptEntry } from './transcript.js'
import { tolerate, type CollectorContext } from '../collectors/types.js'

const created: string[] = []

afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** A one-entry capture whose single recorded call failed. */
function transcriptWith(error: { name: string; message: string; code?: string }): string {
  const dir = mkdtempSync(join(tmpdir(), 'cloudatlas-unclassified-'))
  created.push(dir)
  mkdirSync(join(dir, 'us-east-1'), { recursive: true })
  const entry: TranscriptEntry = {
    service: 'ec2',
    operation: 'DescribeInstances',
    region: 'us-east-1',
    input: {},
    output: null,
    durationMs: 1,
    error,
  }
  writeFileSync(
    join(dir, 'us-east-1', 'ec2.DescribeInstances.json'),
    JSON.stringify([entry], null, 2),
  )
  writeFileSync(
    join(dir, 'manifest.json'),
    JSON.stringify({ name: 't', capturedAt: '', regions: ['us-east-1'], totalCalls: 1 }),
  )
  return dir
}

function replayClient(dir: string): AwsClient {
  return new AwsClient({ profile: 'replay', mode: 'replay', reader: new TranscriptReader(dir) })
}

async function send(client: AwsClient): Promise<unknown> {
  return client.send('ec2', 'us-east-1', 'DescribeInstances', {})
}

describe('classification of a recorded failure', () => {
  it('files a recognised denial as a missing permission, not as unclassified', async () => {
    const client = replayClient(
      transcriptWith({
        name: 'UnauthorizedOperation',
        message: 'You are not authorized to perform this operation.',
      }),
    )
    await expect(send(client)).rejects.toThrow(/Missing permission/)
    expect(client.stats.accessDenied).toEqual(['ec2:DescribeInstances'])
    expect(client.stats.unclassified).toEqual([])
  })

  it('files an unrecognised AWS error as unclassified, with its code and name', async () => {
    const client = replayClient(
      transcriptWith({
        name: 'SomeFutureServiceException',
        message: 'the service said something we have never seen',
        code: 'WeirdFault',
      }),
    )

    await expect(send(client)).rejects.toThrow(/UnclassifiedAwsError|failed in us-east-1/)

    expect(client.stats.unclassified).toHaveLength(1)
    const failure = client.stats.unclassified[0]
    expect(failure?.service).toBe('ec2')
    expect(failure?.operation).toBe('DescribeInstances')
    expect(failure?.region).toBe('us-east-1')
    expect(failure?.errorName).toBe('SomeFutureServiceException')
    expect(failure?.errorCode).toBe('WeirdFault')
    expect(failure?.message).toContain('never seen')
  })

  it('records it per region as well as globally', async () => {
    const client = replayClient(
      transcriptWith({ name: 'OddException', message: 'x', code: 'Odd' }),
    )
    await expect(send(client)).rejects.toThrow()
    expect(client.stats.byRegion['us-east-1']?.unclassified).toHaveLength(1)
  })

  it('calls the onUnclassified hook so a capture can report it live', async () => {
    const seen: string[] = []
    const client = new AwsClient({
      profile: 'replay',
      mode: 'replay',
      reader: new TranscriptReader(transcriptWith({ name: 'OddException', message: 'x', code: 'O' })),
      onUnclassified: (failure) => seen.push(`${failure.service}:${failure.operation}`),
    })
    await expect(send(client)).rejects.toThrow()
    expect(seen).toEqual(['ec2:DescribeInstances'])
  })

  it('restores the error code on replay, not just the name', async () => {
    // ElastiCache and the other Query-protocol services report a denial as
    // `Code: AccessDenied` under a generic exception name. Losing `Code` in the
    // round trip would make a captured denial replay as unclassified, breaking
    // the exact fixture the missing-permission UI is built against.
    const client = replayClient(
      transcriptWith({
        name: 'ElastiCacheServiceException',
        message: 'not shaped like anything recognisable',
        code: 'AccessDenied',
      }),
    )
    await expect(send(client)).rejects.toThrow(/Missing permission/)
    expect(client.stats.accessDenied).toEqual(['ec2:DescribeInstances'])
    expect(client.stats.unclassified).toEqual([])
  })

  it('reproduces the live classification on replay, which the fixtures depend on', async () => {
    // A recorded AccessDenied must replay as a missing permission, or a fixture
    // captured with a narrowed policy would not exercise the warning path.
    const client = replayClient(
      transcriptWith({
        name: 'AccessDenied',
        message: 'User: arn:aws:iam::1:user/x is not authorized to perform: ec2:DescribeInstances',
      }),
    )
    await expect(send(client)).rejects.toThrow(/Missing permission ec2:DescribeInstances/)
  })
})

describe('what a failure costs', () => {
  const context = (): CollectorContext => ({
    aws: {} as unknown as CollectorContext['aws'],
    region: 'us-east-1',
    accountId: '111122223333',
    onWarning: () => {},
  })

  it('an unclassified failure loses one call, not the region', async () => {
    const result = await tolerate(context(), 'compute', ['fallback'], async () => {
      const error = new Error('x')
      error.name = 'UnclassifiedAwsError'
      throw error
    })
    expect(result).toEqual(['fallback'])
  })

  it('a missing permission loses one call and records a warning', async () => {
    const warnings: string[] = []
    const ctx = { ...context(), onWarning: (w: { action: string }) => warnings.push(w.action) }
    const result = await tolerate(ctx, 'database', [], async () => {
      const error = new Error('denied') as Error & { action?: string }
      error.name = 'AccessDeniedException'
      error.action = 'rds:DescribeDBInstances'
      throw error
    })
    expect(result).toEqual([])
    expect(warnings).toEqual(['rds:DescribeDBInstances'])
  })

  it('a bug in our own code still fails loudly', async () => {
    // Not an AWS error, so it must not be quietly filed as an interesting quirk.
    await expect(
      tolerate(context(), 'compute', [], async () => {
        throw new TypeError('cannot read properties of undefined')
      }),
    ).rejects.toThrow(TypeError)
  })
})
