import { existsSync } from 'node:fs'
import type { MissingPermission } from '@cloudatlas/shared'
import { AwsClient, type UnclassifiedFailure } from '../aws/client.js'
import { getIdentity } from '../aws/identity.js'
import { TranscriptReader } from '../aws/transcript.js'
import { runScan, type ScanResult } from '../scan/run.js'

export interface ReplayResult extends ScanResult {
  regions: string[]
  accountId: string
  /** Permissions the original capture turned out not to have. */
  warnings: MissingPermission[]
  /** AWS failures the original capture could not classify. */
  unclassified: UnclassifiedFailure[]
  /** Recorded calls replay never consumed — a sign the collectors changed. */
  unconsumed: Array<{ key: string; remaining: number }>
}

/**
 * Rebuild a graph from a committed fixture, through the real collectors and the
 * real relationship builders.
 *
 * No credentials are involved: the client is in replay mode, which never
 * constructs a credential provider. This is the seam the regression suite and
 * the capture diff both sit on.
 */
export async function replayCapture(dir: string): Promise<ReplayResult> {
  if (!existsSync(dir)) throw new Error(`No capture at ${dir}`)

  const reader = new TranscriptReader(dir)
  const regions = reader.regions
  if (regions.length === 0) {
    throw new Error(`${dir}/manifest.json lists no regions`)
  }

  const warnings: MissingPermission[] = []
  const unclassified: UnclassifiedFailure[] = []

  const aws = new AwsClient({
    profile: 'replay',
    mode: 'replay',
    reader,
    onUnclassified: (failure) => unclassified.push(failure),
  })

  const identity = await getIdentity(aws, 'replay')
  const result = await runScan({
    aws,
    profile: 'replay',
    accountId: identity.accountId,
    accountAlias: identity.accountAlias,
    regions,
    onWarning: (warning) => warnings.push(warning),
    onFailure: () => {},
  })

  return {
    ...result,
    regions,
    accountId: identity.accountId,
    warnings,
    unclassified,
    unconsumed: reader.unconsumed(),
  }
}
