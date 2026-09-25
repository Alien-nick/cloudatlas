/**
 * Robust statistics for spike detection.
 *
 * Mean and standard deviation are the obvious choice and the wrong one: the
 * spike we are trying to find is itself in the sample, and it drags both. A
 * metric that sits at 40% and jumps to 95% for ten minutes raises the mean and
 * inflates the standard deviation, so the spike scores as barely unusual
 * against a baseline it created. Median and MAD are unmoved by up to half the
 * sample, so the baseline stays the baseline.
 */

/** Consistency factor making MAD an estimator of sigma for normal data. */
const MAD_TO_SIGMA = 1.4826

/** Same, for the mean absolute deviation: sigma ≈ 1.2533 · MeanAD. */
const MEANAD_TO_SIGMA = 1.2533

/** Median of a non-empty list. Does not mutate the input. */
export function median(values: number[]): number {
  if (values.length === 0) return Number.NaN
  const sorted = [...values].sort((a, b) => a - b)
  const mid = sorted.length >> 1
  // biome-ignore lint/style/noNonNullAssertion: index is in range by construction
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2
}

/** Median absolute deviation from the median. */
export function medianAbsoluteDeviation(values: number[], center = median(values)): number {
  if (values.length === 0) return Number.NaN
  return median(values.map((value) => Math.abs(value - center)))
}

export function meanAbsoluteDeviation(values: number[], center = median(values)): number {
  if (values.length === 0) return Number.NaN
  const total = values.reduce((sum, value) => sum + Math.abs(value - center), 0)
  return total / values.length
}

export interface Baseline {
  center: number
  /** Robust estimate of the spread, already scaled to sigma. */
  scale: number
  /** How `scale` was obtained, for the evidence line. */
  scaleSource: 'mad' | 'mean-absolute-deviation' | 'constant'
  samples: number
}

/**
 * Summarise a baseline window.
 *
 * MAD is zero whenever more than half the window holds the same value, which is
 * not exotic — it is the normal state of StatusCheckFailed, Errors, Throttles,
 * and any metric that is usually flat. Dividing by it yields Infinity, which
 * would score every one-off blip as an infinitely significant spike. So a zero
 * MAD falls back to the mean absolute deviation, and a genuinely constant
 * window is reported as such rather than given a fabricated spread.
 */
export function summarizeBaseline(values: number[]): Baseline {
  const center = median(values)
  const mad = medianAbsoluteDeviation(values, center)
  if (mad > 0) {
    return { center, scale: mad * MAD_TO_SIGMA, scaleSource: 'mad', samples: values.length }
  }

  const meanAd = meanAbsoluteDeviation(values, center)
  if (meanAd > 0) {
    return {
      center,
      scale: meanAd * MEANAD_TO_SIGMA,
      scaleSource: 'mean-absolute-deviation',
      samples: values.length,
    }
  }

  return { center, scale: 0, scaleSource: 'constant', samples: values.length }
}

/**
 * Robust z-score, or null when the baseline has no spread to measure against.
 *
 * Null rather than Infinity is deliberate. A perfectly constant baseline gives
 * no statistical evidence at all: the honest statement is "this metric has
 * never moved before", which is a step change to be judged against an absolute
 * threshold, not a z-score to be compared with other z-scores.
 */
export function robustZScore(value: number, baseline: Baseline): number | null {
  if (baseline.scale <= 0 || !Number.isFinite(baseline.scale)) return null
  return (value - baseline.center) / baseline.scale
}

/** Multiple of the baseline, for the "14x" style evidence line. */
export function ratioToBaseline(value: number, center: number): number | null {
  if (center === 0 || !Number.isFinite(center)) return null
  return value / center
}
