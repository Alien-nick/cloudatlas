import type uPlot from 'uplot'
import type { MetricDef, MetricSeries } from '@cloudatlas/shared'

/**
 * uPlot configuration shared by every chart.
 *
 * Two things here are load-bearing rather than cosmetic:
 *
 *  - Colours are read from the live CSS custom properties rather than hardcoded,
 *    because uPlot draws to a canvas and cannot use `var(--ca-grid)`. Reading
 *    them at build time means a theme switch has to rebuild each chart, which is
 *    what `themeVersion` in CaChart is for.
 *  - `spanGaps` stays false. The server takes care to return null for a window
 *    CloudWatch had no data for; joining across it here would redraw exactly the
 *    interpolation the null was there to prevent.
 */

export function cssVar(name: string, fallback: string): string {
  if (typeof window === 'undefined') return fallback
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return value.length > 0 ? value : fallback
}

export interface ChartTheme {
  grid: string
  axis: string
  text: string
  cursor: string
  anomaly: string
}

export function readTheme(): ChartTheme {
  return {
    grid: cssVar('--ca-grid', '#171c21'),
    axis: cssVar('--ca-faint', '#5f6a74'),
    text: cssVar('--ca-muted', '#8b949e'),
    cursor: cssVar('--ca-border2', '#2b333b'),
    anomaly: 'rgba(242,85,90,.10)',
  }
}

/** Hex plus alpha, for the area fill under a line. */
export function withAlpha(hex: string, alpha: number): string {
  const match = /^#([0-9a-f]{6})$/i.exec(hex.trim())
  if (!match?.[1]) return hex
  const int = Number.parseInt(match[1], 16)
  const r = (int >> 16) & 255
  const g = (int >> 8) & 255
  const b = int & 255
  return `rgba(${r},${g},${b},${alpha})`
}

/**
 * Axis tick labels.
 *
 * Deliberately terser than `formatMetricValue`: an axis has a few hundred
 * pixels and repeats the unit in the header already, so "1.2k" beats
 * "1,203 /min" at every tick.
 */
export function formatAxisValue(value: number, def: Pick<MetricDef, 'percent'>): string {
  if (!Number.isFinite(value)) return ''
  if (def.percent) return `${Math.round(value)}%`
  const abs = Math.abs(value)
  if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (abs >= 1_000) return `${(value / 1_000).toFixed(abs >= 10_000 ? 0 : 1)}k`
  if (abs >= 10) return value.toFixed(0)
  if (abs >= 1) return value.toFixed(1)
  if (abs === 0) return '0'
  // Small values need enough places to stay distinguishable. At two decimals
  // a sub-centi range collapses to a column of identical "0.00" ticks, which
  // is an axis that says nothing.
  if (abs >= 0.01) return value.toFixed(2)
  if (abs >= 0.001) return value.toFixed(3)
  return value.toPrecision(2)
}

/**
 * Tick labels for a set of splits, widened until they are distinguishable.
 *
 * Formatting each tick independently can produce repeats — three ticks all
 * reading "0.00" for three different values. Checked across the whole set
 * rather than per value, because the problem only exists between them.
 */
export function formatAxisValues(
  splits: number[],
  def: Pick<MetricDef, 'percent'>,
): string[] {
  const base = splits.map((value) => formatAxisValue(value, def))
  const distinct = new Set(base).size === base.length
  if (distinct || def.percent) return base

  for (const digits of [2, 3, 4, 5, 6]) {
    const widened = splits.map((value) =>
      Number.isFinite(value) ? value.toPrecision(digits) : '',
    )
    if (new Set(widened).size === widened.length) return widened
  }
  return base
}

/**
 * y-axis bounds.
 *
 * A percentage metric is pinned to 0–100 so a chart that never leaves 40–42%
 * looks flat instead of alarming — autoscaling turns ordinary jitter into a
 * mountain range. Everything else autoscales from zero when the data is close
 * to it, because a bar chart of errors starting at 3.8 is a lie by omission.
 */
export function yRange(
  values: Array<number | null>,
  def: Pick<MetricDef, 'percent' | 'scale'>,
): [number, number] | null {
  if (def.percent) return [0, 100]
  const scale = def.scale ?? 1
  const present = values
    .filter((value): value is number => value !== null)
    .map((value) => value * scale)
  if (present.length === 0) return null

  const min = Math.min(...present)
  const max = Math.max(...present)
  if (min === max) {
    // A perfectly flat series still needs a band to draw in.
    const pad = Math.abs(max) * 0.1 || 1
    return [max - pad, max + pad]
  }

  const headroom = (max - min) * 0.1
  // Anchor at zero when the data already sits near it, so small values are not
  // magnified into apparent volatility.
  const floor = min >= 0 && min <= (max - min) * 0.5 ? 0 : min - headroom
  return [floor, max + headroom]
}

/**
 * uPlot wants x in seconds and one array per series.
 *
 * The scale is applied here, at the display boundary, so the detectors keep
 * comparing raw CloudWatch values against raw thresholds.
 */
export function toChartData(series: MetricSeries, scale = 1): uPlot.AlignedData {
  return [
    series.timestamps.map((timestamp) => timestamp / 1000),
    series.values.map((value) => (value === null ? null : value * scale)),
  ] as uPlot.AlignedData
}

/** Convert a raw CloudWatch value into the unit the catalog displays. */
export function toDisplay(value: number | null, def: Pick<MetricDef, 'scale'>): number | null {
  return value === null ? null : value * (def.scale ?? 1)
}

/**
 * Charts on one node share a cursor, so hovering a latency spike shows the
 * matching instant on CPU and connections. That comparison is most of the value
 * of putting the charts on one screen.
 */
export function syncKeyFor(nodeId: string): string {
  return `ca-metrics-${nodeId}`
}
