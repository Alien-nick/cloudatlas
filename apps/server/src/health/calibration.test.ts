import { afterAll, describe, expect, it, vi } from 'vitest'

/**
 * Threshold calibration.
 *
 * The spike detector's thresholds are judgement calls, and a single fixed test
 * time hides how much they depend on where a metric sits in its daily cycle —
 * the original z-threshold of 6 passed for months and then failed, because the
 * suite happened to run at an hour where seasonality widened the baseline.
 *
 * So this sweeps a full day. The demo series are a pure function of absolute
 * time and carry a real daily cycle, which makes them a usable stand-in for
 * seasonality until a captured fixture exists.
 *
 * Two properties, which together are the whole point of the detector:
 *   - it finds the staged incident at *every* phase, not most of them;
 *   - it stays silent on the database with no incident, at every phase.
 */

const PHASE_HOURS = [0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22]
const WINDOW_MS = 3 * 60 * 60_000

interface PhaseResult {
  hour: number
  primary: string[]
  standby: string[]
}

async function sweep(): Promise<PhaseResult[]> {
  const results: PhaseResult[] = []
  for (const hour of PHASE_HOURS) {
    vi.resetModules()
    vi.stubEnv('CLOUDATLAS_DEMO_EPOCH', String(Date.UTC(2026, 8, 21, hour, 30, 0)))

    const { DemoProvider } = await import('../providers/demo/index.js')
    const { DEMO_EPOCH } = await import('../providers/demo/series.js')
    const { detectSpikes } = await import('./spike.js')

    const provider = new DemoProvider()
    const graph = await provider.scan({ profile: 'calibration', regions: ['us-east-1'] })

    const metricsFor = async (id: string): Promise<string[]> => {
      const node = graph.nodes.find((candidate) => candidate.id === id)
      if (!node) throw new Error(`no node ${id}`)
      const response = await provider.getMetrics({
        nodeId: id,
        metricNames: [],
        start: DEMO_EPOCH - WINDOW_MS,
        end: DEMO_EPOCH,
      })
      return detectSpikes([{ node, series: response.series }], { now: DEMO_EPOCH })
        .map((finding) => finding.metric ?? '')
        .sort()
    }

    results.push({
      hour,
      primary: await metricsFor('rds-primary'),
      standby: await metricsFor('rds-standby'),
    })
  }
  return results
}

describe('spike thresholds across a daily cycle', () => {
  afterAll(() => {
    vi.unstubAllEnvs()
    vi.resetModules()
  })

  it('finds the staged incident at every phase, not just most of them', async () => {
    const results = await sweep()
    const missed = results.filter((phase) => !phase.primary.includes('CPUUtilization'))
    // A phase-dependent detector is worse than a blunt one: it works when you
    // test it and fails when you need it.
    expect(missed.map((phase) => phase.hour)).toEqual([])
  })

  it('stays silent on the database with no staged incident, at every phase', async () => {
    const results = await sweep()
    const noisy = results.filter((phase) => phase.standby.length > 0)
    expect(noisy.map((phase) => `${phase.hour}h: ${phase.standby.join(',')}`)).toEqual([])
  })
})

describe('detection settings from cloudatlas.config.json', () => {
  it('honours a configured z-score threshold', async () => {
    const { detectSpikes } = await import('./spike.js')
    const { DemoProvider } = await import('../providers/demo/index.js')
    const { DEMO_EPOCH } = await import('../providers/demo/series.js')

    const provider = new DemoProvider()
    const graph = await provider.scan({ profile: 'config', regions: ['us-east-1'] })
    const node = graph.nodes.find((candidate) => candidate.id === 'rds-primary')
    if (!node) throw new Error('no rds-primary')
    const response = await provider.getMetrics({
      nodeId: node.id,
      metricNames: [],
      start: DEMO_EPOCH - 3 * 60 * 60_000,
      end: DEMO_EPOCH,
    })
    const input = [{ node, series: response.series }]

    // An absurd threshold must silence it. If the config value were ignored —
    // which it was, until it was wired up — this would still report findings.
    expect(detectSpikes(input, { now: DEMO_EPOCH, zThreshold: 10_000 })).toEqual([])
    expect(detectSpikes(input, { now: DEMO_EPOCH }).length).toBeGreaterThan(0)
  })

  it('honours a configured absolute floor', async () => {
    const { detectSpikes } = await import('./spike.js')
    const { DemoProvider } = await import('../providers/demo/index.js')
    const { DEMO_EPOCH } = await import('../providers/demo/series.js')

    const provider = new DemoProvider()
    const graph = await provider.scan({ profile: 'config', regions: ['us-east-1'] })
    const node = graph.nodes.find((candidate) => candidate.id === 'rds-primary')
    if (!node) throw new Error('no rds-primary')
    const response = await provider.getMetrics({
      nodeId: node.id,
      metricNames: ['CPUUtilization'],
      start: DEMO_EPOCH - 3 * 60 * 60_000,
      end: DEMO_EPOCH,
    })
    const input = [{ node, series: response.series }]

    // A floor above anything achievable vetoes the finding on the absolute
    // gate, whatever the statistics say.
    const silenced = detectSpikes(input, {
      now: DEMO_EPOCH,
      floors: { 'AWS/RDS/CPUUtilization': 1000 },
    })
    expect(silenced.filter((finding) => finding.metric === 'CPUUtilization')).toEqual([])
  })
})
