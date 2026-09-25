export { applyHealth } from './apply.js'
export {
  detectImdsV1,
  detectPosture,
  detectPublicDatabase,
  detectUnencryptedStorage,
} from './posture.js'
export { detectSpikes, analyzeSeries, DEFAULT_Z_THRESHOLD, MIN_BASELINE_SAMPLES, RECENT_SAMPLES } from './spike.js'
export type { SpikeInput, SpikeOptions, SpikeAnalysis, ResourceLimits } from './spike.js'
export {
  median,
  medianAbsoluteDeviation,
  meanAbsoluteDeviation,
  summarizeBaseline,
  robustZScore,
  ratioToBaseline,
} from './robust.js'
export type { Baseline } from './robust.js'
export { runHealthPass, healthTargets, resolveLimits, BASELINE_WINDOW_MS } from './detect.js'
export type { HealthPassOptions, HealthPassResult } from './detect.js'
export { fetchAlarmHistory, toHistoryItem } from './alarm-history.js'
export type { AlarmHistoryOptions } from './alarm-history.js'
export { clampWindow, getWafSampled, tally, SAMPLE_RETENTION_MS } from './waf.js'
export type { SampledOptions, ClampedWindow } from './waf.js'
