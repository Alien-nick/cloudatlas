import { z } from 'zod'
import {
  alarmSchema,
  collectorFailureSchema,
  findingSchema,
  graphSchema,
  missingPermissionSchema,
} from './graph.js'

export const profileSchema = z.object({
  name: z.string(),
  /** Region configured for the profile, when set. */
  region: z.string().nullable(),
  /** True when the profile is SSO-based (`sso_session` or `sso_start_url`). */
  sso: z.boolean(),
  source: z.enum(['config', 'credentials', 'both']),
})
export type Profile = z.infer<typeof profileSchema>

export const identitySchema = z.object({
  accountId: z.string(),
  accountAlias: z.string().nullable(),
  arn: z.string(),
  userId: z.string(),
  profile: z.string(),
})
export type Identity = z.infer<typeof identitySchema>

export const serverInfoSchema = z.object({
  provider: z.enum(['live', 'demo']),
  version: z.string(),
  /** True when ANTHROPIC_API_KEY is present. */
  agentReady: z.boolean(),
  model: z.string(),
  /** Cost Explorer column is hidden unless this is on. */
  costEnabled: z.boolean(),
  defaultRegions: z.array(z.string()),
  /** How often the UI should re-evaluate health, in seconds. */
  healthPollSeconds: z.number(),
  /** Milestones not yet built, surfaced so the UI can show honest empty states. */
  unimplemented: z.array(z.string()),
})
export type ServerInfo = z.infer<typeof serverInfoSchema>

export const scanRequestSchema = z.object({
  profile: z.string(),
  regions: z.array(z.string()).min(1),
  /** Ignore the cached scan and re-collect. */
  force: z.boolean().default(false),
})
export type ScanRequest = z.infer<typeof scanRequestSchema>

export const scanRegionStateSchema = z.enum(['queued', 'scanning', 'done', 'error'])
export type ScanRegionState = z.infer<typeof scanRegionStateSchema>

export const scanProgressSchema = z.object({
  region: z.string(),
  state: scanRegionStateSchema,
  /** 0..1 */
  progress: z.number(),
  /** Collector currently running, e.g. "rds". */
  step: z.string().nullable(),
  resourceCount: z.number(),
  error: z.string().nullable(),
})
export type ScanProgress = z.infer<typeof scanProgressSchema>

/** Server-sent events emitted on /api/scan/stream. */
export const scanEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('start'), regions: z.array(z.string()) }),
  z.object({ type: z.literal('progress'), progress: scanProgressSchema }),
  z.object({ type: z.literal('warning'), warning: missingPermissionSchema }),
  // Distinct from a warning on purpose: this one means "we do not know what
  // went wrong", and the UI must not present it as a permission problem.
  z.object({ type: z.literal('failure'), failure: collectorFailureSchema }),
  z.object({ type: z.literal('done'), graph: graphSchema }),
  z.object({ type: z.literal('error'), message: z.string() }),
])
export type ScanEvent = z.infer<typeof scanEventSchema>

export const scanIssuesSchema = z.object({
  missingPermissions: z.array(missingPermissionSchema),
  collectorFailures: z.array(collectorFailureSchema),
})
export type ScanIssues = z.infer<typeof scanIssuesSchema>

export const findingsResponseSchema = z.object({
  findings: z.array(findingSchema),
  /** Epoch ms of the last health poll. */
  evaluatedAt: z.number(),
  missingPermissions: z.array(missingPermissionSchema).default([]),
})
export type FindingsResponse = z.infer<typeof findingsResponseSchema>

export const alarmsResponseSchema = z.object({
  alarms: z.array(alarmSchema),
  missingPermissions: z.array(missingPermissionSchema).default([]),
})
export type AlarmsResponse = z.infer<typeof alarmsResponseSchema>

export const alarmHistoryItemSchema = z.object({
  timestamp: z.number(),
  summary: z.string(),
  state: z.string().nullable(),
})
export type AlarmHistoryItem = z.infer<typeof alarmHistoryItemSchema>

export const wafSampledRequestSchema = z.object({
  timestamp: z.number(),
  clientIp: z.string(),
  country: z.string(),
  uri: z.string(),
  method: z.string(),
  action: z.string(),
  ruleName: z.string(),
  /** Requests this sample represents. */
  weight: z.number(),
})
export type WafSampledRequest = z.infer<typeof wafSampledRequestSchema>

export const wafSampledRequestSchemaRequest = z.object({
  webAclNodeId: z.string(),
  ruleName: z.string().optional(),
  start: z.number(),
  end: z.number(),
})
export type WafSampledRequestsRequest = z.infer<typeof wafSampledRequestSchemaRequest>

export const wafSampledResponseSchema = z.object({
  requests: z.array(wafSampledRequestSchema),
  /** Aggregations the WAF view and the agent both use. */
  byRule: z.array(z.object({ key: z.string(), count: z.number() })).default([]),
  byClientIp: z.array(z.object({ key: z.string(), count: z.number() })).default([]),
  byCountry: z.array(z.object({ key: z.string(), count: z.number() })).default([]),
  byUri: z.array(z.object({ key: z.string(), count: z.number() })).default([]),
})
export type WafSampledResponse = z.infer<typeof wafSampledResponseSchema>

export const errorResponseSchema = z.object({
  error: z.string(),
  /** Set for AccessDenied so the UI can render a "missing permission" notice. */
  missingPermission: z.string().nullable().default(null),
  code: z.string().nullable().default(null),
})
export type ErrorResponse = z.infer<typeof errorResponseSchema>

const detectionSchema = z.object({
  /** Robust z-score above which a metric is considered anomalous. */
  /** Calibrated across a full daily cycle; see health/calibration.test.ts. */
  zScoreThreshold: z.number().default(3.5),
  /** Baseline window in minutes. */
  baselineMinutes: z.number().default(360),
  /** Evaluation window in minutes. */
  evaluationMinutes: z.number().default(15),
  /** Absolute floors that must also be crossed, keyed "Namespace/Metric". */
  floors: z.record(z.string(), z.number()).default({}),
  /** WAF blocked-rate multiple over baseline that counts as a surge. */
  wafSurgeMultiple: z.number().default(3),
  /** Share of blocks from one IP or rule that counts as domination. */
  wafDominanceRatio: z.number().default(0.5),
})
export type DetectionConfig = z.infer<typeof detectionSchema>

/** User-tunable thresholds, read from cloudatlas.config.json. */
export const configSchema = z.object({
  provider: z.enum(['live', 'demo']).default('demo'),
  defaultRegions: z.array(z.string()).default(['us-east-1']),
  /** Seconds between health evaluations. */
  healthPollSeconds: z.number().min(10).default(60),
  /** Seconds between automatic re-scans; 0 disables. */
  autoRefreshSeconds: z.number().min(0).default(0),
  /** Cost Explorer is billed per request, so it is opt-in. */
  enableCostExplorer: z.boolean().default(false),
  /** Replace account ids with a placeholder before sending to Anthropic. */
  redactAccountIds: z.boolean().default(false),
  detection: detectionSchema.default({
    zScoreThreshold: 3.5,
    baselineMinutes: 360,
    evaluationMinutes: 15,
    floors: {},
    wafSurgeMultiple: 3,
    wafDominanceRatio: 0.5,
  }),
})
export type CloudAtlasConfig = z.infer<typeof configSchema>
