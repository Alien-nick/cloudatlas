import { describe, expect, it } from 'vitest'
import type { MetricSeries } from '@cloudatlas/shared'
import {
  formatAxisValue,
  formatAxisValues,
  toChartData,
  toDisplay,
  withAlpha,
  yRange,
} from './chart'

describe('axis formatting', () => {
  it('stays terse, because a tick has no room for a unit', () => {
    expect(formatAxisValue(1420, {})).toBe('1.4k')
    expect(formatAxisValue(24_000, {})).toBe('24k')
    expect(formatAxisValue(2_400_000, {})).toBe('2.4M')
    expect(formatAxisValue(34, {})).toBe('34')
    expect(formatAxisValue(2.4, {})).toBe('2.4')
    expect(formatAxisValue(0.08, {})).toBe('0.08')
    expect(formatAxisValue(0, {})).toBe('0')
  })

  it('renders a percentage as one', () => {
    expect(formatAxisValue(93.4, { percent: true })).toBe('93%')
  })

  it('returns empty for a non-finite tick rather than printing NaN', () => {
    expect(formatAxisValue(Number.NaN, {})).toBe('')
    expect(formatAxisValue(Number.POSITIVE_INFINITY, {})).toBe('')
  })
})

describe('y-axis bounds', () => {
  it('pins a percentage to 0-100 so ordinary jitter stays flat', () => {
    // Autoscaled, 40-42% would fill the plot and read as a crisis.
    expect(yRange([40, 41, 42], { percent: true })).toEqual([0, 100])
  })

  it('anchors at zero when the data already sits near it', () => {
    const range = yRange([2, 4, 6], {})
    expect(range?.[0]).toBe(0)
    expect(range?.[1]).toBeGreaterThan(6)
  })

  it('does not anchor at zero when that would flatten the signal', () => {
    // 980-1020 against a zero floor is a flat line; the variation is the point.
    const range = yRange([980, 1000, 1020], {})
    expect(range?.[0]).toBeGreaterThan(900)
  })

  it('gives a perfectly flat series a band to draw in', () => {
    const range = yRange([7, 7, 7], {})
    expect(range).not.toBeNull()
    expect(range![0]).toBeLessThan(7)
    expect(range![1]).toBeGreaterThan(7)
  })

  it('has no opinion when every point is a gap', () => {
    expect(yRange([null, null], {})).toBeNull()
  })
})

describe('chart data', () => {
  it('converts to seconds and preserves gaps as null', () => {
    const series = {
      timestamps: [1_000_000, 1_060_000, 1_120_000],
      values: [1, null, 3],
    } as MetricSeries
    const [xs, ys] = toChartData(series)
    expect(xs).toEqual([1000, 1060, 1120])
    // A null here is what makes uPlot break the line instead of interpolating.
    expect(ys).toEqual([1, null, 3])
  })
})

describe('colour', () => {
  it('converts a hex to rgba for the area fill', () => {
    expect(withAlpha('#C925D1', 0.14)).toBe('rgba(201,37,209,0.14)')
  })

  it('passes a non-hex through untouched rather than emitting nonsense', () => {
    expect(withAlpha('var(--ca-compute)', 0.14)).toBe('var(--ca-compute)')
  })
})


describe('unit scaling', () => {
  it('converts the unit CloudWatch publishes into the one displayed', () => {
    // AWS publishes RDS ReadLatency in seconds. Labelling it "ms" without
    // converting reported a 400-microsecond latency as "0.00 ms".
    expect(toDisplay(0.0004, { scale: 1000 })).toBeCloseTo(0.4, 6)
    // And FreeableMemory in bytes, labelled GB.
    expect(toDisplay(8_589_934_592, { scale: 1 / 1e9 })).toBeCloseTo(8.59, 2)
  })

  it('passes a value through when the catalog needs no conversion', () => {
    expect(toDisplay(42, {})).toBe(42)
    expect(toDisplay(null, { scale: 1000 })).toBeNull()
  })

  it('scales the chart series, so the plot agrees with the headline', () => {
    const series = { timestamps: [1000], values: [0.0004] } as never
    const [, ys] = toChartData(series, 1000)
    expect(ys?.[0]).toBeCloseTo(0.4, 6)
  })

  it('scales the y-axis bounds too, or the plot would be drawn off scale', () => {
    const range = yRange([0.0004, 0.0008], { scale: 1000 })
    expect(range?.[1]).toBeGreaterThan(0.5)
  })
})

describe('axis ticks stay distinguishable', () => {
  it('widens precision rather than repeating a label', () => {
    // Three different latencies all formatting as "0.00" is an axis that says
    // nothing — which is exactly what a sub-centi range produced.
    const ticks = formatAxisValues([0.0002, 0.0004, 0.0006], {})
    expect(new Set(ticks).size).toBe(3)
  })

  it('leaves well-separated ticks alone', () => {
    expect(formatAxisValues([0, 50, 100], {})).toEqual(['0', '50', '100'])
  })

  it('formats a small lone value with enough places to be read', () => {
    expect(formatAxisValue(0.0004, {})).not.toBe('0.00')
  })
})
