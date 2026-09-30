import type { ActualSpend } from '@cloudatlas/shared'
import type { PriceBook, PriceKey } from '../../cost/pricing.js'

/**
 * Cost data for the demo account.
 *
 * Prices are close to real us-east-1 on-demand list prices, so the estimates
 * and savings read sensibly, but they are a fixed table and every screen that
 * shows them says they are demo figures. Actual spend is derived from the
 * run-rate plus the usage-based services a real bill would carry.
 */

const HOURLY: Record<string, number> = {
  // EC2 instances
  'ec2|t3.large': 0.0832,
  'ec2|t4g.large': 0.0672,
  'ec2|m6i.xlarge': 0.192,
  'ec2|m6g.xlarge': 0.154,
  // RDS PostgreSQL
  'rds|db.r6g.2xlarge|PostgreSQL|false': 0.899,
  'rds|db.r6g.2xlarge|PostgreSQL|true': 1.798,
  // ElastiCache
  'elasticache|cache.r6g.large|Redis': 0.206,
  nat: 0.045,
  alb: 0.0225,
  nlb: 0.0225,
  'fargate-vcpu': 0.04048,
  'fargate-gb': 0.004445,
}

const PER_GB_MONTH: Record<string, number> = {
  'ebs|gp2': 0.1,
  'ebs|gp3': 0.08,
  'rds-storage|gp2|false': 0.115,
  'rds-storage|gp2|true': 0.23,
  'rds-storage|gp3|false': 0.115,
  'rds-storage|gp3|true': 0.23,
}

/** The demo's price for a key, ignoring region: the table is us-east-1 for every region. */
function demoPrice(key: PriceKey): number | null {
  switch (key.kind) {
    case 'ec2':
      return HOURLY[`ec2|${key.instanceType}`] ?? null
    case 'rds':
      return HOURLY[`rds|${key.instanceClass}|${key.engine}|${key.multiAz}`] ?? null
    case 'elasticache':
      return HOURLY[`elasticache|${key.nodeType}|${key.engine}`] ?? null
    case 'ebs':
      return PER_GB_MONTH[`ebs|${key.volumeType}`] ?? null
    case 'rds-storage':
      // gp3 on RDS is list-priced like gp2 below 400 GiB; above it the IOPS
      // baseline differs, not the per-GB rate.
      return PER_GB_MONTH[`rds-storage|${key.storageType}|${key.multiAz}`] ?? null
    default:
      return HOURLY[key.kind] ?? null
  }
}

export const DEMO_PRICE_BOOK: PriceBook = {
  source: 'Demo price table · close to us-east-1 on-demand list prices',
  get: (key) => demoPrice(key),
}

/**
 * Illustrative spend. The run-rate covers what is running; a real bill adds
 * usage-based services on top, so those are added here as named extras.
 */
export function demoActualSpend(runRateMonthly: number, now = new Date()): ActualSpend {
  const usage: Array<[string, number]> = [
    ['Amazon CloudFront', 214],
    ['AWS WAF', 47],
    ['Amazon Simple Storage Service', 176],
    ['AWS Network Firewall', 392],
    ['AWS Lambda', 29],
    ['Amazon Route 53', 6],
    ['Amazon CloudWatch', 88],
    ['Amazon Simple Queue Service', 6],
  ]
  const compute: Array<[string, number]> = [
    ['Amazon Relational Database Service', runRateMonthly * 0.62],
    ['Amazon ElastiCache', runRateMonthly * 0.07],
    ['Amazon Elastic Compute Cloud - Compute', runRateMonthly * 0.08],
    ['EC2 - Other', runRateMonthly * 0.12],
    ['Amazon Elastic Container Service', runRateMonthly * 0.08],
    ['Amazon Elastic Load Balancing', runRateMonthly * 0.03],
  ]
  const monthly = [...compute, ...usage]
  const dayOfMonth = now.getUTCDate()
  const daysInMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate()
  const elapsed = dayOfMonth / daysInMonth
  const round = (value: number): number => Math.round(value * 100) / 100
  const total = monthly.reduce((sum, [, value]) => sum + value, 0)

  // A steady daily shape with a weekend dip and the demo's incident near the
  // end, so the chart has something to read.
  const daily = Array.from({ length: 30 }, (_, index) => {
    const date = new Date(now.getTime() - (29 - index) * 24 * 60 * 60 * 1000)
    const weekend = [0, 6].includes(date.getUTCDay()) ? 0.86 : 1
    const incident = index >= 28 ? 1.18 : 1
    const wobble = 1 + Math.sin(index * 1.7) * 0.03
    return { key: date.toISOString().slice(0, 10), amount: round((total / 30) * weekend * incident * wobble) }
  })

  return {
    status: 'demo',
    message: 'Demo figures for the fictional cortex-prod account — not a real bill.',
    currency: 'USD',
    fetchedAt: now.getTime(),
    monthToDate: round(total * elapsed),
    lastMonth: round(total * 0.94),
    forecastMonthEnd: round(total * 1.02),
    byService: monthly
      .map(([key, value]) => ({ key, monthToDate: round(value * elapsed), lastMonth: round(value * 0.94) }))
      .sort((a, b) => b.monthToDate - a.monthToDate),
    byRegion: [
      { key: 'us-east-1', amount: round(total * elapsed * 0.71) },
      { key: 'us-west-2', amount: round(total * elapsed * 0.21) },
      { key: 'global', amount: round(total * elapsed * 0.06) },
      { key: 'eu-west-1', amount: round(total * elapsed * 0.02) },
    ],
    daily,
    // Each service follows the account's daily shape at its share of the total.
    dailyByService: monthly.map(([key, value]) => ({
      key,
      amounts: daily.map((day) => round(day.amount * (value / total))),
    })),
  }
}
