import {
  GetCostAndUsageCommand,
  type GetCostAndUsageCommandOutput,
} from '@aws-sdk/client-cost-explorer'
import type { GraphNode } from '@cloudatlas/shared'
import type { AwsClient } from '../aws/client.js'

/**
 * Monthly cost estimates, per service.
 *
 * Opt-in because Cost Explorer bills per request — a scan that silently cost
 * money every time would be a bad surprise, so `enableCostExplorer` defaults
 * to false and nothing here runs unless it is on.
 *
 * The important caveat is what this can and cannot say. Cost Explorer reports
 * spend grouped by *service*, not by resource: it knows the account spent $642
 * on RDS last month, not that `prod-pg-primary` did. Dividing a service total
 * across its resources would produce a number per node that looks precise and
 * is fiction. So the service total is attached to every node of that service
 * and clearly labelled as the service total — a real number, correctly scoped.
 */

/** Cost Explorer's own service names, mapped to our node types. */
const SERVICE_TO_TYPES: Record<string, string[]> = {
  'Amazon Elastic Compute Cloud - Compute': ['ec2'],
  'Amazon Relational Database Service': ['rds', 'rds-cluster'],
  'Amazon ElastiCache': ['elasticache'],
  'Amazon Elastic Container Service': ['ecs-task', 'ecs-service'],
  'Amazon Simple Storage Service': ['s3'],
  'Amazon CloudFront': ['cloudfront'],
  'AWS Lambda': ['lambda'],
  'Amazon Simple Queue Service': ['sqs'],
  'Amazon Route 53': ['route53-zone'],
  'AWS WAF': ['waf-web-acl'],
  'AWS Network Firewall': ['network-firewall'],
  'Elastic Load Balancing': ['alb', 'nlb'],
}

export interface ServiceCost {
  service: string
  amountUsd: number
}

/** Start of the current month, which is the window Cost Explorer reports on. */
export function currentMonthWindow(now = new Date()): { start: string; end: string } {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
  // Cost Explorer's end date is exclusive and must be after start, so
  // tomorrow rather than today — asking for today..today returns nothing.
  const end = new Date(now.getTime() + 24 * 60 * 60 * 1000)
  return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) }
}

export function parseCosts(output: GetCostAndUsageCommandOutput): ServiceCost[] {
  const costs = new Map<string, number>()
  for (const period of output.ResultsByTime ?? []) {
    for (const group of period.Groups ?? []) {
      const service = group.Keys?.[0]
      const amount = Number(group.Metrics?.UnblendedCost?.Amount ?? '0')
      if (!service || !Number.isFinite(amount)) continue
      costs.set(service, (costs.get(service) ?? 0) + amount)
    }
  }
  return [...costs.entries()]
    .map(([service, amountUsd]) => ({ service, amountUsd }))
    .filter((entry) => entry.amountUsd > 0)
    .sort((a, b) => b.amountUsd - a.amountUsd)
}

export interface CostOptions {
  aws: AwsClient
  now?: Date
  onWarning?: (action: string) => void
}

export async function fetchServiceCosts(options: CostOptions): Promise<ServiceCost[]> {
  const { aws } = options
  const { start, end } = currentMonthWindow(options.now)

  try {
    const output: GetCostAndUsageCommandOutput = await aws.send(
      'ce',
      // Cost Explorer has a single global endpoint in us-east-1.
      'us-east-1',
      'GetCostAndUsage',
      new GetCostAndUsageCommand({
        TimePeriod: { Start: start, End: end },
        Granularity: 'MONTHLY',
        Metrics: ['UnblendedCost'],
        GroupBy: [{ Type: 'DIMENSION', Key: 'SERVICE' }],
      }),
    )
    return parseCosts(output)
  } catch (error) {
    const err = error as Error & { action?: string }
    if (err.name === 'AccessDeniedException') {
      options.onWarning?.(err.action ?? 'ce:GetCostAndUsage')
      return []
    }
    throw error
  }
}

/**
 * Attach the service total to each node of that service.
 *
 * `monthlyCostUsd` is the *service* total, not this resource's share. The UI
 * labels it accordingly; splitting it per resource would invent a number.
 */
export function applyCosts(nodes: GraphNode[], costs: ServiceCost[]): void {
  const byType = new Map<string, number>()
  for (const cost of costs) {
    for (const type of SERVICE_TO_TYPES[cost.service] ?? []) {
      byType.set(type, cost.amountUsd)
    }
  }
  for (const node of nodes) {
    const amount = byType.get(node.type)
    if (amount !== undefined) node.monthlyCostUsd = Math.round(amount * 100) / 100
  }
}
