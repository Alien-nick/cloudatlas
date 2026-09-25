import {
  GetLoggingConfigurationCommand,
  GetWebACLCommand,
  ListResourcesForWebACLCommand,
  ListWebACLsCommand,
  type GetLoggingConfigurationResponse,
  type GetWebACLResponse,
  type ListResourcesForWebACLResponse,
  type ListWebACLsResponse,
  type Scope,
} from '@aws-sdk/client-wafv2'
import { GLOBAL_REGION } from '../aws/client.js'
import type { CollectorContext, GlobalScanData, RegionScanData, WafData } from './types.js'
import { tolerate } from './types.js'

/**
 * WAF v2 web ACLs.
 *
 * WAF splits into two scopes that behave like different services:
 *
 *  - `CLOUDFRONT` ACLs are global and **must** be queried against us-east-1.
 *    Asking any other region returns an empty list rather than an error, so a
 *    misconfigured region silently reports "no web ACLs" for an account that
 *    has several.
 *  - `REGIONAL` ACLs protect ALBs, API Gateway stages and AppSync, and exist
 *    per region like everything else.
 *
 * `ListResourcesForWebACL` only accepts REGIONAL — CloudFront associations are
 * read from the distribution side instead, which the CloudFront collector
 * already has in `WebACLId`.
 */

/** WAF's own paging: a `NextMarker` that repeats when exhausted. */
async function listWebAcls(
  context: CollectorContext,
  region: string,
  scope: Scope,
): Promise<ListWebACLsResponse['WebACLs']> {
  const { aws } = context
  const all: NonNullable<ListWebACLsResponse['WebACLs']> = []
  let marker: string | undefined
  // Bounded rather than while(true): WAF returns the same marker back when
  // there is nothing more, and an unbounded loop would spin forever on it.
  for (let page = 0; page < 20; page++) {
    const output: ListWebACLsResponse = await aws.send(
      'wafv2',
      region,
      'ListWebACLs',
      new ListWebACLsCommand({ Scope: scope, NextMarker: marker, Limit: 100 }),
    )
    const batch = output.WebACLs ?? []
    all.push(...batch)
    if (batch.length === 0 || !output.NextMarker || output.NextMarker === marker) break
    marker = output.NextMarker
  }
  return all
}

/** Rule summary: managed-group count, custom count and any rate limit. */
export function summarizeRules(acl: GetWebACLResponse['WebACL']): {
  managed: number
  custom: number
  rateLimits: string[]
} {
  let managed = 0
  let custom = 0
  const rateLimits: string[] = []

  for (const rule of acl?.Rules ?? []) {
    if (rule.Statement?.ManagedRuleGroupStatement) managed++
    else custom++

    const rateLimit = rule.Statement?.RateBasedStatement
    if (rateLimit?.Limit) {
      // WAF's rate window defaults to 5 minutes and is only sometimes set.
      const windowSeconds = rateLimit.EvaluationWindowSec ?? 300
      rateLimits.push(
        `${rateLimit.Limit.toLocaleString()} req / ${Math.round(windowSeconds / 60)} min per ${
          rateLimit.AggregateKeyType === 'IP' ? 'IP' : (rateLimit.AggregateKeyType ?? 'key')
        }`,
      )
    }
  }
  return { managed, custom, rateLimits }
}

/** Where the ACL's logs are delivered, in `destination:name` form. */
export function describeLoggingDestination(
  config: GetLoggingConfigurationResponse | undefined,
): string {
  const destinations = config?.LoggingConfiguration?.LogDestinationConfigs ?? []
  if (destinations.length === 0) return 'not configured'
  return destinations
    .map((arn) => {
      if (arn.includes(':logs:')) return `cloudwatch:${arn.split(':log-group:')[1] ?? arn}`
      if (arn.includes(':firehose:')) return `firehose:${arn.split('/').pop() ?? arn}`
      if (arn.includes(':s3:')) return `s3:${arn.split(':::')[1] ?? arn}`
      return arn
    })
    .join(', ')
}

/** Shared by the regional and global passes; only the scope differs. */
async function collectScope(
  context: CollectorContext,
  data: WafData,
  region: string,
  scope: Scope,
): Promise<void> {
  const { aws } = context

  const summaries = await tolerate(context, 'security', [], () =>
    listWebAcls(context, region, scope),
  )

  for (const summary of summaries ?? []) {
    if (!summary.Name || !summary.Id || !summary.ARN) continue
    data.webAclSummaries.push({ ...summary, Scope: scope, Region: region })

    const detail = await tolerate(context, 'security', undefined, () =>
      aws.send<GetWebACLResponse>(
        'wafv2',
        region,
        'GetWebACL',
        new GetWebACLCommand({ Name: summary.Name, Id: summary.Id, Scope: scope }),
      ),
    )
    if (detail?.WebACL) data.webAcls[summary.ARN] = detail.WebACL

    const logging = await tolerate(context, 'security', undefined, () =>
      aws.send<GetLoggingConfigurationResponse>(
        'wafv2',
        region,
        'GetLoggingConfiguration',
        new GetLoggingConfigurationCommand({ ResourceArn: summary.ARN }),
      ),
    )
    if (logging) data.webAclLogging[summary.ARN] = logging

    // REGIONAL only. Calling this for a CLOUDFRONT ACL is rejected outright,
    // so the association comes from the distribution's WebACLId instead.
    if (scope === 'REGIONAL') {
      const resources = await tolerate(context, 'security', undefined, () =>
        aws.send<ListResourcesForWebACLResponse>(
          'wafv2',
          region,
          'ListResourcesForWebACL',
          new ListResourcesForWebACLCommand({ WebACLArn: summary.ARN }),
        ),
      )
      if (resources?.ResourceArns) data.webAclResources[summary.ARN] = resources.ResourceArns
    }
  }
}

/** REGIONAL web ACLs for one region. */
export async function collectWaf(
  context: CollectorContext,
  data: RegionScanData,
): Promise<void> {
  await collectScope(context, data, context.region, 'REGIONAL')
  context.onStep?.('waf')
}

/**
 * CLOUDFRONT web ACLs, which are account-wide.
 *
 * The region is pinned to us-east-1 through the global pseudo-region: any other
 * region answers with an empty list rather than an error.
 */
export async function collectWafGlobal(
  context: CollectorContext,
  data: GlobalScanData,
): Promise<void> {
  await collectScope(context, data, GLOBAL_REGION, 'CLOUDFRONT')
  context.onStep?.('waf-cloudfront')
}
