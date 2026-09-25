import {
  findMetricDef,
  formatMetricValue,
  type Finding,
  type GraphNode,
  type MetricDef,
  type MetricSeries,
} from '@cloudatlas/shared'
import { ratioToBaseline, robustZScore, summarizeBaseline, type Baseline } from './robust.js'

/**
 * Spike detection over a metric series.
 *
 * The design constraint is false positives. A detector that fires on ordinary
 * variation trains you to ignore it, at which point it is worse than nothing —
 * so every candidate has to clear three independent gates, and any one of them
 * can veto:
 *
 *  1. **Statistical.** The recent level must be far from the baseline measured
 *     in robust units (see robust.ts for why not mean and standard deviation).
 *  2. **Absolute.** The value must matter in the metric's own terms. Errors
 *     going from 0.01/min to 0.4/min is a huge z-score and nothing at all.
 *  3. **Directional.** Only a move in the harmful direction counts, and only
 *     for metrics that declare which direction that is.
 *
 * What this deliberately does not do is compare against the same hour of the
 * previous day or week. That needs history we do not keep yet, and pretending
 * to do seasonal comparison from a few hours of data would produce confident
 * nonsense every Monday morning.
 */

/**
 * Robust z beyond which a level counts as anomalous.
 *
 * 3.5 is the conventional threshold for a MAD-based outlier score (Iglewicz and
 * Hoaglin). This started at 6, chosen conservatively before there was anything
 * to calibrate against, and that turned out to be too strict: swept across a
 * full daily cycle, a genuine 2.2x CPU spike scores as low as 5.3 once the
 * baseline includes the metric's own daily seasonality, leaving no margin at 6.
 *
 * Lowering it is safe because the statistical gate does not decide alone. Swept
 * over a database with no staged incident, ordinary variation reaches |z| of
 * 12.8 — and every one of those is rejected by the absolute or directional
 * gate. This gate answers "is this unusual"; the other two answer "and does it
 * matter". Conflating them into one strict threshold is what loses real spikes.
 */
export const DEFAULT_Z_THRESHOLD = 3.5

/** Baseline points needed before the statistics mean anything. */
export const MIN_BASELINE_SAMPLES = 20

/** Points at the end of the window that form the "now" level. */
export const RECENT_SAMPLES = 5

/**
 * When a metric declares no absolute threshold, the move still has to be large
 * in relative terms. Halving or doubling is the bar.
 */
const RELATIVE_GATE = 2

export interface SpikeOptions {
  zThreshold?: number
  /**
   * Per-metric absolute floors keyed `namespace/MetricName`, overriding the
   * catalog's. This is what `detection.floors` in cloudatlas.config.json sets:
   * the right floor for "too many connections" depends on the database, and
   * only the operator knows theirs.
   */
  floors?: Record<string, number>
  /** Epoch ms used for `startedAt` when a finding is raised. */
  now: number
  /**
   * Real denominators discovered during the scan, keyed by node id — today just
   * max_connections. Absent means "unknown", never "assume a default".
   */
  limits?: Map<string, ResourceLimits>
}

export interface ResourceLimits {
  maxConnections?: number
  /** Why the limit is missing, when it could not be resolved. */
  maxConnectionsUnknown?: string
}

export interface SpikeAnalysis {
  /** Null when the series was too short or too sparse to judge. */
  baseline: Baseline | null
  recent: number | null
  z: number | null
  ratio: number | null
  /** Set when a gate rejected an otherwise anomalous-looking move. */
  rejectedBy: 'samples' | 'direction' | 'statistical' | 'absolute' | null
}

/** Datapoints only — nulls are gaps, and a gap is not a zero. */
function present(series: MetricSeries): Array<{ t: number; v: number }> {
  const points: Array<{ t: number; v: number }> = []
  for (const [index, value] of series.values.entries()) {
    const timestamp = series.timestamps[index]
    if (value === null || timestamp === undefined) continue
    points.push({ t: timestamp, v: value })
  }
  return points
}

/**
 * Score one series without deciding whether to report it.
 *
 * Split out so the numbers behind a finding can be inspected — and so the
 * threshold can be tuned against a real capture without touching the reporting
 * path.
 */
export function analyzeSeries(series: MetricSeries, def: MetricDef, options: SpikeOptions): SpikeAnalysis {
  const empty: SpikeAnalysis = { baseline: null, recent: null, z: null, ratio: null, rejectedBy: null }
  const points = present(series)
  if (points.length < MIN_BASELINE_SAMPLES + RECENT_SAMPLES) {
    return { ...empty, rejectedBy: 'samples' }
  }

  const split = points.length - RECENT_SAMPLES
  const baseline = summarizeBaseline(points.slice(0, split).map((point) => point.v))
  // The median of the recent points, not the last one: a single bad datapoint
  // is a datapoint, and CloudWatch has plenty of those.
  const recentValues = points.slice(split).map((point) => point.v)
  const recent = median(recentValues)

  const z = robustZScore(recent, baseline)
  const ratio = ratioToBaseline(recent, baseline.center)
  const analysis: SpikeAnalysis = { baseline, recent, z, ratio, rejectedBy: null }

  const rising = recent > baseline.center
  if ((rising && !def.higherIsWorse) || (!rising && !def.lowerIsWorse)) {
    return { ...analysis, rejectedBy: 'direction' }
  }

  const threshold = options.zThreshold ?? DEFAULT_Z_THRESHOLD
  // A constant baseline yields no z-score at all; such a series can still be
  // reported, but only on the absolute gate below.
  if (z !== null && Math.abs(z) < threshold) return { ...analysis, rejectedBy: 'statistical' }
  if (z === null && baseline.scaleSource !== 'constant') return { ...analysis, rejectedBy: 'statistical' }

  const floor = options.floors?.[`${def.namespace}/${def.name}`]
  if (!passesAbsoluteGate(recent, ratio, def, floor)) return { ...analysis, rejectedBy: 'absolute' }

  return analysis
}

function passesAbsoluteGate(
  recent: number,
  ratio: number | null,
  def: MetricDef,
  configuredFloor?: number,
): boolean {
  const floor = configuredFloor ?? def.alertFloor
  if (def.higherIsWorse && floor !== undefined) return recent >= floor
  if (def.lowerIsWorse && def.alertCeiling !== undefined) return recent <= def.alertCeiling
  // No threshold in the catalog, so fall back to a relative one. Without this a
  // metric that idles near zero reports a spike every time it twitches.
  if (ratio === null) return false
  return def.higherIsWorse ? ratio >= RELATIVE_GATE : ratio <= 1 / RELATIVE_GATE
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = sorted.length >> 1
  // biome-ignore lint/style/noNonNullAssertion: callers pass a non-empty array
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2
}

/** Downsample for the finding's sparkline. */
function sparkline(series: MetricSeries, width = 48): number[] {
  const points = present(series).map((point) => point.v)
  if (points.length <= width) return points
  const step = points.length / width
  return Array.from({ length: width }, (_, i) => points[Math.floor(i * step)] ?? 0)
}

/** First timestamp at which the metric left its baseline, walking back from now. */
function onsetTimestamp(series: MetricSeries, baseline: Baseline, recent: number): number | null {
  const points = present(series)
  if (points.length === 0) return null
  const midpoint = (baseline.center + recent) / 2
  const rising = recent > baseline.center

  for (let i = points.length - 1; i >= 0; i--) {
    const point = points[i]
    if (!point) continue
    const back = rising ? point.v < midpoint : point.v > midpoint
    if (back) return points[i + 1]?.t ?? point.t
  }
  return points[0]?.t ?? null
}

export interface SpikeInput {
  node: GraphNode
  series: MetricSeries[]
}

/**
 * Turn anomalous series into findings.
 *
 * One finding per node per metric. Correlating several spiking metrics on the
 * same node into a single narrative ("connection pressure, not a heavy query")
 * is what the agent is for; inventing that link here would mean guessing at
 * causation from timing alone.
 */
export function detectSpikes(inputs: SpikeInput[], options: SpikeOptions): Finding[] {
  const findings: Finding[] = []

  for (const { node, series: allSeries } of inputs) {
    for (const series of allSeries) {
      if (series.unavailableReason !== null) continue
      const def = findMetricDef(node.type, series.metricName)
      if (!def) continue
      if (!def.higherIsWorse && !def.lowerIsWorse) continue

      const analysis = analyzeSeries(series, def, options)
      if (analysis.rejectedBy !== null) continue
      const { baseline, recent } = analysis
      if (!baseline || recent === null) continue

      findings.push(
        buildFinding(node, series, def, analysis, baseline, recent, options),
      )
    }
  }

  // Stable order: worst first, then by node so a re-run does not reshuffle.
  return findings.sort(
    (a, b) =>
      severityRank(b.severity) - severityRank(a.severity) ||
      a.nodeId.localeCompare(b.nodeId) ||
      (a.metric ?? '').localeCompare(b.metric ?? ''),
  )
}

function severityRank(severity: Finding['severity']): number {
  return severity === 'critical' ? 2 : severity === 'warning' ? 1 : 0
}

function buildFinding(
  node: GraphNode,
  series: MetricSeries,
  def: MetricDef,
  analysis: SpikeAnalysis,
  baseline: Baseline,
  recent: number,
  options: SpikeOptions,
): Finding {
  const rising = recent > baseline.center
  const direction = rising ? 'rose' : 'fell'
  const observed = formatMetricValue(recent, def.unit)
  const usual = formatMetricValue(baseline.center, def.unit)

  const evidence: string[] = [
    `${def.name} ${observed} vs ${usual} baseline` +
      (analysis.ratio !== null && analysis.ratio > 0
        ? ` (${formatRatio(analysis.ratio)})`
        : ''),
    analysis.z !== null
      ? `Robust z-score ${analysis.z.toFixed(1)} against a ${baseline.samples}-point baseline`
      : `Baseline was flat at ${usual} across ${baseline.samples} points, so no z-score applies — ` +
        'this is a step change judged on its absolute level',
    `Baseline spread estimated from ${scaleLabel(baseline)}`,
  ]

  const limits = options.limits?.get(node.id)
  const severity = severityFor(def, recent, analysis, limits)
  if (def.name === 'DatabaseConnections') evidence.push(connectionsEvidence(recent, limits))
  if (def.alertFloor !== undefined && rising) {
    evidence.push(`Alert floor for this metric is ${formatMetricValue(def.alertFloor, def.unit)}`)
  }
  if (def.alertCeiling !== undefined && !rising) {
    evidence.push(`Alert level for this metric is ${formatMetricValue(def.alertCeiling, def.unit)}`)
  }

  const startedAt = onsetTimestamp(series, baseline, recent) ?? options.now

  return {
    id: `spike:${node.id}:${series.metricName}`,
    nodeId: node.id,
    severity,
    kind: 'metric-spike',
    title: `${node.name} ${def.label.toLowerCase()} ${direction} to ${observed}`,
    detail:
      `${def.label} ${direction} from a baseline of ${usual} to ${observed} over the sampled window. ` +
      'The baseline is the median of the preceding period, so an ongoing incident does not raise its own ' +
      'reference level.',
    metric: series.metricName,
    startedAt,
    endedAt: null,
    evidence,
    sparkline: sparkline(series),
    logGroups: node.logGroups,
  }
}

function formatRatio(ratio: number): string {
  if (ratio >= 1) return `${ratio.toFixed(1)}x`
  return `down to ${Math.round(ratio * 100)}% of baseline`
}

function scaleLabel(baseline: Baseline): string {
  switch (baseline.scaleSource) {
    case 'mad':
      return 'the median absolute deviation'
    case 'mean-absolute-deviation':
      return 'the mean absolute deviation (the median absolute deviation was zero)'
    case 'constant':
      return 'a constant baseline — there was no variation to measure'
  }
}

/**
 * A spike is `warning` unless it is far past the point of concern, or unless a
 * real limit discovered during the scan says the resource is close to it.
 */
function severityFor(
  def: MetricDef,
  recent: number,
  analysis: SpikeAnalysis,
  limits: ResourceLimits | undefined,
): Finding['severity'] {
  if (def.name === 'DatabaseConnections' && limits?.maxConnections) {
    if (recent / limits.maxConnections >= 0.85) return 'critical'
  }
  if (def.percent && def.higherIsWorse && recent >= 90) return 'critical'
  if (def.lowerIsWorse && def.alertCeiling !== undefined && recent <= def.alertCeiling / 2) {
    return 'critical'
  }
  if (analysis.z !== null && Math.abs(analysis.z) >= DEFAULT_Z_THRESHOLD * 2) return 'critical'
  return 'warning'
}

/**
 * The connection count only means something against max_connections. When that
 * could not be resolved the finding says so rather than quoting a percentage of
 * a number we guessed.
 */
function connectionsEvidence(recent: number, limits: ResourceLimits | undefined): string {
  if (limits?.maxConnections) {
    const percent = Math.round((recent / limits.maxConnections) * 100)
    return `${Math.round(recent).toLocaleString()} of ${limits.maxConnections.toLocaleString()} max_connections (${percent}%)`
  }
  const reason = limits?.maxConnectionsUnknown ?? 'max_connections was not read during this scan'
  return `Share of max_connections unknown — ${reason}`
}
