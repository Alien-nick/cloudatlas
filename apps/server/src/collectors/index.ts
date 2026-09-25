import { collectCloudFront } from './cloudfront.js'
import { collectAlarms } from './cloudwatch-alarms.js'
import { collectEc2 } from './ec2.js'
import { collectIam } from './iam.js'
import { collectLambda } from './lambda.js'
import { collectNetworkFirewall } from './network-firewall.js'
import { collectRoute53 } from './route53.js'
import { collectS3 } from './s3.js'
import { collectSqs } from './sqs.js'
import { collectWaf, collectWafGlobal } from './waf.js'
import { collectEcs } from './ecs.js'
import { collectElastiCache } from './elasticache.js'
import { collectElbv2 } from './elbv2.js'
import { collectRds } from './rds.js'
import { collectVpc } from './vpc.js'
import type { CollectorFailure } from '@cloudatlas/shared'
import {
  emptyGlobalScanData,
  emptyRegionScanData,
  type CollectorContext,
  type GlobalScanData,
  type RegionScanData,
} from './types.js'

export * from './types.js'

export interface CollectorDefinition {
  /** Progress step name shown on the first-run screen. */
  name: string
  run: (context: CollectorContext, data: RegionScanData) => Promise<void>
}

/**
 * Per-region collectors.
 *
 * VPC runs first because everything else is placed relative to its subnets.
 * Alarms run last so they can be mapped onto resources that already exist.
 */
export const COLLECTORS: CollectorDefinition[] = [
  { name: 'vpc', run: collectVpc },
  { name: 'ec2', run: collectEc2 },
  { name: 'elbv2', run: collectElbv2 },
  { name: 'rds', run: collectRds },
  { name: 'elasticache', run: collectElastiCache },
  { name: 'ecs', run: collectEcs },
  { name: 'lambda', run: collectLambda },
  { name: 'sqs', run: collectSqs },
  { name: 'network-firewall', run: collectNetworkFirewall },
  { name: 'waf', run: collectWaf },
  { name: 'cloudwatch-alarms', run: collectAlarms },
]

export interface GlobalCollectorDefinition {
  name: string
  run: (context: CollectorContext, data: GlobalScanData) => Promise<void>
}

/**
 * Account-wide collectors, run exactly once per scan.
 *
 * Putting these in COLLECTORS would call each of them once per selected region,
 * producing N copies of every bucket, distribution and role — and N times the
 * API calls for data that does not vary by region.
 */
export const GLOBAL_COLLECTORS: GlobalCollectorDefinition[] = [
  { name: 's3', run: collectS3 },
  { name: 'cloudfront', run: collectCloudFront },
  { name: 'route53', run: collectRoute53 },
  { name: 'iam', run: collectIam },
  { name: 'waf-cloudfront', run: collectWafGlobal },
]

export interface RegionScanOptions {
  context: Omit<CollectorContext, 'onStep' | 'onFailure'> & {
    onFailure?: (failure: CollectorFailure) => void
  }
  /** Reports 0..1 completion plus the collector currently running. */
  onProgress?: (progress: number, step: string) => void
  signal?: AbortSignal
}

/** Run every M2 collector for one region, tolerating missing permissions. */
export async function scanRegion(options: RegionScanOptions): Promise<RegionScanData> {
  const { context, onProgress, signal } = options
  const data = emptyRegionScanData(context.region)
  const warnings = data.warnings
  const failures = data.failures

  const collectorContext: CollectorContext = {
    ...context,
    onWarning: (warning) => {
      // De-duplicate: one notice per action per region, not per call.
      if (!warnings.some((w) => w.action === warning.action && w.section === warning.section)) {
        warnings.push(warning)
      }
      context.onWarning(warning)
    },
    onFailure: (failure) => {
      failures.push(failure)
      context.onFailure?.(failure)
    },
  }

  for (const [index, collector] of COLLECTORS.entries()) {
    if (signal?.aborted) break
    onProgress?.(index / COLLECTORS.length, collector.name)
    await collector.run(collectorContext, data)
    onProgress?.((index + 1) / COLLECTORS.length, collector.name)
  }

  return data
}


export interface GlobalScanOptions {
  context: Omit<CollectorContext, 'onStep' | 'onFailure' | 'region'> & {
    onFailure?: (failure: CollectorFailure) => void
  }
  onProgress?: (progress: number, step: string) => void
  signal?: AbortSignal
}

/** Run the account-wide collectors once, tolerating missing permissions. */
export async function scanGlobal(options: GlobalScanOptions): Promise<GlobalScanData> {
  const { context, onProgress, signal } = options
  const data = emptyGlobalScanData()

  const collectorContext: CollectorContext = {
    ...context,
    // These services have no region of their own; 'global' is what the graph
    // labels them with, and what a warning should say rather than naming an
    // arbitrary region the user happened to select.
    region: 'global',
    onWarning: (warning) => {
      if (!data.warnings.some((w) => w.action === warning.action && w.section === warning.section)) {
        data.warnings.push(warning)
      }
      context.onWarning(warning)
    },
    onFailure: (failure) => {
      data.failures.push(failure)
      context.onFailure?.(failure)
    },
  }

  for (const [index, collector] of GLOBAL_COLLECTORS.entries()) {
    if (signal?.aborted) break
    onProgress?.(index / GLOBAL_COLLECTORS.length, collector.name)
    await collector.run(collectorContext, data)
    onProgress?.((index + 1) / GLOBAL_COLLECTORS.length, collector.name)
  }

  return data
}
