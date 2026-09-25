import { describe, expect, it } from 'vitest'
import type { GraphNode, MetricSeries } from '@cloudatlas/shared'
import {
  meanAbsoluteDeviation,
  median,
  medianAbsoluteDeviation,
  robustZScore,
  summarizeBaseline,
} from './robust.js'
import { analyzeSeries, detectSpikes, MIN_BASELINE_SAMPLES, RECENT_SAMPLES } from './spike.js'
import { parseMaxConnections } from '../metrics/parameters.js'
import { findMetricDef } from '@cloudatlas/shared'

const MINUTE = 60_000
const T0 = Date.UTC(2026, 0, 1)

function node(overrides: Partial<GraphNode> = {}): GraphNode {
  return {
    id: 'rds-primary',
    arn: null,
    type: 'rds',
    category: 'database',
    name: 'prod-pg-primary',
    abbr: 'RDS',
    typeLabel: 'RDS instance',
    region: 'us-east-1',
    az: 'us-east-1a',
    vpcId: 'vpc-1',
    subnetId: 'subnet-1',
    parentId: 'subnet-1',
    state: 'available',
    tags: [],
    props: [],
    raw: {},
    logGroups: ['/aws/rds/instance/prod-pg-primary/postgresql'],
    health: 'unknown',
    securityGroupIds: [],
    monthlyCostUsd: null,
    consoleUrl: null,
    ...overrides,
  }
}

/** A series built from explicit values, one point per minute. */
function series(metricName: string, values: Array<number | null>): MetricSeries {
  const def = findMetricDef('rds', metricName) ?? findMetricDef('ec2', metricName)
  return {
    nodeId: 'rds-primary',
    metricName,
    namespace: def?.namespace ?? 'AWS/RDS',
    label: def?.label ?? metricName,
    unit: def?.unit ?? '',
    stat: def?.stat ?? 'Average',
    timestamps: values.map((_, i) => T0 + i * MINUTE),
    values,
    period: 60,
    unavailableReason: null,
  }
}

/**
 * `baselineCount` points wobbling around `base`, then `spikeCount` at `peak`.
 *
 * The wobble is proportional, not absolute: a fixed +/-2 is ordinary noise on a
 * metric that sits at 40 and larger than the entire signal on one that sits at
 * 0.01, which would make the low-magnitude cases untestable.
 */
function withSpike(base: number, peak: number, baselineCount = 60, spikeCount = RECENT_SAMPLES): number[] {
  const wobble = [0, 1, -1, 2, -2, 1, -1, 0]
  const values: number[] = []
  for (let i = 0; i < baselineCount; i++) {
    values.push(base * (1 + (wobble[i % wobble.length] ?? 0) * 0.02))
  }
  for (let i = 0; i < spikeCount; i++) values.push(peak)
  return values
}

describe('robust statistics', () => {
  it('computes median and MAD by their definitions', () => {
    expect(median([3, 1, 2])).toBe(2)
    expect(median([4, 1, 3, 2])).toBe(2.5)
    // Deviations from the median 3 are [2,1,0,1,2]; their median is 1.
    expect(medianAbsoluteDeviation([1, 2, 3, 4, 5])).toBe(1)
    expect(meanAbsoluteDeviation([1, 2, 3, 4, 5])).toBeCloseTo(1.2, 5)
  })

  it('does not let an ongoing spike inflate its own baseline', () => {
    // This is the whole reason for median and MAD. The same sample scored with
    // mean and standard deviation understates the spike badly, because the
    // spike is in the sample.
    const values = withSpike(40, 95, 55, 5)
    const baseline = summarizeBaseline(values)
    const robust = robustZScore(95, baseline)

    const mean = values.reduce((a, b) => a + b, 0) / values.length
    const sd = Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length)
    const classic = (95 - mean) / sd

    expect(baseline.center).toBeCloseTo(40, 0)
    expect(robust).not.toBeNull()
    expect(robust!).toBeGreaterThan(20)
    expect(classic).toBeLessThan(4)
  })

  it('falls back to the mean absolute deviation when MAD is zero', () => {
    // More than half the window is identical, which is the normal state of
    // error and status-check metrics. MAD is 0 and dividing by it gives
    // Infinity, so every blip would score as infinitely significant.
    const flat = [0, 0, 0, 0, 0, 0, 0, 1, 2, 0, 0]
    expect(medianAbsoluteDeviation(flat)).toBe(0)

    const baseline = summarizeBaseline(flat)
    expect(baseline.scaleSource).toBe('mean-absolute-deviation')
    expect(baseline.scale).toBeGreaterThan(0)
    expect(Number.isFinite(robustZScore(5, baseline)!)).toBe(true)
  })

  it('reports a perfectly constant baseline instead of inventing a spread', () => {
    const baseline = summarizeBaseline([7, 7, 7, 7, 7])
    expect(baseline.scaleSource).toBe('constant')
    expect(baseline.scale).toBe(0)
    // Null, not Infinity: there is no statistical evidence either way.
    expect(robustZScore(99, baseline)).toBeNull()
  })
})

describe('the three gates', () => {
  const now = T0 + 100 * MINUTE

  it('reports a real spike that clears all three', () => {
    const cpu = series('CPUUtilization', withSpike(42, 93))
    const findings = detectSpikes([{ node: node(), series: [cpu] }], { now })

    expect(findings).toHaveLength(1)
    expect(findings[0]?.kind).toBe('metric-spike')
    expect(findings[0]?.metric).toBe('CPUUtilization')
    expect(findings[0]?.severity).toBe('critical')
    expect(findings[0]?.evidence.join(' ')).toMatch(/z-score/i)
  })

  it('vetoes a statistically huge move that is absolutely trivial', () => {
    // 0.01 -> 0.4 errors/min is an enormous z-score and completely unimportant.
    // The alertFloor for Target 5XX is 5.
    const errors: MetricSeries = {
      ...series('CPUUtilization', []),
      metricName: 'HTTPCode_Target_5XX_Count',
      namespace: 'AWS/ApplicationELB',
      label: 'Target 5XX',
      unit: '',
      stat: 'Sum',
      timestamps: withSpike(0.01, 0.4).map((_, i) => T0 + i * MINUTE),
      values: withSpike(0.01, 0.4),
    }
    const alb = node({ id: 'alb', type: 'alb', name: 'api-alb' })

    const analysis = analyzeSeries(errors, findMetricDef('alb', 'HTTPCode_Target_5XX_Count')!, { now })
    expect(analysis.z).not.toBeNull()
    expect(Math.abs(analysis.z!)).toBeGreaterThan(6)
    expect(analysis.rejectedBy).toBe('absolute')

    expect(detectSpikes([{ node: alb, series: [errors] }], { now })).toEqual([])
  })

  it('ignores a move in the harmless direction', () => {
    // CPU falling from 90 to 40 is a recovery, not an incident.
    const cpu = series('CPUUtilization', withSpike(90, 40))
    expect(analyzeSeries(cpu, findMetricDef('rds', 'CPUUtilization')!, { now }).rejectedBy).toBe(
      'direction',
    )
    expect(detectSpikes([{ node: node(), series: [cpu] }], { now })).toEqual([])
  })

  it('catches a depletion on a metric where falling is the problem', () => {
    // Burst balance draining toward zero is the classic slow RDS outage.
    const burst = series('BurstBalance', withSpike(98, 8))
    const findings = detectSpikes([{ node: node(), series: [burst] }], { now })

    expect(findings).toHaveLength(1)
    expect(findings[0]?.metric).toBe('BurstBalance')
    expect(findings[0]?.title).toMatch(/fell/i)
    // 8 is under half the alertCeiling of 20.
    expect(findings[0]?.severity).toBe('critical')
  })

  it('says nothing when there is not enough baseline to judge', () => {
    const short = series('CPUUtilization', withSpike(42, 93, MIN_BASELINE_SAMPLES - 5, RECENT_SAMPLES))
    expect(analyzeSeries(short, findMetricDef('rds', 'CPUUtilization')!, { now }).rejectedBy).toBe(
      'samples',
    )
    expect(detectSpikes([{ node: node(), series: [short] }], { now })).toEqual([])
  })
})

describe('gaps', () => {
  const now = T0 + 100 * MINUTE

  it('excludes nulls from the statistics rather than reading them as zero', () => {
    const clean = withSpike(42, 93)
    const gappy: Array<number | null> = [...clean]
    // Punch holes in the baseline. Treated as zeros these would drag the
    // median down and manufacture a far larger apparent spike.
    for (let i = 5; i < 25; i += 2) gappy[i] = null

    const a = analyzeSeries(series('CPUUtilization', clean), findMetricDef('rds', 'CPUUtilization')!, { now })
    const b = analyzeSeries(series('CPUUtilization', gappy), findMetricDef('rds', 'CPUUtilization')!, { now })

    expect(b.baseline?.center).toBeCloseTo(a.baseline!.center, 0)
    expect(b.rejectedBy).toBeNull()
  })

  it('skips a series that was never queried', () => {
    const unavailable: MetricSeries = {
      ...series('CPUUtilization', withSpike(42, 93)),
      unavailableReason: 'Instance is stopped — CloudWatch reports no datapoints.',
    }
    expect(detectSpikes([{ node: node(), series: [unavailable] }], { now })).toEqual([])
  })
})

describe('max_connections as a denominator', () => {
  const now = T0 + 100 * MINUTE

  it('accepts an explicit integer and refuses a formula', () => {
    expect(parseMaxConnections('1600')).toEqual({ maxConnections: 1600 })
    const formula = parseMaxConnections('LEAST({DBInstanceClassMemory/9531392},5000)')
    expect(formula.maxConnections).toBeUndefined()
    expect(formula.maxConnectionsUnknown).toMatch(/DBInstanceClassMemory/)
    expect(parseMaxConnections(undefined).maxConnectionsUnknown).toMatch(/does not set/)
  })

  it('quotes the real share when the limit is known', () => {
    const connections = series('DatabaseConnections', withSpike(183, 1420))
    const findings = detectSpikes([{ node: node(), series: [connections] }], {
      now,
      limits: new Map([['rds-primary', { maxConnections: 1600 }]]),
    })

    expect(findings[0]?.evidence.join(' | ')).toContain('1,420 of 1,600 max_connections (89%)')
    expect(findings[0]?.severity).toBe('critical')
  })

  it('admits the share is unknown rather than quoting a guessed one', () => {
    const connections = series('DatabaseConnections', withSpike(183, 1420))
    const findings = detectSpikes([{ node: node(), series: [connections] }], {
      now,
      limits: new Map([
        ['rds-primary', { maxConnectionsUnknown: 'it is the engine default formula' }],
      ]),
    })

    const evidence = findings[0]?.evidence.join(' | ') ?? ''
    expect(evidence).toContain('Share of max_connections unknown')
    expect(evidence).not.toMatch(/\d+%\)/)
    // Still a finding — a missing denominator costs an evidence line, not the alert.
    expect(findings).toHaveLength(1)
  })
})

describe('finding shape', () => {
  const now = T0 + 100 * MINUTE

  it('is deterministic and carries the node log groups', () => {
    const input = [{ node: node(), series: [series('CPUUtilization', withSpike(42, 93))] }]
    const first = detectSpikes(input, { now })
    const second = detectSpikes(input, { now })

    expect(second.map((f) => f.id)).toEqual(first.map((f) => f.id))
    expect(first[0]?.id).toBe('spike:rds-primary:CPUUtilization')
    expect(first[0]?.logGroups).toEqual(['/aws/rds/instance/prod-pg-primary/postgresql'])
    expect(first[0]?.sparkline.length).toBeGreaterThan(0)
  })

  it('dates the onset to when the metric left its baseline, not to now', () => {
    const values = withSpike(42, 93, 60, 12)
    const finding = detectSpikes([{ node: node(), series: [series('CPUUtilization', values)] }], {
      now,
    })[0]

    expect(finding).toBeDefined()
    // The spike begins at index 60 of a one-point-per-minute series.
    expect(finding!.startedAt).toBe(T0 + 60 * MINUTE)
    expect(finding!.startedAt).toBeLessThan(now)
  })
})
