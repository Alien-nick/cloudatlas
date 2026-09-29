import { z } from 'zod'

/**
 * Compliance: the scan measured against HIPAA, SOC 2 and PCI DSS.
 *
 * The unit of evaluation is a *check* — one configuration fact on one resource
 * ("this database is encrypted at rest"). A framework *control* is a named
 * requirement ("§164.312(a)(2)(iv) Encryption and decryption") that one or more
 * checks provide evidence for. Keeping the two apart is what lets one check
 * count toward several frameworks without being evaluated several times.
 *
 * What this is not: an attestation. Most of every framework is policy, process
 * and people, which no scan can see. Controls with no automated check are
 * reported as `not-assessed` rather than omitted, so a score never reads as
 * more coverage than it is.
 */

/**
 * Three regulatory frameworks, plus AWS Foundational Security Best Practices —
 * the per-resource benchmark Security Hub scores against, whose control ids
 * (EC2.8, RDS.3) are what an engineer searches for when fixing one.
 */
export const frameworkIdSchema = z.enum(['hipaa', 'soc2', 'pci-dss', 'aws-fsbp'])
export type FrameworkId = z.infer<typeof frameworkIdSchema>

/**
 * `unknown` means the fact the check needs was not collected — a denied call,
 * or a provider that does not report it. It is never folded into `pass`.
 */
export const checkStatusSchema = z.enum(['pass', 'fail', 'unknown'])
export type CheckStatus = z.infer<typeof checkStatusSchema>

export const complianceSeveritySchema = z.enum(['high', 'medium', 'low'])
export type ComplianceSeverity = z.infer<typeof complianceSeveritySchema>

export const checkCategorySchema = z.enum([
  'network',
  'encryption-at-rest',
  'encryption-in-transit',
  'logging',
  'resilience',
  'hardening',
])
export type CheckCategory = z.infer<typeof checkCategorySchema>

export const CHECK_CATEGORY_LABELS: Record<CheckCategory, string> = {
  network: 'Network exposure',
  'encryption-at-rest': 'Encryption at rest',
  'encryption-in-transit': 'Encryption in transit',
  logging: 'Logging & monitoring',
  resilience: 'Backup & resilience',
  hardening: 'Hardening',
}

export const complianceCheckSchema = z.object({
  id: z.string(),
  title: z.string(),
  category: checkCategorySchema,
  severity: complianceSeveritySchema,
  /** Why it matters, in terms of what an attacker or an outage can do. */
  rationale: z.string(),
  remediation: z.string(),
  /** Resource type labels the check runs against, for the "what was checked" list. */
  appliesTo: z.array(z.string()),
})
export type ComplianceCheck = z.infer<typeof complianceCheckSchema>

export const complianceControlSchema = z.object({
  /** Unique across frameworks, e.g. "hipaa:164.312(b)". */
  id: z.string(),
  framework: frameworkIdSchema,
  /** The citation as an auditor writes it, e.g. "§164.312(b)" or "CC6.6". */
  ref: z.string(),
  title: z.string(),
  /** Checks providing evidence. Empty means nothing here can assess it. */
  checkIds: z.array(z.string()),
  /**
   * What an automated scan cannot see for this control. Set on controls that
   * are only partly assessed as well as on those not assessed at all.
   */
  coverageNote: z.string().optional(),
})
export type ComplianceControl = z.infer<typeof complianceControlSchema>

export const complianceFrameworkSchema = z.object({
  id: frameworkIdSchema,
  name: z.string(),
  version: z.string(),
  description: z.string(),
  controls: z.array(complianceControlSchema),
})
export type ComplianceFramework = z.infer<typeof complianceFrameworkSchema>

/**
 * AWS CLI commands that fix one failing resource, for the user to review and
 * run themselves.
 *
 * CloudAtlas never executes these — it holds no write permission and its
 * client refuses any operation outside the read-only registry. They are text,
 * produced so the gap between "this is wrong" and "this is fixed" is one paste
 * rather than a trip through the documentation.
 */
export const fixSchema = z.object({
  /** In order, with this resource's identifiers, region and profile filled in. */
  commands: z.array(z.string()),
  /** What to know before running: downtime, cost, who loses access. */
  caution: z.string().nullable(),
  /**
   * True when a command holds a `<placeholder>` only the user can fill — a
   * log bucket, a web ACL, a CIDR — so it must not be pasted as-is.
   */
  needsInput: z.boolean(),
})
export type Fix = z.infer<typeof fixSchema>

export const complianceResultSchema = z.object({
  checkId: z.string(),
  nodeId: z.string(),
  status: checkStatusSchema,
  /** Observed facts, one per line, in the same style as a finding's evidence. */
  evidence: z.array(z.string()),
  /** Failing results only, and only for checks with a command-line fix. */
  fix: fixSchema.optional(),
})
export type ComplianceResult = z.infer<typeof complianceResultSchema>

/**
 * A VPC and everything it is accountable for.
 *
 * `nodeIds` are resources inside the VPC. `connectedNodeIds` are resources
 * outside any VPC that something inside it talks to — the bucket the tasks
 * write to, the distribution in front of the load balancer. Data does not stop
 * being regulated when it leaves the VPC boundary, so neither does the scope.
 *
 * The `outside-vpc` scope collects every resource outside a VPC, connected or
 * not, so nothing in the scan goes unassessed.
 */
export const complianceScopeSchema = z.object({
  id: z.string(),
  kind: z.enum(['vpc', 'outside-vpc']),
  name: z.string(),
  region: z.string(),
  cidr: z.string().nullable(),
  nodeIds: z.array(z.string()),
  connectedNodeIds: z.array(z.string()),
})
export type ComplianceScope = z.infer<typeof complianceScopeSchema>

export const complianceReportSchema = z.object({
  frameworks: z.array(complianceFrameworkSchema),
  checks: z.array(complianceCheckSchema),
  /** One per resource and applicable check, shared by every scope that holds the resource. */
  results: z.array(complianceResultSchema),
  scopes: z.array(complianceScopeSchema),
  /** Epoch ms of the scan this was evaluated against. */
  scannedAt: z.number(),
})
export type ComplianceReport = z.infer<typeof complianceReportSchema>

// ---------------------------------------------------------------------------
// Summaries — shared so the UI and the agent tell the same story.
// ---------------------------------------------------------------------------

/**
 * - `met`: every applicable result passed.
 * - `gap`: at least one resource failed.
 * - `unknown`: nothing failed, but at least one fact could not be read.
 * - `not-applicable`: the control has checks, but no resource in scope they apply to.
 * - `not-assessed`: no automated check exists for it; it needs a human.
 */
export type ControlStatus = 'met' | 'gap' | 'unknown' | 'not-applicable' | 'not-assessed'

export interface ControlSummary {
  control: ComplianceControl
  status: ControlStatus
  results: ComplianceResult[]
  failing: ComplianceResult[]
  unknown: ComplianceResult[]
  passing: number
}

export interface FrameworkScore {
  met: number
  gap: number
  unknown: number
  notApplicable: number
  notAssessed: number
  /**
   * Met as a share of the controls this scan could decide. Unknown counts
   * against it: a control we could not read has not been shown to be met.
   * Null when nothing was assessable.
   */
  percent: number | null
}

/** Resource ids a scope covers; null means every scope. */
export function scopeNodeIds(report: ComplianceReport, scopeId: string | null): Set<string> | null {
  if (scopeId === null) return null
  const scope = report.scopes.find((candidate) => candidate.id === scopeId)
  if (!scope) return new Set()
  return new Set([...scope.nodeIds, ...scope.connectedNodeIds])
}

export function resultsInScope(report: ComplianceReport, scopeId: string | null): ComplianceResult[] {
  const ids = scopeNodeIds(report, scopeId)
  return ids === null ? report.results : report.results.filter((result) => ids.has(result.nodeId))
}

function controlStatus(control: ComplianceControl, results: ComplianceResult[]): ControlStatus {
  if (control.checkIds.length === 0) return 'not-assessed'
  if (results.length === 0) return 'not-applicable'
  if (results.some((result) => result.status === 'fail')) return 'gap'
  if (results.some((result) => result.status === 'unknown')) return 'unknown'
  return 'met'
}

const STATUS_ORDER: Record<ControlStatus, number> = {
  gap: 0,
  unknown: 1,
  met: 2,
  'not-applicable': 3,
  'not-assessed': 4,
}

/** Every control of a framework, gaps first, for one scope or all of them. */
export function summarizeControls(
  report: ComplianceReport,
  frameworkId: FrameworkId,
  scopeId: string | null,
): ControlSummary[] {
  const framework = report.frameworks.find((candidate) => candidate.id === frameworkId)
  if (!framework) return []
  const inScope = resultsInScope(report, scopeId)

  return framework.controls
    .map((control) => {
      const checkIds = new Set(control.checkIds)
      const results = inScope.filter((result) => checkIds.has(result.checkId))
      return {
        control,
        status: controlStatus(control, results),
        results,
        failing: results.filter((result) => result.status === 'fail'),
        unknown: results.filter((result) => result.status === 'unknown'),
        passing: results.filter((result) => result.status === 'pass').length,
      }
    })
    .sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status])
}

export function scoreControls(summaries: ControlSummary[]): FrameworkScore {
  const count = (status: ControlStatus): number =>
    summaries.filter((summary) => summary.status === status).length
  const met = count('met')
  const gap = count('gap')
  const unknown = count('unknown')
  const decided = met + gap + unknown
  return {
    met,
    gap,
    unknown,
    notApplicable: count('not-applicable'),
    notAssessed: count('not-assessed'),
    percent: decided === 0 ? null : Math.round((met / decided) * 100),
  }
}

// ---------------------------------------------------------------------------
// Per-resource benchmark and recommendations
// ---------------------------------------------------------------------------

export interface ResultScore {
  pass: number
  fail: number
  unknown: number
  total: number
  /** Passing share of every check that ran; unknown counts against it. */
  percent: number | null
}

export function scoreResults(results: ComplianceResult[]): ResultScore {
  const pass = results.filter((result) => result.status === 'pass').length
  const fail = results.filter((result) => result.status === 'fail').length
  const unknown = results.length - pass - fail
  return {
    pass,
    fail,
    unknown,
    total: results.length,
    percent: results.length === 0 ? null : Math.round((pass / results.length) * 100),
  }
}

export interface ResourceBenchmark {
  nodeId: string
  results: ComplianceResult[]
  score: ResultScore
}

/** Every assessed resource in a scope, worst first. */
export function benchmarkResources(report: ComplianceReport, scopeId: string | null): ResourceBenchmark[] {
  const byNode = new Map<string, ComplianceResult[]>()
  for (const result of resultsInScope(report, scopeId)) {
    const list = byNode.get(result.nodeId)
    if (list) list.push(result)
    else byNode.set(result.nodeId, [result])
  }
  return [...byNode]
    .map(([nodeId, results]) => ({ nodeId, results, score: scoreResults(results) }))
    .sort(
      (a, b) =>
        b.score.fail - a.score.fail ||
        b.score.unknown - a.score.unknown ||
        (a.score.percent ?? 100) - (b.score.percent ?? 100) ||
        a.nodeId.localeCompare(b.nodeId),
    )
}

export interface Recommendation {
  check: ComplianceCheck
  failing: ComplianceResult[]
  /** Every control, across all frameworks, this fix provides evidence for. */
  controls: ComplianceControl[]
}

const SEVERITY_RANK: Record<ComplianceSeverity, number> = { high: 0, medium: 1, low: 2 }

/**
 * One recommendation per failing check, ranked by what fixing it is worth:
 * severity first, then how many resources it fixes, then how many controls
 * across frameworks it closes.
 */
export function recommendations(report: ComplianceReport, scopeId: string | null): Recommendation[] {
  const failingByCheck = new Map<string, ComplianceResult[]>()
  for (const result of resultsInScope(report, scopeId)) {
    if (result.status !== 'fail') continue
    const list = failingByCheck.get(result.checkId)
    if (list) list.push(result)
    else failingByCheck.set(result.checkId, [result])
  }
  const controls = report.frameworks.flatMap((framework) => framework.controls)

  return report.checks
    .filter((check) => failingByCheck.has(check.id))
    .map((check) => ({
      check,
      failing: failingByCheck.get(check.id) ?? [],
      controls: controls.filter((control) => control.checkIds.includes(check.id)),
    }))
    .sort(
      (a, b) =>
        SEVERITY_RANK[a.check.severity] - SEVERITY_RANK[b.check.severity] ||
        b.failing.length - a.failing.length ||
        b.controls.length - a.controls.length,
    )
}

/**
 * The report as seen by someone measuring against only some frameworks.
 *
 * A check none of the chosen frameworks require is dropped with its results,
 * rather than kept as a gap: an account with no card data has no PCI gap in
 * its default VPC, and showing one would bury the gaps that do apply.
 */
export function selectFrameworks(report: ComplianceReport, ids: readonly FrameworkId[]): ComplianceReport {
  const frameworks = report.frameworks.filter((framework) => ids.includes(framework.id))
  const required = new Set(frameworks.flatMap((framework) => framework.controls.flatMap((c) => c.checkIds)))
  return {
    ...report,
    frameworks,
    checks: report.checks.filter((check) => required.has(check.id)),
    results: report.results.filter((result) => required.has(result.checkId)),
  }
}
