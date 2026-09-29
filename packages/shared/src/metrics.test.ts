import { describe, expect, it } from 'vitest'
import {
  METRIC_CATALOG,
  choosePeriod,
  findMetricDef,
  formatMetricValue,
  metricsFor,
  primaryMetricsFor,
} from './metrics.js'

describe('choosePeriod', () => {
  const now = Date.now()

  it('uses 1-minute resolution for a recent short window', () => {
    expect(choosePeriod(now - 60 * 60_000, now)).toBe(60)
  })

  it('coarsens rather than exceeding the point budget', () => {
    const period = choosePeriod(now - 24 * 60 * 60_000, now)
    expect(period).toBeGreaterThanOrEqual(300)
    expect((24 * 60 * 60) / period).toBeLessThanOrEqual(720)
  })

  it('respects CloudWatch retention: no 1-minute data beyond 15 days', () => {
    const old = now - 20 * 86_400_000
    expect(choosePeriod(old, old + 60 * 60_000)).toBeGreaterThanOrEqual(300)
  })

  it('drops to hourly beyond 63 days', () => {
    const ancient = now - 90 * 86_400_000
    expect(choosePeriod(ancient, ancient + 60 * 60_000)).toBeGreaterThanOrEqual(3600)
  })

  it('always returns a period CloudWatch accepts', () => {
    const legal = new Set([1, 5, 10, 30, 60, 300, 900, 3600, 21600, 86_400])
    for (const hours of [1, 3, 6, 12, 24, 72, 24 * 14]) {
      expect(legal.has(choosePeriod(now - hours * 3_600_000, now))).toBe(true)
    }
  })
})

describe('metric catalog', () => {
  it('covers the resource types the health feature prioritises', () => {
    for (const type of ['rds', 'ec2', 'elasticache', 'alb', 'waf-web-acl'] as const) {
      expect(metricsFor(type).length).toBeGreaterThan(0)
      expect(primaryMetricsFor(type).length).toBeGreaterThan(0)
    }
  })

  it('includes the RDS signals used for spike detection', () => {
    const names = metricsFor('rds').map((m) => m.name)
    expect(names).toEqual(
      expect.arrayContaining([
        'CPUUtilization',
        'DatabaseConnections',
        'FreeableMemory',
        'ReadLatency',
        'WriteLatency',
        'DiskQueueDepth',
        'FreeStorageSpace',
        'ReplicaLag',
        'BurstBalance',
      ]),
    )
  })

  it('includes both EC2 status checks', () => {
    const names = metricsFor('ec2').map((m) => m.name)
    expect(names).toContain('StatusCheckFailed_Instance')
    expect(names).toContain('StatusCheckFailed_System')
  })

  it('marks CloudWatch-agent metrics as requiring extra setup', () => {
    expect(findMetricDef('ec2', 'mem_used_percent')?.requires).toMatch(/CloudWatch agent/)
  })

  it('returns an empty catalog for unmonitored types instead of throwing', () => {
    expect(metricsFor('iam-role')).toEqual([])
  })
})

describe('formatMetricValue', () => {
  it('renders a placeholder for missing datapoints', () => {
    expect(formatMetricValue(null, '%')).toBe('—')
    expect(formatMetricValue(Number.NaN, '%')).toBe('—')
  })

  it('scales precision with magnitude and appends the unit', () => {
    expect(formatMetricValue(1420, '')).toBe('1,420')
    expect(formatMetricValue(93.14, '%')).toBe('93.1 %')
    expect(formatMetricValue(2.437, 'ms')).toBe('2.44 ms')
  })
})

describe('catalog units', () => {
  /**
   * AWS does not publish in the units people read in, and a catalog that
   * labels without converting is not a cosmetic problem — it reported a
   * 400-microsecond latency as "0.00 ms".
   */
  const PUBLISHED_IN_OTHER_UNITS = [
    ['AWS/RDS', 'ReadLatency'],
    ['AWS/RDS', 'WriteLatency'],
    ['AWS/RDS', 'FreeableMemory'],
    ['AWS/RDS', 'FreeStorageSpace'],
    ['AWS/RDS', 'SwapUsage'],
    ['AWS/EC2', 'NetworkIn'],
    ['AWS/EC2', 'NetworkOut'],
    ['AWS/NetworkELB', 'ProcessedBytes'],
    ['AWS/S3', 'BucketSizeBytes'],
  ] as const

  it('converts every metric AWS publishes in a different unit', () => {
    const all = Object.values(METRIC_CATALOG).flat()
    for (const [namespace, name] of PUBLISHED_IN_OTHER_UNITS) {
      const def = all.find((entry) => entry?.namespace === namespace && entry.name === name)
      expect(def, `${namespace}/${name} missing from the catalog`).toBeDefined()
      expect(def?.scale, `${namespace}/${name} needs a scale`).toBeDefined()
      expect(def?.scale).not.toBe(1)
    }
  })

  it('leaves metrics already in their display unit unscaled', () => {
    const all = Object.values(METRIC_CATALOG).flat()
    // Lambda Duration really is milliseconds; ReplicaLag really is seconds.
    for (const [namespace, name] of [
      ['AWS/Lambda', 'Duration'],
      ['AWS/RDS', 'ReplicaLag'],
      ['AWS/SQS', 'ApproximateAgeOfOldestMessage'],
    ] as const) {
      const def = all.find((entry) => entry?.namespace === namespace && entry.name === name)
      expect(def?.scale, `${namespace}/${name} should not be scaled`).toBeUndefined()
    }
  })

  it('never labels a byte total as a rate', () => {
    // NetworkIn is bytes per period, not bytes per second; "MB/s" was wrong
    // twice over — the unit and the dimension.
    const all = Object.values(METRIC_CATALOG).flat()
    for (const def of all) {
      if (!def) continue
      if (def.unit.endsWith('/s')) {
        expect(def.name, `${def.name} is a total, not a rate`).not.toMatch(/Bytes|Network/)
      }
    }
  })
})
